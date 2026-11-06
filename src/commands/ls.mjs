import { baseRef, remoteUrl } from "../git.mjs";
import { githubPrs } from "../forge.mjs";
import { aheadBehind, changeCount } from "../status.mjs";
import { useColor } from "../ui.mjs";
import { branchOf, repoWorkspaces } from "../context.mjs";
import { isInside } from "../home.mjs";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  "));
}

/** Every workspace with its local state and, when gh can tell, its PR. */
export async function collect(ctx, { repo: repoFlag, prs: lookup = githubPrs } = {}) {
  const repos = Object.entries(ctx.config.repos).filter(([name]) => !repoFlag || name === repoFlag);
  const fetched = await Promise.all(repos.map(([, repo]) => (remoteUrl(repo.path) ? lookup(repo.path, ctx.env) : { prs: null })));
  const items = [];
  const problems = new Set();
  repos.forEach(([repoName, repo], i) => {
    const { prs, error } = fetched[i];
    if (error) problems.add(error);
    const base = baseRef(repo.path, repo.default_branch);
    for (const item of repoWorkspaces(repoName, repo)) {
      const branch = branchOf(item.name, item.ws);
      const pr = item.main || !branch ? null : (prs?.get(branch) ?? null);
      const commits = item.main || !branch ? null : aheadBehind(repo.path, branch, base);
      items.push({ ...item, branch, base, changes: changeCount(item.ws.path), commits, pr });
    }
  });
  return { items, problems: [...problems] };
}

const portsText = (ws) => (Number.isInteger(ws.port) ? `${ws.port}-${ws.port + 9}` : "-");

function changesText(n) {
  if (n === null) return "missing";
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

/** nk ls [--json] */
export async function listWorkspaces(ctx, { repo: repoFlag, json = false, prs } = {}) {
  const { items, problems } = await collect(ctx, { repo: repoFlag, prs });
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
    rows.push([mark(item), name, item.repoName, portsText(item.ws), changesText(item.changes), commitsText(item.commits), prText(item.pr), item.ws.path]);
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
  return 0;
}
