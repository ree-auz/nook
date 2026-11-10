// @ts-check
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exists } from "./home.mjs";
import { git, gitTry, refExists, statusLines } from "./git.mjs";
import { copyFile } from "./shared.mjs";

/** Commits on `branch` that are on no remote and not in the base branch. */
export function unpushedCommits(repo, branch, base) {
  if (!refExists(repo, `refs/heads/${branch}`)) return [];
  const args = ["rev-list", `refs/heads/${branch}`, "--not", "--remotes"];
  if (base && base !== branch) args.push(base);
  const result = gitTry(args, { cwd: repo });
  return result.ok && result.out ? result.out.split(/\r?\n/) : [];
}

export function isMerged(repo, branch, base) {
  if (!refExists(repo, `refs/heads/${branch}`)) return true;
  return gitTry(["merge-base", "--is-ancestor", `refs/heads/${branch}`, base], { cwd: repo }).ok;
}

/** What a removal would lose: uncommitted changes, unpushed commits, unmerged branch. */
export function inspectWorkspace({ repo, path, branch, base }) {
  const present = exists(path);
  return {
    present,
    changes: present ? statusLines(path) : [],
    unpushed: unpushedCommits(repo, branch, base),
    merged: isMerged(repo, branch, base),
  };
}

export function needsBackup(state) {
  return state.changes.length > 0 || state.unpushed.length > 0;
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function backupDir(backupRoot, name, date = new Date()) {
  let dir = join(backupRoot, `${name}-${stamp(date)}`);
  for (let n = 2; exists(dir); n++) dir = join(backupRoot, `${name}-${stamp(date)}-${n}`);
  return dir;
}

/**
 * Saves what removal would lose:
 *   changes.patch   tracked changes (staged and unstaged), apply with `git apply`
 *   untracked/      new files git does not ignore
 *   commits.bundle  unpushed commits, restore with `git fetch <bundle> <branch>`
 *   info.txt        workspace, branch, HEAD, time
 */
export function createBackup({ repo, path, branch, base, state, dir }) {
  mkdirSync(dir, { recursive: true });
  const info = [`workspace: ${branch}`, `path: ${path}`, `time: ${new Date().toISOString()}`];
  if (state.present) {
    const head = gitTry(["rev-parse", "HEAD"], { cwd: path });
    if (head.ok) info.push(`head: ${head.out}`);
    const diff = gitTry(["diff", "--binary", "HEAD"], { cwd: path });
    if (diff.ok && diff.out) writeFileSync(join(dir, "changes.patch"), diff.out + "\n");
    const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: path }).split("\0").filter(Boolean);
    for (const file of untracked) copyFile(join(path, file), join(dir, "untracked", file));
    if (untracked.length) info.push(`untracked files: ${untracked.length}`);
  }
  if (state.unpushed.length) {
    const args = ["bundle", "create", join(dir, "commits.bundle"), `refs/heads/${branch}`, "--not", "--remotes"];
    if (base && base !== branch) args.push(base);
    git(args, { cwd: repo });
    info.push(`unpushed commits: ${state.unpushed.length}`);
  }
  writeFileSync(join(dir, "info.txt"), info.join("\n") + "\n");
  return dir;
}
