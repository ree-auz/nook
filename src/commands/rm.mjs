import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { exists, isInside, samePath } from "../home.mjs";
import { baseRef, gitTry, listWorktrees, readableWorktree, remoteUrl, repairWorktree } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { findHook } from "../hooks.mjs";
import { backupDir, createBackup, inspectWorkspace, needsBackup } from "../backup.mjs";
import { describeOccupants, findOccupants, stopProcesses } from "../occupancy.mjs";
import { createPrompter } from "../prompt.mjs";
import { branchOf, resolveWorkspace } from "../context.mjs";
import { toName } from "../names.mjs";
import { approveHooks, hook } from "./workspace.mjs";
import { listFiles } from "../shared.mjs";
import { setupChanges } from "./check-hooks.mjs";
import { describeProject, dockerCli, findComposeProjects, removeComposeProject } from "../compose.mjs";

function occupants(ctx, path, scan) {
  const result = scan(path);
  if (result.unsupported) ctx.warn(`Could not check for running programs: ${result.unsupported}`);
  return result.processes;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Who may keep a folder from being deleted, as far as the scan can tell. It sees
 * working directories only, and not every process: a program started elsewhere
 * with a file open inside (an editor, an antivirus scan) is not found.
 */
function holders(path, scan) {
  const result = scan(path);
  const limits = [
    "the check sees working directories only, not open files",
    result.inaccessible ? `${result.inaccessible} process${result.inaccessible === 1 ? "" : "es"} could not be looked at` : "",
  ].filter(Boolean);
  if (result.unsupported) return `Could not check which programs use it: ${result.unsupported}`;
  if (result.processes.length) return `Running in it:\n${describeOccupants(result.processes)}\n(${limits.join("; ")})`;
  return `No program has it as its working directory; an editor, terminal or scanner may still hold a file open (${limits.join("; ")})`;
}

/**
 * Backs up what would be lost, runs the remove hook, deletes the folder and
 * the branch, and forgets the workspace. Programs must already be stopped.
 */
export async function deleteWorkspace(ctx, target, { state, base, backupRoot, prompter, scan = findOccupants, docker = dockerCli, remove = deleteFolder }) {
  const { repo, ws, name } = target;
  const branchName = branchOf(name, ws);
  // What is already done, for the message when a later step fails: a removal that stops halfway must say where it stands.
  const done = [];
  if (needsBackup(state)) {
    const dir = createBackup({ repo: repo.path, path: ws.path, branch: branchName, base, state, dir: backupDir(backupRoot, name) });
    ctx.ok(`Backed up changes to ${dir}`);
    done.push(`changes backed up to ${dir}`);
  }
  if (state.present) {
    try {
      await hook(ctx, target, "remove", { prompter });
    } catch (error) {
      if (error instanceof NookError) error.message += "\nStopped; nothing was deleted";
      throw error;
    }
    if (findHook(repo.path, "remove")) done.push("remove hook ran");
  }
  // What the workspace started with Docker Compose goes too, so no remove hook is needed for it.
  // Checked again after the hook, which may have removed some of it already.
  for (const project of findComposeProjects(ws.path, docker).projects) {
    try {
      removeComposeProject(project, docker);
    } catch (error) {
      throw new NookError(`${error.message}\nStopped; the folder was not deleted`);
    }
    ctx.ok(`Removed ${describeProject(project)}`);
    done.push(`${describeProject(project)} removed`);
  }
  if (state.present) {
    const after = occupants(ctx, ws.path, scan);
    if (after.length) throw new NookError(`Programs started running in ${ws.path}:\n${describeOccupants(after)}\nNothing was deleted`);
    // Changes are backed up by now, so the folder goes even when git cannot remove the worktree
    // (a damaged one, say); prune below then drops git's record of it.
    const removed = gitTry(["worktree", "remove", "--force", ws.path], { cwd: repo.path });
    if (!removed.ok) ctx.warn(`git worktree remove failed (${removed.err.split("\n")[0]}); deleting the folder instead`);
    // git can leave ignored folders behind on Windows (node_modules, .venv), even when it reports success.
    try {
      remove(ws.path);
    } catch (error) {
      if (!(error instanceof NookError)) throw error;
      if (removed.ok) done.push("git no longer lists the worktree");
      throw new NookError(`${error.message}\n${holders(ws.path, scan)}\n${done.length ? `Already done: ${done.join("; ")}. ` : ""}Not done: the folder${branchName ? `, branch ${branchName}` : ""} and nk's record are still there, so nk rm ${name} can finish the removal`);
    }
  }
  // Drop git's record of this worktree alone. A plain prune would also drop the record of every other
  // worktree git cannot reach, such as a half-removed one whose work is still in its folder.
  const listed = () => listWorktrees(repo.path).some((tree) => samePath(tree.path, ws.path));
  if (listed()) gitTry(["worktree", "remove", "--force", ws.path], { cwd: repo.path });
  if (listed()) gitTry(["worktree", "prune"], { cwd: repo.path });
  if (listed())
    throw new NookError(`git still lists ${ws.path} as a worktree. Run git worktree prune in ${repo.path}, then nk rm ${name} again`);
  if (branchName) {
    const branch = gitTry(["branch", "-D", branchName], { cwd: repo.path });
    if (!branch.ok && !/not found/i.test(branch.err)) ctx.warn(`Branch ${branchName} was kept: ${branch.err}`);
  }
  delete repo.workspaces[name];
  ctx.save();
}

// Folders a project rebuilds from its own files, and files nobody keeps: losing them loses nothing.
const REBUILT = new Set(["node_modules", ".venv", "venv", "vendor", "dist", "build", "out", "target", "coverage", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".gradle", ".tox", "_build", "deps", "tmp", "log", "logs", ".idea", ".vscode", ".DS_Store"]);

/** Ignored files and folders in a workspace that hold more than a rebuild or a shared copy: a local database, say. */
export function ignoredData(path, sharedDir) {
  const listed = gitTry(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], { cwd: path });
  if (!listed.ok) return [];
  const shared = new Set(listFiles(sharedDir));
  return listed.out
    .split(/\r?\n/)
    .filter((entry) => entry && !shared.has(entry) && !/\.(log|pyc)$/.test(entry) && !entry.split("/").some((part) => REBUILT.has(part)));
}

