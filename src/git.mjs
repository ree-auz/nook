import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { NookError } from "./errors.mjs";

export function gitTry(args, { cwd, input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new NookError(`Cannot run git: ${result.error.message}`);
  return { ok: result.status === 0, status: result.status, out: result.stdout.trimEnd(), err: result.stderr.trim() };
}

export function git(args, options) {
  const result = gitTry(args, options);
  if (!result.ok) throw new NookError(`git ${args.join(" ")} failed: ${result.err || `exit ${result.status}`}`);
  return result.out;
}

/** Parses `git worktree list --porcelain`. The first entry is the main worktree. */
export function listWorktrees(repo) {
  const out = git(["worktree", "list", "--porcelain"], { cwd: repo });
  const items = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: resolve(line.slice(9)), branch: null, head: null, bare: false, locked: false };
      items.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "bare") current.bare = true;
    else if (current && (line === "locked" || line.startsWith("locked "))) current.locked = true;
  }
  return items;
}

/** The main worktree of the repository that contains `cwd`. */
export function mainWorktree(cwd) {
  const inside = gitTry(["rev-parse", "--is-inside-work-tree"], { cwd });
  if (!inside.ok || inside.out !== "true") throw new NookError("Not inside a git repository");
  const [main] = listWorktrees(cwd);
  if (!main || main.bare) throw new NookError("Bare repositories are not supported");
  return main.path;
}

export function remoteUrl(repo, remote = "origin") {
  const result = gitTry(["remote", "get-url", remote], { cwd: repo });
  return result.ok ? result.out : "";
}

export function refExists(repo, ref) {
  return gitTry(["show-ref", "--verify", "--quiet", ref], { cwd: repo }).ok;
}

export function defaultBranch(repo) {
  const head = gitTry(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
  if (head.ok && head.out) return head.out.replace(/^origin\//, "");
  const current = gitTry(["symbolic-ref", "--short", "HEAD"], { cwd: repo });
  if (current.ok && current.out) return current.out;
  return "main";
}

/** The ref new workspaces start from: origin/<default> when it exists, else <default>. */
export function baseRef(repo, branch) {
  return refExists(repo, `refs/remotes/origin/${branch}`) ? `origin/${branch}` : branch;
}

export function statusLines(path) {
  const out = git(["status", "--porcelain", "--untracked-files=all"], { cwd: path });
  return out ? out.split(/\r?\n/) : [];
}

/** Which of `paths` (relative to cwd) git ignores. */
export function ignoredPaths(cwd, paths) {
  if (!paths.length) return new Set();
  const result = gitTry(["check-ignore", "-z", "--stdin"], { cwd, input: paths.join("\0") + "\0" });
  if (!result.ok && result.status !== 1) throw new NookError(`git check-ignore failed: ${result.err}`);
  return new Set(result.out.split("\0").filter(Boolean));
}

export function isTracked(cwd, path) {
  return gitTry(["ls-files", "--error-unmatch", "--", path], { cwd }).ok;
}
