#!/usr/bin/env node
// Opens a Linear issue in a Nook workspace, in a new terminal tab.
// Linear runs this file through ~/.linear/coding-tools.json
// (Work on issue -> Custom script). See README.md next to it.
//
//   node open-issue.mjs [agent]              started by Linear (no window)
//   node open-issue.mjs --run <file> ...     inside the new tab
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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

/** Creates the issue's workspace and starts the agent, or reopens it. */
function startWork({ branch, agent, prompt }) {
  const listed = spawnSync(process.execPath, [nk, "ls", "--json"], { encoding: "utf8", env: withNodeOnPath() });
  const existing = listed.status === 0 ? JSON.parse(listed.stdout).find((ws) => !ws.main && (ws.branch === branch || ws.name === normalizeName(branch))) : null;
  // Clicked again for the same issue: reopen the workspace without restarting the task.
  // -y: the branch name Linear suggests is converted without asking.
  const result = existing ? runNk([existing.name, agent]) : runNk(["-b", branch, agent, "-y", "-p", prompt]);
  process.exitCode = result.status ?? 1;
}

/** Inside a tab another terminal opened: the prompt comes in a file. */
export function insideTab([file, branch, agent, ...more]) {
  const prompt = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  // A Warp tab config written only for this launch.
  if (more[0] === "--cleanup" && more[1]) rmSync(more[1], { force: true });
  startWork({ branch, agent, prompt });
}

/** Windows Terminal: -w 0 opens a tab in the most recent window (or a new window). */
function openInWindowsTerminal({ dir, id, inner }) {
  spawn("wt.exe", ["-w", "0", "new-tab", "-d", dir, "--title", id, ...inner], { detached: true, stdio: "ignore" }).unref();
}

/** A PowerShell argument in single quotes. */
const psQuote = (text) => `'${String(text).replaceAll("'", "''")}'`;

/**
 * Warp: its URI scheme cannot run a command, so write a tab config that
 * does and open it with warp://tab_config/<name>, as Warp's docs advise.
 * The tab deletes the config once it starts.
 */
export function openInWarp({ dir, id, inner, env = process.env, start = openUri }) {
  const folder = join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "warp", "Warp", "data", "tab_configs");
  mkdirSync(folder, { recursive: true });
  const name = `nk-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${process.pid}`;
  const config = join(folder, `${name}.toml`);
  const [node, ...args] = [...inner, "--cleanup", config];
  const shell = which("pwsh") ? "pwsh" : "powershell";
  const command = `& ${[node, ...args].map(psQuote).join(" ")}`;
  writeFileSync(
    config,
    [`name = ${JSON.stringify(name)}`, `title = ${JSON.stringify(id)}`, "", "[[panes]]", 'id = "main"', 'type = "terminal"', `shell = ${JSON.stringify(shell)}`, `directory = ${JSON.stringify(dir)}`, `commands = [${JSON.stringify(command)}]`, ""].join("\n"),
  );
  start(`warp://tab_config/${name}`);
  return config;
}

/** Opens a URI with its registered app, like PowerShell's Start-Process. */
function openUri(uri) {
  spawn("cmd.exe", ["/d", "/c", "start", '""', uri], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
}

/** A command on PATH, without running it. */
function which(command) {
  const result = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

const TERMINALS = { wt: openInWindowsTerminal, warp: openInWarp };

/**
 * Closes the terminal window Linear opened for this script, once the work
 * runs in another terminal: its shell is this process's parent.
 */
function closeLinearWindow() {
  const parent = spawnSync("tasklist.exe", ["/FI", `PID eq ${process.ppid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (/^"(powershell|pwsh|cmd)\.exe"/i.test(parent.stdout ?? "")) process.kill(process.ppid);
}

/**
 * The agent named by a label in Linear's prompt, which lists the issue's
 * labels as <label>Group › Name</label>: with group "Agent", an issue
 * labelled "Agent › Claude" gets `claude`.
 */
export function agentFromLabels(prompt, group) {
  if (!group) return null;
  for (const [, text] of prompt.matchAll(/<label>([^<]*)<\/label>/g)) {
    const [labelGroup, name] = text.split("›").map((part) => part.trim());
    if (name && labelGroup === group) return name.toLowerCase().replace(/\s+/g, "-");
  }
  return null;
}

/** `--name value` from the arguments Linear passes. */
function option(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function fromLinear(argv) {
  const terminal = option(argv, "--terminal");
  const agent = agentFromLabels(process.env.LINEAR_PROMPT ?? "", option(argv, "--agent-label")) ?? option(argv, "--agent") ?? "codex";
  const { LINEAR_ISSUE_BRANCH_NAME: branch, LINEAR_WORK_DIR: dir, LINEAR_ISSUE_IDENTIFIER: id = "issue", LINEAR_PROMPT: prompt = "" } = process.env;
  if (!branch || !dir) throw new Error("LINEAR_ISSUE_BRANCH_NAME and LINEAR_WORK_DIR are missing; list them under env in coding-tools.json");
  // Default: work in the terminal Linear opened for the script.
  if (!terminal) {
    process.chdir(dir);
    return startWork({ branch, agent, prompt });
  }
  const open = TERMINALS[terminal];
  if (!open) throw new Error(`Unknown terminal "${terminal}"; use ${Object.keys(TERMINALS).join(" or ")}, or leave --terminal out`);
  if (process.platform !== "win32") throw new Error("--terminal only works on Windows so far");
  // The prompt is long Markdown with quotes and semicolons, so it travels in a file.
  const file = join(tmpdir(), `nk-linear-${id}-${process.pid}.md`);
  writeFileSync(file, prompt);
  open({ dir, id, inner: [process.execPath, self, "--run", file, branch, agent] });
  closeLinearWindow();
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--run") insideTab(rest);
  else fromLinear(process.argv.slice(2));
}