/**
 * The first file in a folder that is not something a project rebuilds, as a path
 * with "/", or null when the folder holds nothing else: what tells a folder a
 * removal left behind (node_modules, .venv) from one somebody put there.
 */
export function unknownFile(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (REBUILT.has(entry.name)) continue;
    const path = `${prefix}${entry.name}`;
    if (!entry.isDirectory()) return path;
    const inside = unknownFile(join(dir, entry.name), `${path}/`);
    if (inside) return inside;
  }
  return null;
}

/** Deletes a folder and everything in it, retrying while Windows still holds a file open. */
export function deleteFolder(path) {
  if (!exists(path)) return;
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    // A container that mounts the workspace and runs as root leaves files this user cannot delete.
    if (error.code === "EACCES" || (error.code === "EPERM" && process.platform !== "win32"))
      throw new NookError(`Could not delete ${path}: ${error.message}\nA container probably wrote these files as another user (often root). Delete the folder with sudo rm -rf, or have the remove hook delete them from inside the container`);
    throw new NookError(`Could not delete ${path}: ${error.message}\nClose what uses it and run the command again`);
  }
  if (exists(path)) throw new NookError(`Could not delete ${path}; close what uses it and run the command again`);
}

/** What removing one workspace involves, checked before anything changes. */
async function planRemoval(ctx, input, { repoFlag, scan, prs, docker, dryRun }) {
  const name = toName(input);
  const target = resolveWorkspace(ctx, name, repoFlag);
  const { repo, ws } = target;
  if (target.main) throw new NookError(`${ws.path} is the main checkout of ${target.repoName}; git cannot remove it`);
  if (ws.locked) throw new NookError(`${ws.path} is locked. Unlock it first: git worktree unlock ${ws.path}`);
  if (exists(ws.path) && isInside(ctx.cwd, ws.path))
    throw new NookError(`You are inside ${ws.path}. Change to another folder first, e.g. cd ${repo.path}`);

  if (exists(ws.path) && !readableWorktree(ws.path)) {
    // A removal that stopped halfway, or a tool that deleted the folder's .git: what is in the folder
    // cannot be checked or backed up until git reads it again, so nothing is deleted before that.
    const tree = listWorktrees(repo.path).find((item) => samePath(item.path, ws.path));
    if (!tree)
      throw new NookError(
        `${ws.path} is no longer a git worktree: git has no record of it, so nk cannot tell which files in it are work, or back them up.\nLook inside. When nothing in it is needed, delete the folder, then run nk rm ${target.name} again to drop its record${branchOf(target.name, ws) ? " and branch" : ""}`,
      );
    const why = tree.prunable ? ` (${tree.prunable})` : "";
    if (dryRun) {
      ctx.warn(`git cannot read ${ws.path}${why}. nk rm repairs the link to the repository first (git worktree repair), then checks and backs up what is inside`);
      return null;
    }
    if (!repairWorktree(repo.path, ws.path))
      throw new NookError(`git cannot read ${ws.path}${why}, and git worktree repair did not fix it.\nNothing was deleted. Look inside; when nothing in it is needed, delete the folder, then run nk rm ${target.name} again`);
    ctx.ok(`Repaired the link between ${ws.path} and the repository; its files were not touched`);
  }

  const base = baseRef(repo.path, repo.default_branch);
  const branchName = branchOf(target.name, ws);
  const state = inspectWorkspace({ repo: repo.path, path: ws.path, branch: branchName ?? "", base });
  const backupRoot = join(ctx.paths.backup, target.repoName);
  const removeHook = state.present ? findHook(repo.path, "remove") : null;

  ctx.info(`Removing ${target.name} @ ${ws.path}${state.present ? "" : " (folder already missing)"}${!branchName ? "" : branchName === target.name ? " and its branch" : ` and its branch ${branchName}`}`);
  if (removeHook) ctx.info(`Runs .nook/${removeHook.name} first`);
  const changed = setupChanges(repo).changes.filter((what) => what.startsWith(".nook/"));
  if (state.present && changed.length) ctx.warn(`${changed.join(", ")} changed since nk hooks test last passed; remove may leave things behind`);
  const compose = findComposeProjects(ws.path, docker);
  for (const project of compose.projects) ctx.info(`Removes ${describeProject(project)}`);
  for (const name of compose.shared) ctx.warn(`Compose project ${name} also has containers outside this workspace; it is kept`);
  if (compose.unavailable && compose.unavailable !== "not installed") ctx.warn(`Could not check for Docker containers: ${compose.unavailable}`);
  if (needsBackup(state)) ctx.info(`Backs up changes to ${backupRoot}`);
  const lost = state.present ? ignoredData(ws.path, join(ctx.paths.shared, target.repoName)) : [];
  if (lost.length) ctx.warn(`Deleted with the workspace, not backed up (git ignores them): ${lost.slice(0, 8).join(", ")}${lost.length > 8 ? ` and ${lost.length - 8} more` : ""}`);
  if (state.changes.length) {
    ctx.warn(`${plural(state.changes.length, "uncommitted change")}:`);
    for (const change of state.changes.slice(0, 10)) ctx.item(change);
    if (state.changes.length > 10) ctx.item(`... ${state.changes.length - 10} more`);
  }
  if (state.unpushed.length) ctx.warn(`${plural(state.unpushed.length, "commit")} not pushed`);
  if (branchName && !state.merged) {
    // A squash merge leaves the branch outside the base; the PR says whether it was merged.
    const pr = remoteUrl(repo.path) ? (await prs(repo.path, ctx.env)).prs?.get(branchName) : null;
    if (pr?.state === "merged") ctx.info(`PR #${pr.number} is merged`);
    else ctx.warn(`Branch ${branchName} is not merged into ${base}`);
  }
  const running = state.present ? occupants(ctx, ws.path, scan) : [];
  return { target, state, base, backupRoot, removeHook, running };
}

