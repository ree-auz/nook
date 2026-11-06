#!/usr/bin/env node
// Opens a Linear issue in a Nook workspace, in a new terminal tab.
// Linear runs this file through ~/.linear/coding-tools.json
// (Work on issue -> Custom script). See README.md next to it.
//
//   node open-issue.mjs [agent]              started by Linear (no window)
//   node open-issue.mjs --run <file> ...     inside the new tab
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "../../src/names.mjs";

const self = fileURLToPath(import.meta.url);
const nk = fileURLToPath(new URL("../../bin/nk.mjs", import.meta.url));

/**
 * Puts this Node's folder first on PATH. With a version manager such as fnm
 * or nvm, Linear starts without the shell setup that adds it, and global npm
 * commands (the agent, pnpm for hooks) live next to node.exe.
 */
function withNodeOnPath(env = process.env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: [dirname(process.execPath), env[key]].filter(Boolean).join(delimiter) };
}

/** Runs nk with this Node, so the prompt never passes through cmd.exe. */
function runNk(args, opts = {}) {
  return spawnSync(process.execPath, [nk, ...args], { stdio: "inherit", env: withNodeOnPath(), ...opts });
}

function insideTab([file, branch, agent]) {
  const prompt = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  const listed = spawnSync(process.execPath, [nk, "ls", "--json"], { encoding: "utf8", env: withNodeOnPath() });
  const existing = listed.status === 0 ? JSON.parse(listed.stdout).find((ws) => !ws.main && (ws.branch === branch || ws.name === normalizeName(branch))) : null;
  // Clicked again for the same issue: reopen the workspace without restarting the task.
  const result = existing ? runNk([existing.name, agent]) : runNk(["-b", branch, agent, "-p", prompt]);
  process.exitCode = result.status ?? 1;
}

function fromLinear(agent = "codex") {
  const { LINEAR_ISSUE_BRANCH_NAME: branch, LINEAR_WORK_DIR: dir, LINEAR_ISSUE_IDENTIFIER: id = "issue", LINEAR_PROMPT: prompt = "" } = process.env;
  if (!branch || !dir) throw new Error("LINEAR_ISSUE_BRANCH_NAME and LINEAR_WORK_DIR are missing; list them under env in coding-tools.json");
  if (process.platform !== "win32") throw new Error("Only Windows Terminal is supported so far");
  // The prompt is long Markdown with quotes and semicolons, so it travels in a file.
  const file = join(tmpdir(), `nk-linear-${id}-${process.pid}.md`);
  writeFileSync(file, prompt);
  const inner = [process.execPath, self, "--run", file, branch, agent];
  // -w 0: a new tab in the most recent Windows Terminal window (or a new window).
  spawn("wt.exe", ["-w", "0", "new-tab", "-d", dir, "--title", id, ...inner], { detached: true, stdio: "ignore" }).unref();
}

const [first, ...rest] = process.argv.slice(2);
if (first === "--run") insideTab(rest);
else fromLinear(first);
