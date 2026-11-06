import { exists } from "./home.mjs";
import { gitTry, refExists } from "./git.mjs";

/** Uncommitted changes, or null when the folder is missing or not readable. */
export function changeCount(path) {
  if (!exists(path)) return null;
  const status = gitTry(["status", "--porcelain", "--untracked-files=normal"], { cwd: path });
  if (!status.ok) return null;
  return status.out ? status.out.split(/\r?\n/).length : 0;
}

/** Commits the branch has that `base` lacks (ahead), and the reverse (behind). */
export function aheadBehind(repo, branch, base) {
  if (!refExists(repo, `refs/heads/${branch}`)) return null;
  const result = gitTry(["rev-list", "--left-right", "--count", `${base}...refs/heads/${branch}`], { cwd: repo });
  if (!result.ok) return null;
  const [behind, ahead] = result.out.split(/\s+/).map(Number);
  return { ahead, behind };
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
