import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.mjs";
import { NookError } from "./errors.mjs";
import { homePaths, isInside, nookHome } from "./home.mjs";
import { gitTry, listWorktrees } from "./git.mjs";
import { line, useColor } from "./ui.mjs";

/** Shared state for one command run. */
export function createContext({ env = process.env, cwd = process.cwd(), out = process.stdout, err = process.stderr } = {}) {
  const paths = homePaths(nookHome(env));
  const config = loadConfig(paths.config);
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

/** Repository for creating a workspace: --repo, then the current folder, then the only one. */
export function resolveRepo(ctx, flag) {
  if (flag) return requireRepo(ctx, flag);
  const fromCwd = repoFromCwd(ctx);
  if (fromCwd) return requireRepo(ctx, fromCwd);
  const names = Object.keys(ctx.config.repos);
  if (names.length === 1) return requireRepo(ctx, names[0]);
  if (!names.length) throw new NookError("No repository yet. Run nk init inside a repository first");
  throw new NookError(`Several repositories are registered (${names.join(", ")}); run nk inside one or pass --repo`);
}

/** An existing workspace by name. */
export function resolveWorkspace(ctx, name, flag) {
  const candidates = [];
  const preferred = flag ?? repoFromCwd(ctx);
  for (const [repoName, repo] of Object.entries(ctx.config.repos)) {
    if (flag && repoName !== flag) continue;
    const ws = repo.workspaces[name];
    if (ws) candidates.push({ repoName, repo, name, ws });
  }
  if (flag) requireRepo(ctx, flag);
  const pick = candidates.find((c) => c.repoName === preferred) ?? (candidates.length === 1 ? candidates[0] : null);
  if (pick) return pick;
  if (!candidates.length) throw new NookError(`No workspace named "${name}". Create it with: nk -b ${name}`);
  throw new NookError(`"${name}" exists in ${candidates.map((c) => c.repoName).join(", ")}; pass --repo`);
}

/** The git branch of a workspace: its name, unless the branch had characters a name cannot use. */
export function branchOf(name, ws) {
  return ws.branch ?? name;
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
