import { join } from "node:path";
import { exists, samePath } from "../home.mjs";
import { listWorktrees, readableWorktree } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { unpushedCommits } from "../backup.mjs";
import { findOccupants } from "../occupancy.mjs";
import { describeProject, dockerCli, findComposeProjects } from "../compose.mjs";
import { findHook } from "../hooks.mjs";
import { line, useColor } from "../ui.mjs";
import { resolveWorkspace } from "../context.mjs";
import { toName } from "../names.mjs";
import { collect } from "./ls.mjs";
import { cleanVerdict } from "./clean.mjs";
import { ignoredData } from "./rm.mjs";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortList = (entries, max) => `${entries.slice(0, max).join(", ")}${entries.length > max ? ` and ${entries.length - max} more` : ""}`;

/**
 * nk doctor --workspace <name>: everything nk rm and nk clean look at for one
 * workspace, and what nk clean would do with it and why. Reads only: nothing is
 * repaired, stopped or deleted. Exit 1 when something is broken.
 */
export async function doctorWorkspace(ctx, { name: input, repo: repoFlag, prs = githubPrs, scan = findOccupants, docker = dockerCli, now = Date.now() } = {}) {
  let broken = 0;
  const color = useColor(ctx.out, ctx.env);
  const ok = (text) => ctx.print(`  ${line("ok", text, color)}`);
  const warn = (text) => ctx.print(`  ${line("warn", text, color)}`);
  const bad = (text) => {
    broken++;
    ctx.print(`  ${line("fail", text, color)}`);
  };

  const target = resolveWorkspace(ctx, toName(input), repoFlag);
  const { items, problems } = await collect(ctx, { repo: target.repoName, prs });
  const item = items.find((entry) => samePath(entry.ws.path, target.ws.path)) ?? { ...target, branch: null, changes: null, commits: null, pr: null };
  const { repo, ws } = item;
  const next = [];
  ctx.print(`Workspace ${item.name} (${item.repoName})${item.main ? ", the main checkout" : ""}`);

  // Folder and git's record of it.
  const present = exists(ws.path);
  const tree = listWorktrees(repo.path).find((entry) => samePath(entry.path, ws.path));
  const readable = present && readableWorktree(ws.path);
  if (!present) {
    bad(`folder ${ws.path} is missing`);
    next.push(`nk rm ${item.name} drops its record${item.branch ? " and branch" : ""}`);
  } else if (!tree) {
    bad(`folder ${ws.path} is no longer a git worktree: git has no record of it, so nk cannot check or back up what is in it`);
    next.push(`look inside; delete the folder when nothing in it is needed, then nk rm ${item.name}`);
  } else if (!readable) {
    bad(`git cannot read ${ws.path}${tree.prunable ? ` (${tree.prunable})` : ""}; often what a removal that stopped halfway leaves`);
    next.push(`nk rm ${item.name} repairs the link first, then backs up and removes it; to keep the workspace: git worktree repair ${ws.path}`);
  } else ok(`folder ${ws.path}`);
  if (!item.main) (item.managed ? ok : warn)(item.managed ? "made by nk" : "not made by nk (another tool, or git worktree add): nk clean keeps it when it holds ignored data");
  if (ws.locked) {
    warn("locked: nk rm and nk clean leave a locked worktree");
    next.push(`git worktree unlock ${ws.path} allows removing it`);
  }

  // Work that a removal must not lose.
  if (readable) {
    if (item.changes === null) warn("changes: unknown, git could not count them");
    else if (item.changes) warn(`changes: ${plural(item.changes, "uncommitted change")} (nk rm backs them up; nk clean keeps the workspace)`);
    else ok("changes: none");
  }
  if (item.branch && !item.main) {
    ok(`branch ${item.branch}${item.commits ? `, ${item.commits.ahead} ahead of ${item.base} and ${item.commits.behind} behind` : ""}`);
    const unpushed = unpushedCommits(repo.path, item.branch, item.base);
    if (unpushed.length) warn(`${plural(unpushed.length, "commit")} not pushed (nk rm backs them up)`);
    for (const problem of problems) warn(`PR status unknown: ${problem}; only merges git can see count`);
    if (problems.length) next.push("nk doctor checks gh");
    if (item.pr) ok(`PR #${item.pr.number} ${item.pr.state}${item.pr.ci ? `, CI ${item.pr.ci}` : ""}`);
  } else if (!item.main && present && tree) warn("no branch (detached HEAD): nk clean leaves it");

  if (readable && !item.main) {
    // What stops or goes with the workspace.
    const occupied = scan(ws.path);
    if (occupied.unsupported) warn(`programs: could not check (${occupied.unsupported})`);
    else if (occupied.processes.length) {
      warn(`programs: ${plural(occupied.processes.length, "program")} running in it; nk rm and nk clean stop them after you confirm`);
      for (const p of occupied.processes) ctx.print(`  ${line("item", `${p.pid} ${p.name}`, color)}`);
    } else {
      // Only working directories are checked, and other users' processes cannot be looked at:
      // a program started elsewhere can still hold a file open.
      const unseen = occupied.inaccessible ? `; ${`${occupied.inaccessible} process${occupied.inaccessible === 1 ? "" : "es"}`} of other users could not be looked at` : "";
      ok(`programs: none running in it (by working directory${unseen})`);
    }

    const compose = findComposeProjects(ws.path, docker);
    if (compose.unavailable === "not installed") ok("Compose: docker is not installed, nothing to remove");
    else if (compose.unavailable) warn(`Compose: could not check (${compose.unavailable}); nk rm removes no containers it cannot see`);
    else if (!compose.projects.length && !compose.shared.length) ok("Compose: no project started here");
    for (const project of compose.projects) ok(`${describeProject(project)}; it belongs to this workspace alone and is removed with it`);
    for (const shared of compose.shared) warn(`Compose project ${shared} is shared: it also has containers outside this workspace, so it is kept`);

    const ignored = ignoredData(ws.path, join(ctx.paths.shared, item.repoName));
    if (ignored.length) warn(`ignored data deleted with the workspace, not backed up: ${shortList(ignored, 8)}`);
    else ok("ignored data: none besides shared copies and what the project rebuilds");
    const removeHook = findHook(repo.path, "remove");
    if (removeHook) ok(`remove hook .nook/${removeHook.name} runs first (see nk hooks)`);
  }

  // The answer nk clean would give, from the same check it runs.
  if (!item.main) {
    const verdict = cleanVerdict(ctx, item, now);
    if (!verdict) ctx.print(`nk clean leaves it: ${!item.branch ? "it has no branch" : item.pr ? `PR #${item.pr.number} is ${item.pr.state}` : "its branch is not merged, or it is less than a day old with no pull request"}`);
    else if (verdict.keep) ctx.print(`nk clean keeps it, ${verdict.keep}`);
    else ctx.print(`nk clean removes it: ${verdict.remove}`);
  }
  for (const step of next) ctx.print(`Next: ${step}`);
  return broken ? 1 : 0;
}
