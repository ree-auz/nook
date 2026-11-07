import { existsSync, renameSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { loadConfig, saveConfig } from "./config.mjs";
import { NookError } from "./errors.mjs";
import { homePaths, isInside, nookHome, samePath } from "./home.mjs";
import { normalizeName } from "./names.mjs";
import { gitTry, listWorktrees } from "./git.mjs";
import { line, useColor } from "./ui.mjs";

/** Shared state for one command run. */
export function createContext({ env = process.env, cwd = process.cwd(), out = process.stdout, err = process.stderr } = {}) {
  const paths = homePaths(nookHome(env));
  const config = loadConfig(paths.config);
  moveOldWorkspaceFolder(paths, config);
  const color = useColor(err, env);
  const say = (kind) => (text) => err.write(`${line(kind, text, color)}\n`);
  return {
    env,
    cwd,
    paths,
    config,
    out,
    err,
    save() {
      saveConfig(paths.config, config);
    },
    print(text = "") {
      out.write(`${text}\n`);
    },
    note(text = "") {
      err.write(`${text}\n`);
    },
    step: say("step"),
    ok: say("ok"),
    warn: say("warn"),
    info: say("info"),
    item: say("item"),
  };
}

/**
 * Before 0.1 the folder was called "workspaces". Renames it once and tells git
 * where the workspaces went. When it cannot (a file is open on Windows), keeps
 * using the old folder.
 */
function moveOldWorkspaceFolder(paths, config) {
  const old = join(paths.home, "workspaces");
  if (!existsSync(old) || existsSync(paths.workspaces)) return;
  const moves = [];
  for (const repo of Object.values(config.repos ?? {}))
    for (const ws of Object.values(repo.workspaces ?? {}))
      if (isInside(ws.path, old)) moves.push({ repo, ws, path: join(paths.workspaces, relative(old, ws.path)) });
  try {
    renameSync(old, paths.workspaces);
  } catch {
    paths.workspaces = old;
    return;
  }
  for (const move of moves) move.ws.path = move.path;
  for (const repo of new Set(moves.map((move) => move.repo)))
    gitTry(["worktree", "repair", ...moves.filter((move) => move.repo === repo).map((move) => move.path)], { cwd: repo.path });
  if (moves.length) saveConfig(paths.config, config);
}

/** The registered repository `cwd` belongs to, or null. */
export function repoFromCwd(ctx) {
  for (const [name, repo] of Object.entries(ctx.config.repos)) {
    if (isInside(ctx.cwd, join(ctx.paths.workspaces, name))) return name;
    if (isInside(ctx.cwd, repo.path)) return name;
    for (const ws of Object.values(repo.workspaces)) if (isInside(ctx.cwd, ws.path)) return name;
  }
  const top = gitTry(["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
  if (top.ok) {
    try {
      const [main] = listWorktrees(ctx.cwd);
      for (const [name, repo] of Object.entries(ctx.config.repos)) if (main && isInside(main.path, repo.path)) return name;
    } catch {
      /* Not a usable repository. */
    }
  }
  return null;
}

function requireRepo(ctx, name) {
  const repo = ctx.config.repos[name];
  if (!repo) throw new NookError(`Unknown repository "${name}". Registered: ${Object.keys(ctx.config.repos).join(", ") || "none"}`);
  return { name, repo };
}

/**
 * The repository a command acts on: --repo, else the one the current folder
 * belongs to (its main checkout or one of its workspaces). Like git and
 * worktrunk, nothing is guessed outside a repository.
 */
export function resolveRepo(ctx, flag) {
  if (flag) return requireRepo(ctx, flag);
  const fromCwd = repoFromCwd(ctx);
  if (fromCwd) return requireRepo(ctx, fromCwd);
  if (!Object.keys(ctx.config.repos).length) throw new NookError("No repository yet. Run nk init inside a repository first");
  throw new NookError(
    `Not inside a registered repository. Run nk in the repository or one of its workspaces, or pass --repo (${Object.keys(ctx.config.repos).join(", ")})`,
  );
}

/**
 * Every worktree of a repository, as git lists them, joined with what Nook
 * recorded (port, creation time). Git is the source of truth, like worktrunk:
 * worktrees made by other tools show up too, without a port. The main
 * checkout comes first with `main: true`; workspaces Nook recorded whose
 * folder is gone come last.
 */
export function repoWorkspaces(repoName, repo) {
  let trees = [];
  try {
    trees = listWorktrees(repo.path);
  } catch {
    /* Not a usable repository; nk doctor reports it. */
  }
  const items = [];
  const recorded = new Set();
  const taken = new Set(Object.keys(repo.workspaces));
  trees.forEach((tree, index) => {
    if (tree.bare) return;
    const found = Object.entries(repo.workspaces).find(([, ws]) => samePath(ws.path, tree.path));
    if (found) {
      recorded.add(found[0]);
      items.push({ repoName, repo, name: found[0], ws: { ...found[1], locked: tree.locked }, main: false, managed: true });
      return;
    }
    let name = normalizeName(tree.branch ?? basename(tree.path));
    if (index > 0 && (!name || taken.has(name))) name = normalizeName(basename(tree.path));
    taken.add(name);
    const ws = { path: tree.path, branch: tree.branch, locked: tree.locked };
    items.push({ repoName, repo, name, ws, main: index === 0, managed: false });
  });
  for (const [name, ws] of Object.entries(repo.workspaces))
    if (!recorded.has(name)) items.push({ repoName, repo, name, ws, main: false, managed: true });
  return items;
}

/** An existing workspace of the current repository (or --repo) by name: its branch or folder name, converted the same way. */
export function resolveWorkspace(ctx, name, flag) {
  const { name: repoName, repo } = resolveRepo(ctx, flag);
  const items = repoWorkspaces(repoName, repo);
  const hit = items.find((item) => item.name === name) ?? items.find((item) => normalizeName(basename(item.ws.path)) === name);
  if (hit) return hit;
  throw new NookError(`No workspace named "${name}" in ${repoName}. Create it with: nk -b ${name}`);
}

/** The git branch of a workspace: its name, unless the branch had characters a name cannot use. */
export function branchOf(name, ws) {
  return "branch" in ws ? ws.branch : name;
}

/** Variables hooks and agents see. */
export function workspaceEnv(ctx, { repoName, repo, name, ws }) {
  return {
    ...ctx.env,
    NOOK_WORKSPACE: name,
    NOOK_PATH: ws.path,
    NOOK_REPO: repo.path,
    NOOK_SHARED: join(ctx.paths.shared, repoName),
    NOOK_PORT: String(ws.port ?? ""),
  };
}
