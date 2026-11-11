import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { exists, isInside, samePath } from "../home.mjs";
import { gitTry, listWorktrees, remoteUrl } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { inspectWorkspace, isMerged } from "../backup.mjs";
import { describeOccupants, findOccupants, stopProcesses } from "../occupancy.mjs";
import { createPrompter } from "../prompt.mjs";
import { branchTip, contains } from "../status.mjs";
import { resolveRepo } from "../context.mjs";
import { collect } from "./ls.mjs";
import { deleteFolder, deleteWorkspace, ignoredData, unknownFile } from "./rm.mjs";
import { dockerCli, findComposeProjects, removeComposeProject } from "../compose.mjs";
import { hint } from "../ui.mjs";
import { approveHooks } from "./workspace.mjs";
import { findHook } from "../hooks.mjs";

const DAY = 24 * 60 * 60 * 1000;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortList = (entries, max) => `${entries.slice(0, max).join(", ")}${entries.length > max ? ` and ${entries.length - max} more` : ""}`;

/**
 * Why a workspace can go, or null. A merged PR counts when the local branch
 * has nothing the PR did not have (this covers squash merges). Without a PR,
 * a branch already in the base counts once the workspace is a day old, so a
 * fresh workspace that has no commits yet is kept (worktrunk's --min-age).
 */
export function mergedReason(item, now = Date.now()) {
  const { branch, repo, base, pr, ws } = item;
  if (pr?.state === "merged") {
    const tip = branchTip(repo.path, branch);
    if (!tip || (pr.head && contains(repo.path, pr.head, tip))) return { ok: `PR #${pr.number} merged` };
    return { skip: hint("not merged", `the branch has commits that are not in PR #${pr.number}`, `push them to a new PR, or nk rm ${item.name} (backs them up)`) };
  }
  if (pr) return null;
  const age = now - (ws.created ? Date.parse(ws.created) : createdAt(ws.path));
  if (!(age >= DAY)) return null;
  if (branchTip(repo.path, branch) && isMerged(repo.path, branch, base)) return { ok: `merged into ${base}` };
  return null;
}

/**
 * What nk clean does with one workspace from `collect`: null when its work is not
 * merged (clean does not mention it), { keep } with the reason it stays, or
 * { remove, ignored } with why it can go and the ignored files that go with it.
 * nk doctor --workspace shows the same answer.
 */
export function cleanVerdict(ctx, item, now = Date.now()) {
  if (item.main || !item.branch) return null;
  const reason = mergedReason(item, now);
  if (!reason) return null;
  if (item.ws.locked) return { keep: hint("locked", "nk clean and nk rm leave a locked worktree", `git worktree unlock ${item.ws.path}`) };
  if (reason.skip) return { keep: reason.skip };
  if (isInside(ctx.cwd, item.ws.path)) return { keep: hint("in use", "you are inside it", `cd ${item.repo.path}, then nk clean`) };
  if (item.changes) return { keep: hint("changed", plural(item.changes, "uncommitted change"), `commit them, or nk rm ${item.name} (backs them up)`) };
  // A folder git cannot read may hold changes nobody can count; unknown is not clean.
  if (item.changes === null && exists(item.ws.path))
    return { keep: hint("unknown", "git cannot read the folder, so nobody can count changes in it", `nk rm ${item.name} (repairs it first, or says what to do)`) };
  // Files git ignores (a local database, a test report) are not backed up. In a workspace Nook made
  // they are development data that goes with it. A worktree made elsewhere is left to nk rm, which lists them.
  const ignored = item.changes === null ? [] : ignoredData(item.ws.path, join(ctx.paths.shared, item.repoName));
  if (ignored.length && !item.managed)
    return { keep: hint("not made by nk", `its ignored data would be lost: ${shortList(ignored, 3)}`, `nk rm ${item.name} to remove anyway`) };
  return { remove: reason.ok, ignored };
}

/** When a folder was made, for worktrees Nook did not record; NaN when unknown. */
function createdAt(path) {
  try {
    const stat = statSync(path);
    return stat.birthtimeMs || stat.ctimeMs;
  } catch {
    return Number.NaN;
  }
}

/**
 * Folders in the repository's workspaces folder that are neither a workspace
 * nor a git worktree, as { path, unknown }. One that holds only what a project
 * rebuilds (unknown: null) is what a removal left halfway, such as node_modules
 * that Windows would not let go of. Any other file means nk cannot tell where
 * the folder came from; `unknown` names the first such file.
 */
export function leftoverFolders(ctx, repoName, repo) {
  const dir = join(ctx.paths.workspaces, repoName);
  if (!exists(dir)) return [];
  const worktrees = listWorktrees(repo.path);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !repo.workspaces[entry.name])
    .map((entry) => join(dir, entry.name))
    .filter((path) => !worktrees.some((w) => samePath(w.path, path)))
    .map((path) => ({ path, unknown: unknownFile(path) }));
}