/** nk rm <name>... [-n] [-y]: checks every workspace first, asks once, then removes them in turn. */
export async function removeWorkspace(ctx, { name, names = [name], repo: repoFlag, dryRun = false, yes = false, scan = findOccupants, stop = stopProcesses, prompter = createPrompter(), prs = githubPrs, docker = dockerCli }) {
  const plans = [];
  for (const input of [...new Set(names.map(toName))]) {
    const plan = await planRemoval(ctx, input, { repoFlag, scan, prs, docker, dryRun });
    if (plan) plans.push(plan);
  }
  if (dryRun) {
    ctx.info("Dry run; nothing was removed");
    return 0;
  }

  const running = plans.flatMap((plan) => plan.running);
  if (running.length) {
    ctx.warn(`${plural(running.length, "program")} running in ${plans.length === 1 ? "the workspace" : "these workspaces"}:`);
    for (const item of running) ctx.item(`${item.pid} ${item.name}`);
  }
  // Hook approval comes before anything is stopped or deleted.
  const approved = new Set();
  for (const { target, removeHook } of plans)
    if (removeHook && !approved.has(target.repoName)) {
      approved.add(target.repoName);
      await approveHooks(ctx, target, prompter);
    }
  if (!yes) {
    const what = plans.map((plan) => plan.target.name).join(", ");
    const question = running.length ? `Stop ${running.length === 1 ? "it" : "them"} and remove ${what}?` : `Remove ${what}?`;
    let ok;
    try {
      ok = await prompter.confirm(question, false);
    } catch {
      throw new NookError("Confirmation needs a terminal; pass -y to remove without asking");
    }
    if (!ok) throw new NookError("Nothing was removed");
  }
  if (running.length) {
    await stop(running);
    const left = plans.flatMap((plan) => (plan.state.present ? occupants(ctx, plan.target.ws.path, scan) : []));
    if (left.length) throw new NookError(`Could not stop:\n${describeOccupants(left)}\nNothing was removed`);
    ctx.ok(`Stopped ${plural(running.length, "program")}`);
  }

  for (const { target, state, base, backupRoot } of plans) {
    await deleteWorkspace(ctx, target, { state, base, backupRoot, prompter, scan, docker });
    ctx.ok(`Removed ${target.name}`);
  }
  return 0;
}
