import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backupDir, createBackup, inspectWorkspace, needsBackup } from "../src/backup.mjs";
import { makeRepo, sh, tempDir, write } from "./helpers.mjs";

const commit = (cwd, message) =>
  sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qam", message], cwd);

test("reports changes, unpushed commits and unmerged branches, then backs them up", (t) => {
  const root = tempDir(t);
  const repo = makeRepo(join(root, "demo"), { "a.txt": "a\n" });
  const ws = join(root, "ws");
  sh("git", ["worktree", "add", "-q", "-b", "feature", ws, "main"], repo);

  let state = inspectWorkspace({ repo, path: ws, branch: "feature", base: "main" });
  assert.deepEqual([state.changes, state.unpushed, state.merged], [[], [], true]);
  assert.equal(needsBackup(state), false);

  write(ws, { "a.txt": "a2\n" });
  commit(ws, "work");
  write(ws, { "a.txt": "a3\n", "new.txt": "n\n" });
  state = inspectWorkspace({ repo, path: ws, branch: "feature", base: "main" });
  assert.equal(state.changes.length, 2);
  assert.equal(state.unpushed.length, 1);
  assert.equal(state.merged, false);
  assert.equal(needsBackup(state), true);

  const dir = createBackup({ repo, path: ws, branch: "feature", base: "main", state, dir: backupDir(join(root, "backup"), "feature") });
  assert.match(readFileSync(join(dir, "changes.patch"), "utf8"), /a3/);
  assert.equal(readFileSync(join(dir, "untracked", "new.txt"), "utf8"), "n\n");
  assert.ok(existsSync(join(dir, "commits.bundle")));
  assert.match(sh("git", ["bundle", "list-heads", join(dir, "commits.bundle")], repo), /refs\/heads\/feature/);
  assert.notEqual(backupDir(join(root, "backup"), "feature"), dir, "a second backup gets its own folder");
});
