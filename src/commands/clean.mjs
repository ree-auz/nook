import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { isInside } from "../home.mjs";
import { gitTry, remoteUrl } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { inspectWorkspace, isMerged } from "../backup.mjs";
import { findOccupants } from "../occupancy.mjs";
import { createPrompter } from "../prompt.mjs";
import { branchTip, contains } from "../status.mjs";
import { collect } from "./ls.mjs";
import { deleteWorkspace } from "./rm.mjs";

const DAY = 24 * 60 * 60 * 1000;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Why a workspace can go, or null. A merged PR counts when the local branch
 * has nothing the PR did not have (this covers squash merges). Without a PR,
 * a branch already in the base counts once the workspace is a day old, so a
 * fresh workspace that has no commits yet is kept (worktrunk's --min-age).
 */
export function mergedReason(item, now = Date.now()) {
  const { name, repo, base, pr, ws } = item;
  if (pr?.state === "merged") {
    const tip = branchTip(repo.path, name);
    if (!tip || (pr.head && contains(repo.path, pr.head, tip))) return { ok: `PR #${pr.number} merged` };
    return { skip: `has commits that are not in PR #${pr.number}` };
  }
  if (pr) return null;
  const age = now - Date.parse(ws.created ?? "");
  if (!(age >= DAY)) return null;
  if (branchTip(repo.path, name) && isMerged(repo.path, name, base)) return { ok: `merged into ${base}` };
  return null;
}

/** nk clean [-n] [-y]: remove workspaces whose work is merged. */
export async function cleanWorkspaces(ctx, { repo: repoFlag, dryRun = false, yes = false, prs = githubPrs, scan = findOccupants, prompter = createPrompter(), now = Date.now() } = {}) {
  if (repoFlag && !ctx.config.repos[repoFlag]) throw new NookError(`Unknown repository "${repoFlag}"`);
  for (const [name, repo] of Object.entries(ctx.config.repos)) {
    if ((repoFlag && name !== repoFlag) || !Object.keys(repo.workspaces).length || !remoteUrl(repo.path)) continue;
    const fetched = gitTry(["fetch", "--quiet", "origin", repo.default_branch], { cwd: repo.path });
    if (!fetched.ok) ctx.warn(`Could not fetch origin/${repo.default_branch} for ${name}; using what is local`);
  }
  const { items, problems } = await collect(ctx, { repo: repoFlag, prs });
  for (const problem of problems) ctx.warn(`Only checks merges in git: ${problem}`);

  const remove = [];
  const skipped = [];
  for (const item of items) {
    const reason = mergedReason(item, now);
    if (!reason) continue;
    const label = `${item.name} (${item.repoName})`;
    if (reason.skip) skipped.push(`${label}: ${reason.skip}`);
    else if (isInside(ctx.cwd, item.ws.path)) skipped.push(`${label}: you are inside it`);
    else if (item.changes) skipped.push(`${label}: ${plural(item.changes, "uncommitted change")}`);
    else {
      const running = item.changes === null ? [] : scan(item.ws.path).processes;
      if (running.length) skipped.push(`${label}: ${plural(running.length, "program")} running (nk rm ${item.name} stops them)`);
      else remove.push({ item, label, reason: reason.ok });
    }
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
  if (dryRun) {
    ctx.info("Dry run; nothing was removed");
    return 0;
  }
  if (!yes) {
    let ok;
    try {
      ok = await prompter.confirm(`Remove ${remove.length === 1 ? "it" : `these ${remove.length}`}?`, false);
    } catch {
      throw new NookError("Confirmation needs a terminal; pass -y to remove without asking");
    }
    if (!ok) throw new NookError("Nothing was removed");
  }

  let failed = 0;
  for (const { item } of remove) {
    const target = { repoName: item.repoName, repo: item.repo, name: item.name, ws: item.ws };
    const state = inspectWorkspace({ repo: item.repo.path, path: item.ws.path, branch: item.name, base: item.base });
    try {
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
