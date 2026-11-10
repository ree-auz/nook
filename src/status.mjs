// @ts-check
import { exists } from "./home.mjs";
import { gitRun, gitTry } from "./git.mjs";

const AHEAD_BEHIND = (base, branch) => ["rev-list", "--left-right", "--count", `${base}...refs/heads/${branch}`];

function counts(result) {
  if (!result.ok) return null;
  const [behind, ahead] = result.out.split(/\s+/).map(Number);
  return Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead, behind } : null;
}

/**
 * What nk ls shows of a workspace from git alone, read without blocking so
 * that several workspaces are read at the same time.
 * changes: uncommitted changes, or null when the folder is missing or not readable.
 * commits: what the branch has that `base` lacks (ahead) and the reverse (behind);
 * null without a branch, or when the branch does not exist.
 */
export async function localState(repo, path, branch, base) {
  const [status, commits] = await Promise.all([
    exists(path) ? gitRun(["status", "--porcelain", "--untracked-files=normal"], { cwd: path }) : null,
    branch ? gitRun(AHEAD_BEHIND(base, branch), { cwd: repo }) : null,
  ]);
  const changes = status?.ok ? (status.out ? status.out.split(/\r?\n/).length : 0) : null;
  return { changes, commits: commits ? counts(commits) : null };
}

export function branchTip(repo, branch) {
  const result = gitTry(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo });
  return result.ok ? result.out : null;
}

/** True when `commit` is `other` or one of its ancestors (false when either is unknown). */
export function contains(repo, other, commit) {
  if (commit === other) return true;
  return gitTry(["merge-base", "--is-ancestor", commit, other], { cwd: repo }).ok;
}
