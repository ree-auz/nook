import { rmSync } from "node:fs";
import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { exists, isInside } from "../home.mjs";
import { baseRef, gitTry, remoteUrl } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { findHook } from "../hooks.mjs";
import { backupDir, createBackup, inspectWorkspace, needsBackup } from "../backup.mjs";
import { describeOccupants, findOccupants, stopProcesses } from "../occupancy.mjs";
import { createPrompter } from "../prompt.mjs";
import { branchOf, resolveWorkspace } from "../context.mjs";
import { toName } from "../names.mjs";
import { hook } from "./workspace.mjs";

function occupants(ctx, path, scan) {
  const result = scan(path);
  if (result.unsupported) ctx.warn(`Could not check for running programs: ${result.unsupported}`);
  return result.processes;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Backs up what would be lost, runs the remove hook, deletes the folder and
 * the branch, and forgets the workspace. Programs must already be stopped.
 */
export async function deleteWorkspace(ctx, target, { state, base, backupRoot, prompter, scan = findOccupants }) {
  const { repo, ws, name } = target;
  const branchName = branchOf(name, ws);
  if (needsBackup(state)) {
    const dir = createBackup({ repo: repo.path, path: ws.path, branch: branchName, base, state, dir: backupDir(backupRoot, name) });
    ctx.ok(`Backed up changes to ${dir}`);
  }
  if (state.present) {
    try {
      await hook(ctx, target, "remove", { prompter });
    } catch (error) {
      if (error instanceof NookError) error.message += "\nStopped; nothing was deleted";
      throw error;
    }
    const after = occupants(ctx, ws.path, scan);
    if (after.length) throw new NookError(`Programs started running in ${ws.path}:\n${describeOccupants(after)}\nNothing was deleted`);
    const removed = gitTry(["worktree", "remove", "--force", ws.path], { cwd: repo.path });
    if (!removed.ok && exists(ws.path)) {
      try {
        rmSync(ws.path, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        throw new NookError(`Could not delete ${ws.path}: ${error.message}`);
      }
    }
  }
  gitTry(["worktree", "prune"], { cwd: repo.path });
  const branch = gitTry(["branch", "-D", branchName], { cwd: repo.path });
  if (!branch.ok && !/not found/i.test(branch.err)) ctx.warn(`Branch ${branchName} was kept: ${branch.err}`);
  delete repo.workspaces[name];
  ctx.save();
}

/** nk rm <name> [-n] [-y] */
export async function removeWorkspace(ctx, { name: input, repo: repoFlag, dryRun = false, yes = false, scan = findOccupants, stop = stopProcesses, prompter = createPrompter(), prs = githubPrs }) {
  const name = toName(input);
  const target = resolveWorkspace(ctx, name, repoFlag);
  const { repo, ws } = target;
  if (exists(ws.path) && isInside(ctx.cwd, ws.path))
    throw new NookError(`You are inside ${ws.path}. Change to another folder first, e.g. cd ${repo.path}`);

  const base = baseRef(repo.path, repo.default_branch);
  const branchName = branchOf(name, ws);
  const state = inspectWorkspace({ repo: repo.path, path: ws.path, branch: branchName, base });
  const backupRoot = join(ctx.paths.backup, target.repoName);
  const removeHook = state.present ? findHook(repo.path, "remove") : null;

  ctx.info(`Removing ${name} @ ${ws.path}${state.present ? "" : " (folder already missing)"} and its branch${branchName === name ? "" : ` ${branchName}`}`);
  if (removeHook) ctx.info(`Runs .nook/${removeHook.name} first`);
  if (needsBackup(state)) ctx.info(`Backs up changes to ${backupRoot}`);
  if (state.changes.length) {
    ctx.warn(`${plural(state.changes.length, "uncommitted change")}:`);
    for (const change of state.changes.slice(0, 10)) ctx.item(change);
    if (state.changes.length > 10) ctx.item(`... ${state.changes.length - 10} more`);
  }
  if (state.unpushed.length) ctx.warn(`${plural(state.unpushed.length, "commit")} not pushed`);
  if (!state.merged) {
    // A squash merge leaves the branch outside the base; the PR says whether it was merged.
    const pr = remoteUrl(repo.path) ? (await prs(repo.path, ctx.env)).prs?.get(branchName) : null;
    if (pr?.state === "merged") ctx.info(`PR #${pr.number} is merged`);
    else ctx.warn(`Branch ${branchName} is not merged into ${base}`);
  }
  if (dryRun) {
    ctx.info("Dry run; nothing was removed");
    return 0;
  }

  const running = state.present ? occupants(ctx, ws.path, scan) : [];
  if (running.length) {
    ctx.warn(`${plural(running.length, "program")} running in the workspace:`);
    for (const item of running) ctx.item(`${item.pid} ${item.name}`);
  }
  if (!yes) {
    const question = running.length ? `Stop ${running.length === 1 ? "it" : "them"} and remove ${name}?` : `Remove ${name}?`;
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
    const left = occupants(ctx, ws.path, scan);
    if (left.length) throw new NookError(`Could not stop:\n${describeOccupants(left)}\nNothing was removed`);
    ctx.ok(`Stopped ${plural(running.length, "program")}`);
  }

  await deleteWorkspace(ctx, target, { state, base, backupRoot, prompter, scan });
  ctx.ok(`Removed ${name}`);
  return 0;
}
