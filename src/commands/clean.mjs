import { statSync } from "node:fs";
import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { isInside } from "../home.mjs";
import { gitTry, remoteUrl } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { inspectWorkspace, isMerged } from "../backup.mjs";
import { describeOccupants, findOccupants, stopProcesses } from "../occupancy.mjs";
import { createPrompter } from "../prompt.mjs";
import { branchTip, contains } from "../status.mjs";
import { resolveRepo } from "../context.mjs";
import { collect } from "./ls.mjs";
import { deleteWorkspace } from "./rm.mjs";
import { approveHooks } from "./workspace.mjs";
import { findHook } from "../hooks.mjs";

const DAY = 24 * 60 * 60 * 1000;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
    return { skip: `has commits that are not in PR #${pr.number}` };
  }
  if (pr) return null;
  const age = now - (ws.created ? Date.parse(ws.created) : createdAt(ws.path));
  if (!(age >= DAY)) return null;
  if (branchTip(repo.path, branch) && isMerged(repo.path, branch, base)) return { ok: `merged into ${base}` };
  return null;
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

/** nk clean [-n] [-y]: remove workspaces whose work is merged. */
export async function cleanWorkspaces(ctx, { repo: repoFlag, dryRun = false, yes = false, prs = githubPrs, scan = findOccupants, stop = stopProcesses, prompter = createPrompter(), now = Date.now() } = {}) {
  const { name, repo } = resolveRepo(ctx, repoFlag);
  if (remoteUrl(repo.path)) {
    const fetched = gitTry(["fetch", "--quiet", "origin", repo.default_branch], { cwd: repo.path });
    if (!fetched.ok) ctx.warn(`Could not fetch origin/${repo.default_branch} for ${name}; using what is local`);
  }
  const { items, problems } = await collect(ctx, { repo: name, prs });
  for (const problem of problems) ctx.warn(`Only checks merges in git: ${problem}`);

  const remove = [];
  const skipped = [];
  for (const item of items) {
    if (item.main || !item.branch) continue;
    const reason = mergedReason(item, now);
    if (!reason) continue;
    const label = `${item.name} (${item.repoName})`;
    if (item.ws.locked) skipped.push(`${label}: locked (git worktree unlock to allow)`);
    else if (reason.skip) skipped.push(`${label}: ${reason.skip}`);
    else if (isInside(ctx.cwd, item.ws.path)) skipped.push(`${label}: you are inside it`);
    else if (item.changes) skipped.push(`${label}: ${plural(item.changes, "uncommitted change")}`);
    else remove.push({ item, label, reason: reason.ok, running: item.changes === null ? [] : scan(item.ws.path).processes });
  }

  if (skipped.length) {
    ctx.warn(`Kept ${skipped.length}:`);
    for (const text of skipped) ctx.item(text);
  }
  if (!remove.length) {
    ctx.info("Nothing to clean");
    return 0;
  }
  ctx.info(`${remove.length === 1 ? "1 workspace is" : `${remove.length} workspaces are`} merged:`);
  const width = Math.max(...remove.map((entry) => entry.label.length));
  for (const entry of remove) ctx.item(`${entry.label.padEnd(width)}  ${entry.reason}`);
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
      const what = remove.length === 1 ? "it" : `these ${remove.length}`;
      ok = await prompter.confirm(running.length ? `Stop the programs and remove ${what}?` : `Remove ${what}?`, false);
    } catch {
      throw new NookError("Confirmation needs a terminal; pass -y to remove without asking");
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
  if (failed) throw new NookError(`${failed} of ${remove.length} not removed; see the messages above`);
  return 0;
}
