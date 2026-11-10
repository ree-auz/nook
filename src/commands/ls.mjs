import { NookError } from "../errors.mjs";
import { baseRef, remoteUrl } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { localState } from "../status.mjs";
import { useColor } from "../ui.mjs";
import { branchOf, repoFromCwd, repoWorkspaces } from "../context.mjs";
import { exists, isInside } from "../home.mjs";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  "));
}

/** How many workspaces git reads at the same time: more gains little and loads the disk. */
const AT_ONCE = 6;

/** Runs `fn` on every item, at most `limit` at a time, keeping the order. */
async function each(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

/**
 * Every workspace with its local state and, when gh can tell, its PR.
 * GitHub is asked first and git reads the workspaces while it answers.
 * `prs: false` leaves GitHub out. `timing` is how long each took, in ms.
 */
export async function collect(ctx, { repo: repoFlag, prs: lookup = githubPrs } = {}) {
  const only = repoFlag ?? repoFromCwd(ctx);
  if (only && !ctx.config.repos[only]) throw new NookError(`Unknown repository "${only}"`);
  const repos = Object.entries(ctx.config.repos).filter(([name]) => !only || name === only);
  const started = Date.now();
  let ghDone = started;
  const asked = Promise.all(repos.map(([, repo]) => (lookup && remoteUrl(repo.path) ? lookup(repo.path, ctx.env) : { prs: null }))).then((result) => {
    ghDone = Date.now();
    return result;
  });
  const rows = repos.flatMap(([repoName, repo], i) => {
    const base = baseRef(repo.path, repo.default_branch);
    return repoWorkspaces(repoName, repo).map((item) => ({ ...item, branch: branchOf(item.name, item.ws), base, repoIndex: i }));
  });
  const local = await each(rows, AT_ONCE, (row) => localState(row.repo.path, row.ws.path, row.main ? null : row.branch, row.base));
  const gitDone = Date.now();
  const fetched = await asked;
  const problems = new Set();
  for (const { error } of fetched) if (error) problems.add(error);
  const items = rows.map(({ repoIndex, ...row }, i) => {
    const pr = row.main || !row.branch ? null : (fetched[repoIndex].prs?.get(row.branch) ?? null);
    return { ...row, changes: local[i].changes, commits: local[i].commits, pr };
  });
  return { items, problems: [...problems], timing: { git: gitDone - started, gh: lookup ? ghDone - started : null, total: Date.now() - started } };
}

const portsText = (ws) => (Number.isInteger(ws.port) ? `${ws.port}-${ws.port + 9}` : "-");

function changesText(n, path) {
  // No count: the folder is gone, or it is there and git cannot read it (a removal that stopped halfway).
  if (n === null) return exists(path) ? "unreadable" : "missing";
  return n ? `${n} changed` : "clean";
}

function commitsText(c) {
  if (!c) return "";
  return [c.ahead && `↑${c.ahead}`, c.behind && `↓${c.behind}`].filter(Boolean).join(" ");
}

function prText(pr) {
  if (!pr) return "";
  return `#${pr.number} ${pr.state}${pr.ci ? ` ${pr.ci}` : ""}`;
}

/** nk ls [--json] [--no-pr] [--timing] */
export async function listWorkspaces(ctx, { repo: repoFlag, json = false, prs, "no-pr": noPr = false, timing: showTiming = false } = {}) {
  const { items, problems, timing } = await collect(ctx, { repo: repoFlag, prs: noPr ? false : prs });
  // On stderr, so --json output stays as it is.
  const timed = () => showTiming && ctx.info(`Took ${timing.total} ms: git ${timing.git} ms${timing.gh === null ? "" : `, GitHub ${timing.gh} ms (at the same time)`}`);
  if (json) {
    const data = items.map(({ name, branch, repoName, ws, base, changes, commits, pr, main, managed }) => ({
      name,
      branch,
      main,
      managed,
      locked: Boolean(ws.locked),
      repo: repoName,
      path: ws.path,
      port: ws.port ?? null,
      base,
      changes,
      ahead: commits?.ahead ?? null,
      behind: commits?.behind ?? null,
      pr,
    }));
    ctx.print(JSON.stringify(data, null, 2));
    timed();
    return 0;
  }
  if (!items.length) {
    ctx.info("No repositories yet. Run nk init inside one");
    return 0;
  }
  // Gutter as in worktrunk: ^ main checkout, @ where you are, + another worktree.
  const mark = (item) => (isInside(ctx.cwd, item.ws.path) && !items.some((o) => o !== item && o.ws.path.length > item.ws.path.length && isInside(ctx.cwd, o.ws.path)) ? "@" : item.main ? "^" : "+");
  const rows = [["", "NAME", "REPO", "PORTS", "CHANGES", "BASE", "PR", "PATH"]];
  for (const item of items) {
    const name = item.ws.locked ? `${item.name} (locked)` : item.name;
    rows.push([mark(item), name, item.repoName, portsText(item.ws), changesText(item.changes, item.ws.path), commitsText(item.commits), prText(item.pr), item.ws.path]);
  }
  const lines = table(rows);
  // Merged rows are dimmed, as worktrunk does for branches that are safe to delete.
  const dim = useColor(ctx.out, ctx.env);
  items.forEach((item, i) => {
    if (dim && item.pr?.state === "merged") lines[i + 1] = `\x1b[2m${lines[i + 1]}\x1b[0m`;
  });
  ctx.print(lines.join("\n"));

  const workspaces = items.filter((item) => !item.main);
  const changed = workspaces.filter((item) => item.changes).length;
  const merged = workspaces.filter((item) => item.pr?.state === "merged").length;
  const outside = workspaces.filter((item) => !item.managed).length;
  const parts = [`Showing ${plural(workspaces.length, "workspace")} and the main checkout`];
  if (outside) parts.push(`${outside} made by other tools`);
  if (changed) parts.push(`${changed} with changes`);
  if (merged) parts.push(`${merged} merged (nk clean removes them)`);
  ctx.info(parts.join(", "));
  for (const problem of problems) ctx.warn(`No PR status: ${problem}`);
  timed();
  return 0;
}
