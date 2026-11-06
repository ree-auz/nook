import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/nk.mjs", import.meta.url));

export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nook-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  return dir;
}

export function sh(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A git repository with one commit holding `files`. Uses fake data only. */
export function makeRepo(dir, files = {}) {
  mkdirSync(dir, { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], dir);
  write(dir, { "README.md": "# demo\n", ...files });
  sh("git", ["add", "-A"], dir);
  sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], dir);
  return dir;
}

export function nk(args, { cwd, home, env = {} }) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NOOK_HOME: home, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", ...env },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });
  return { status: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr };
}