/** nk clean [-n] [-y]: remove workspaces whose work is merged. */
export async function cleanWorkspaces(ctx, { repo: repoFlag, dryRun = false, yes = false, prs = githubPrs, scan = findOccupants, stop = stopProcesses, prompter = createPrompter(), now = Date.now(), docker = dockerCli } = {}) {
  const { name, repo } = resolveRepo(ctx, repoFlag);
  if (remoteUrl(repo.path)) {
    const fetched = gitTry(["fetch", "--quiet", "origin", repo.default_branch], { cwd: repo.path });
    if (!fetched.ok) ctx.warn(`Could not fetch origin/${repo.default_branch} for ${name}; using what is local`);
  }
  const { items, problems } = await collect(ctx, { repo: name, prs });
  for (const problem of problems) ctx.warn(hint("PR status unknown", `${problem}; only merges git can see count`, "nk doctor checks gh"));

  const remove = [];
  const skipped = [];
  // As nk rm does: when programs cannot be listed, say so once instead of reporting none.
  let unchecked = false;
  const programsIn = (path) => {
    const result = scan(path);
    if (result.unsupported && !unchecked) ctx.warn(`Could not check for running programs: ${result.unsupported}`);
    unchecked ||= Boolean(result.unsupported);
    return result.processes;
  };
  for (const item of items) {
    const verdict = cleanVerdict(ctx, item, now);
    if (!verdict) continue;
    const label = `${item.name} (${item.repoName})`;
    if (verdict.keep) skipped.push({ label, text: verdict.keep });
    else remove.push({ item, label, reason: verdict.remove, ignored: verdict.ignored, running: item.changes === null ? [] : programsIn(item.ws.path) });
  }

  const leftovers = [];
  for (const { path, unknown } of leftoverFolders(ctx, name, repo)) {
    // Being in the workspaces folder does not make a folder nk's to delete.
    if (unknown) skipped.push({ label: path, text: hint("unknown folder", `not a workspace, and it holds files nk does not know (${unknown})`, "delete it yourself when nothing in it is needed") });
    else if (isInside(ctx.cwd, path)) skipped.push({ label: path, text: hint("in use", "you are inside it", `cd ${repo.path}, then nk clean`) });
    else if (programsIn(path)?.length) skipped.push({ label: path, text: hint("in use", "programs are running in it", "close them, then nk clean") });
    else leftovers.push(path);
  }

  if (skipped.length) {
    ctx.warn(`Kept ${skipped.length}:`);
    // One line each, as the list of what goes: name, then state, reason and next command.
    const width = Math.max(...skipped.map((entry) => entry.label.length));
    for (const { label, text } of skipped) ctx.item(`${label.padEnd(width)}  ${text}`);
  }
  if (!remove.length && !leftovers.length) {
    ctx.info("Nothing to clean");
    return 0;
  }
  if (remove.length) {
    ctx.info(`${remove.length === 1 ? "1 workspace is" : `${remove.length} workspaces are`} merged:`);
    const width = Math.max(...remove.map((entry) => entry.label.length));
    for (const entry of remove) ctx.item(`${entry.label.padEnd(width)}  ${entry.reason}`);
  }
  const withData = remove.filter((entry) => entry.ignored.length);
  if (withData.length) {
    ctx.warn("Ignored data deleted with them, not backed up:");
    for (const entry of withData) ctx.item(`${entry.item.name}: ${shortList(entry.ignored, 5)}`);
  }
  if (leftovers.length) {
    ctx.info(`Left from earlier removals (not workspaces any more):`);
    for (const path of leftovers) ctx.item(path);
  }
  const running = remove.flatMap((entry) => entry.running);
  if (running.length) {
    // Same as nk rm: programs inside are listed, and stopped after one yes.
    ctx.warn(`${plural(running.length, "program")} running in them:`);
    for (const entry of remove) for (const p of entry.running) ctx.item(`${p.pid} ${p.name} (${entry.item.name})`);
  }
  if (dryRun) {
    ctx.info("Dry run; nothing was removed");
    return 0;
  }
  // Hook approval comes before anything is stopped or deleted.
  const repos = new Map(remove.map(({ item }) => [item.repoName, item]));
  for (const item of repos.values()) if (findHook(item.repo.path, "remove")) await approveHooks(ctx, item, prompter);
  if (!yes) {
    let ok;
    try {
      const count = remove.length + leftovers.length;
      const what = count === 1 ? "it" : `these ${count}`;
      ok = await prompter.confirm(running.length ? `Stop the programs and remove ${what}?` : `Remove ${what}?`, false);
    } catch {
      throw new NookError("Confirmation needs a terminal\nNext: nk clean -n to look, nk clean -y to remove without asking");
    }
    if (!ok) throw new NookError("Nothing was removed");
  }

  let failed = 0;
  for (const { item, running: inside } of remove) {
    const target = { repoName: item.repoName, repo: item.repo, name: item.name, ws: item.ws };
    const state = inspectWorkspace({ repo: item.repo.path, path: item.ws.path, branch: item.branch, base: item.base });
    try {
      if (inside.length) {
        await stop(inside);
        const left = scan(item.ws.path).processes;
        if (left.length) throw new NookError(`Could not stop:\n${describeOccupants(left)}`);
        ctx.ok(`Stopped ${plural(inside.length, "program")} in ${item.name}`);
      }
      await deleteWorkspace(ctx, target, { state, base: item.base, backupRoot: join(ctx.paths.backup, item.repoName), prompter, scan });
      ctx.ok(`Removed ${item.name}`);
    } catch (error) {
      if (!(error instanceof NookError)) throw error;
      failed++;
      ctx.warn(`${item.name} was not removed: ${error.message.split("\n").join("; ")}`);
    }
  }
  for (const path of leftovers) {
    try {
      // Compose projects started there go too, as nk rm does for a workspace.
      for (const project of findComposeProjects(path, docker).projects) removeComposeProject(project, docker);
      deleteFolder(path);
      ctx.ok(`Deleted ${path}`);
    } catch (error) {
      failed++;
      ctx.warn(`${path} was not deleted: ${error.message.split("\n").join("; ")}`);
    }
  }
  if (failed) throw new NookError(`${failed} of ${remove.length + leftovers.length} not removed; the messages above say why\nNext: fix what they name, then nk clean again`);
  return 0;
}
