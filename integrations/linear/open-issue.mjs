#!/usr/bin/env node
// Opens a Linear issue in a Nook workspace, in a new terminal tab.
// Linear runs this file through ~/.linear/coding-tools.json
// (Work on issue -> Custom script). See README.md next to it.
//
//   node open-issue.mjs [--config file] [--agent a] [--agent-label g]
//                       [--terminal wt|warp|wezterm|orca] [--terminal-label g]
//                       [--open tab|window]                                    started by Linear
//   node open-issue.mjs --run <file> ...     inside the new tab
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentCommand, windowsDirect } from "../../src/agents.mjs";
import { CONFIG_PATH, choose, loadConfig, pickOptions } from "./choose.mjs";
import { AGAIN, AGAIN_SHORT, againChoices, againSetting, nextBranch } from "./again.mjs";
import { pick } from "../../src/select.mjs";
import { apiKey, startIssue } from "./start-issue.mjs";
import { normalizeName } from "../../src/names.mjs";
import crossSpawn from "cross-spawn";

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

/** The issue's workspace from `nk ls --json`, if it exists. */
function findWorkspace(branch) {
  return listWorkspaces().find((ws) => ws.branch === branch || ws.name === normalizeName(branch)) ?? null;
}

/** The repository's workspaces from `nk ls --json`, without the main checkout. */
function listWorkspaces() {
  const listed = spawnSync(process.execPath, [nk, "ls", "--json", "--no-pr"], { encoding: "utf8", env: withNodeOnPath() });
  return listed.status === 0 ? JSON.parse(listed.stdout).filter((ws) => !ws.main) : [];
}

/**
 * Creates the issue's workspace and starts the agent, or reopens it as
 * `again` says: continue (the agent without the prompt), prompt (with it)
 * or shell (no agent).
 */
function startWork({ branch, agent, prompt, args = [], again = "continue" }) {
  const existing = findWorkspace(branch);
  // Arguments after -- go to the agent: the model and effort the labels chose.
  const extra = args.length ? ["--", ...args] : [];
  let result;
  if (!existing) result = runNk(["-b", branch, agent, "-y", "-p", prompt, ...extra]);
  // -y: the branch name Linear suggests is converted without asking.
  else if (again === "shell") result = runNk([existing.name]);
  else if (again === "prompt") result = runNk([existing.name, agent, "-p", prompt, ...extra]);
  else result = runNk([existing.name, agent, ...extra]);
  process.exitCode = result.status ?? 1;
}

/** Inside a tab another terminal opened: the prompt comes in a file. */
export function insideTab([file, branch, agent, ...more]) {
  const prompt = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  // A Warp tab config written only for this launch.
  const cleanup = option(more, "--cleanup");
  if (cleanup) rmSync(cleanup, { force: true });
  const args = option(more, "--agent-args");
  const again = option(more, "--again");
  // Why this opened in a new window although a tab was asked for.
  const note = option(more, "--note");
  if (note) console.log(note);
  startWork({ branch, agent, prompt, args: args ? JSON.parse(args) : [], again });
}

/** Windows Terminal: -w 0 opens a tab in the most recent window (or a new window); -w new, a window. */
export function openInWindowsTerminal({ dir, id, inner, open = "tab", start = startDetached }) {
  start("wt.exe", ["-w", open === "window" ? "new" : "0", "new-tab", "-d", dir, "--title", id, ...inner]);
  return { opened: open };
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
  return { opened: "tab", config };
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

/**
 * WezTerm: a tab in the open WezTerm window, else a new window; with
 * open "window", always a new window. `wezterm cli list` finds the window,
 * and spawn gets its --window-id: outside WezTerm there is no current pane
 * to pick one from. `wezterm cli spawn` runs the command itself (no shell)
 * and prints the new pane's id; --no-auto-start keeps cli from starting a
 * hidden mux server. Works the same on Windows, macOS and Linux.
 * Returns { opened: "tab" | "window", reason }: reason says why a tab was
 * asked for and a window opened.
 */
export function openInWezTerm({ dir, id, inner, wezterm = "wezterm", open = "tab", run = runQuiet, start = startDetached, sockets = guiSockets }) {
  const inWindow = (reason) => {
    // The reason goes to the new window too: Linear's window closes.
    start(wezterm, ["start", "--cwd", dir, "--", ...inner, ...(reason ? ["--note", reason] : [])]);
    return { opened: "window", reason };
  };
  if (open === "window") return inWindow(null);
  const list = ["cli", "--no-auto-start", "list", "--format", "json"];
  let env;
  let listed = run(wezterm, list);
  if (listed.error?.code === "ENOENT") throw new Error(`could not run ${wezterm}. Is WezTerm installed and on PATH? Pass its path with --wezterm`);
  const said = (result) => String(result.stderr ?? "").trim().split(/\r?\n/).pop() || `exit code ${result.status}`;
  // cli follows a link to the WezTerm started last; once that one is gone,
  // the link points at nothing. A WezTerm still running has its own socket.
  for (const socket of listed.status === 0 ? [] : sockets()) {
    const tried = run(wezterm, list, { ...process.env, WEZTERM_UNIX_SOCKET: socket });
    if (tried.status === 0) {
      ({ listed, env } = { listed: tried, env: { ...process.env, WEZTERM_UNIX_SOCKET: socket } });
      break;
    }
  }
  if (listed.status !== 0) return inWindow(`No WezTerm window found to add a tab to (wezterm cli list: ${said(listed)})`);
  let panes = [];
  try {
    panes = JSON.parse(listed.stdout || "[]");
  } catch {
    // An older WezTerm without --format json: let spawn choose the window.
  }
  const windowId = focusedWindow(wezterm, panes, (command, args) => run(command, args, env));
  const target = windowId === undefined ? [] : ["--window-id", String(windowId)];
  const spawned = run(wezterm, ["cli", "--no-auto-start", "spawn", ...target, "--cwd", dir, "--", ...inner], env);
  if (spawned.status !== 0) return inWindow(`WezTerm did not open a tab (wezterm cli spawn: ${said(spawned)})`);
  const pane = String(spawned.stdout ?? "").trim();
  // Older WezTerm has no set-tab-title; the tab keeps the command's title then.
  if (/^\d+$/.test(pane)) run(wezterm, ["cli", "--no-auto-start", "set-tab-title", "--pane-id", pane, id], env);
  return { opened: "tab", reason: null };
}

/**
 * The window to add a tab to: the one with the focused pane of the WezTerm
 * window used last (list-clients knows it). "is_active" in the pane list
 * only means active in its own tab, so every window has one; it is the
 * fallback for a WezTerm without list-clients.
 */
function focusedWindow(wezterm, panes, run) {
  const listed = run(wezterm, ["cli", "--no-auto-start", "list-clients", "--format", "json"]);
  let clients = [];
  try {
    if (listed.status === 0) clients = JSON.parse(listed.stdout || "[]");
  } catch {
    // An older WezTerm: the pane list alone decides.
  }
  const idle = (client) => (client.idle_time?.secs ?? Infinity) + (client.idle_time?.nanos ?? 0) / 1e9;
  for (const client of [...clients].sort((a, b) => idle(a) - idle(b))) {
    const pane = panes.find((p) => p.pane_id === client.focused_pane_id);
    if (pane) return pane.window_id;
  }
  return panes.find((pane) => pane.is_active)?.window_id ?? panes[0]?.window_id;
}

/**
 * The sockets of running WezTerm windows, newest first: gui-sock-<pid> in
 * ~/.local/share/wezterm (Windows, macOS) or $XDG_RUNTIME_DIR/wezterm
 * (Linux), for a pid that is still running.
 */
export function guiSockets({ home = homedir(), env = process.env, alive = isRunning } = {}) {
  const dirs = [join(home, ".local", "share", "wezterm"), ...(env.XDG_RUNTIME_DIR ? [join(env.XDG_RUNTIME_DIR, "wezterm")] : [])];
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const pid = /^gui-sock-(\d+)$/.exec(name)?.[1];
      if (!pid || !alive(Number(pid))) continue;
      const path = join(dir, name);
      let time = 0;
      try {
        time = statSync(path).mtimeMs;
      } catch {
        // A socket that cannot be read sorts last.
      }
      found.push({ path, time });
    }
  }
  return found.sort((a, b) => b.time - a.time).map((socket) => socket.path);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Runs a command and waits, without a console window or a shell. */
function runQuiet(command, args, env = undefined) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, env });
}

/** Starts a program that outlives this script. */
function startDetached(command, args) {
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

const TERMINALS = { wt: openInWindowsTerminal, warp: openInWarp, wezterm: openInWezTerm };
/** Terminals that open on any platform; the others are Windows only so far. */
const ANY_PLATFORM = new Set(["wezterm"]);

/**
 * Orca: nk creates the workspace (hooks, ports, database), then Orca starts
 * the agent in it, so Orca keeps its accounts and sessions. Orca shows
 * worktrees it did not create. A new workspace gets Linear's prompt; one
 * that exists only gets a new agent session.
 */
export function workInOrca({ branch, agent, prompt, model = null, orca = "orca", again = "continue", run = runOrca }) {
  const existing = findWorkspace(branch);
  if (!existing) {
    const created = runNk(["-b", branch, "-y"]);
    if (created.status !== 0) return created.status ?? 1;
  }
  const ws = existing ?? findWorkspace(branch);
  if (!ws) throw new Error(`nk created no workspace for ${branch}`);
  run(orca, ["open", "--json"]);
  const args = ["agent", "launch", "--agent", agent, "--worktree", `path:${ws.path}`, "--focus", "--json"];
  // Orca's --effort needs --model.
  if (model?.id) args.push("--model", model.id, ...(model.effort ? ["--effort", model.effort] : []));
  if ((!existing || again === "prompt") && prompt) args.push("--prompt", prompt);
  return run(orca, args);
}

/** Runs the Orca CLI, never through cmd.exe, which would cut the prompt. */
function runOrca(orca, args) {
  const env = withNodeOnPath();
  const spec = windowsDirect({ command: agentCommand({}, orca, {}, env).command, args });
  // cross-spawn: a .cmd shim still runs when the arguments have no line breaks.
  const result = crossSpawn.sync(spec.command, spec.args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env });
  if (result.error) throw new Error(`could not run ${orca}: ${result.error.message}. Is Orca's command-line tool installed? Pass its path with --orca`);
  // Orca answers in JSON; show it only when something went wrong.
  if (result.status !== 0) process.stdout.write(result.stdout ?? "");
  return result.status ?? 1;
}

/**
 * Closes the terminal window Linear opened for this script, once the work
 * runs in another terminal: its shell is this process's parent.
 */
function closeLinearWindow() {
  if (process.platform !== "win32") return;
  const parent = spawnSync("tasklist.exe", ["/FI", `PID eq ${process.ppid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (/^"(powershell|pwsh|cmd)\.exe"/i.test(parent.stdout ?? "")) process.kill(process.ppid);
}

/** `--name value` from the arguments Linear passes. */
function option(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function fromLinear(argv) {
  const configPath = option(argv, "--config");
  const config = loadConfig(configPath ?? CONFIG_PATH, { required: Boolean(configPath) });
  const flags = { again: option(argv, "--again"), agent: option(argv, "--agent"), agentLabel: option(argv, "--agent-label"), terminal: option(argv, "--terminal"), terminalLabel: option(argv, "--terminal-label"), orca: option(argv, "--orca"), wezterm: option(argv, "--wezterm"), open: option(argv, "--open") };
  const { LINEAR_ISSUE_BRANCH_NAME: linearBranch, LINEAR_WORK_DIR: dir, LINEAR_ISSUE_IDENTIFIER: id = "issue", LINEAR_PROMPT: prompt = "" } = process.env;
  if (!linearBranch || !dir) throw new Error("LINEAR_ISSUE_BRANCH_NAME and LINEAR_WORK_DIR are missing; list them under env in coding-tools.json");
  process.chdir(dir);
  const workspaces = listWorkspaces();
  const existing = workspaces.find((ws) => ws.branch === linearBranch || ws.name === normalizeName(linearBranch)) ?? null;
  const setting = againSetting(flags, config);
  let again = existing ? setting : "continue";
  let picks = {};
  // The list in Linear's window: always with "confirm", and when the issue already has a workspace and "again" is ask.
  if (process.stdin.isTTY && (config.confirm === true || (existing && setting === "ask"))) {
    const reviewed = await review({ id, existing, again, prompt, flags, config });
    if (!reviewed) return console.log("Nothing started.");
    ({ again, picks } = reviewed);
  } else if (again === "ask") again = "continue";
  const { agent, model, args, terminal, orca, wezterm, open: openIn, closeLinearWindow: close, notes } = choose(prompt, { ...flags, picks }, config);
  // Say what starts and why, so a label that was not picked up is easy to see.
  const where = { wt: "Windows Terminal", warp: "Warp", wezterm: "WezTerm", orca: "Orca" }[terminal] ?? "this window";
  console.log(`Agent: ${agent} in ${where}${model?.id ? `, model ${model.id}` : ", its default model"}${model?.effort ? `, effort ${model.effort}` : ""}`);
  for (const note of notes) console.log(`  ${note}`);
  if (again === "shell" && terminal === "orca") again = "continue";
  let branch = linearBranch;
  if (existing) {
    console.log(`  ${existing.name}: ${AGAIN[again]}`);
    if (again === "new") branch = nextBranch(linearBranch, workspaces);
    if (again === "over" && runNk(["rm", existing.name, "-y"]).status !== 0) throw new Error(`nk rm ${existing.name} failed; nothing started`);
  }
  // Linear's "move issue to started status" setting skips custom scripts, so the script does it.
  const key = apiKey(config);
  if (key && config.linear?.start !== false) {
    try {
      console.log(`  ${await startIssue({ id, key, assign: config.linear?.assign === true })}`);
    } catch (error) {
      console.log(`  Could not update ${id} in Linear: ${error.message}`);
    }
  }
  // Default: work in the terminal Linear opened for the script.
  if (!terminal) return startWork({ branch, agent, prompt, args, again });
  if (terminal === "orca") {
    process.exitCode = workInOrca({ branch, agent, prompt, model, orca, again });
    // Keep Linear's window open when something failed, so its output can be read.
    if (close && process.exitCode === 0 && process.platform === "win32") closeLinearWindow();
    return;
  }
  const open = TERMINALS[terminal];
  if (!open) throw new Error(`Unknown terminal "${terminal}"; use ${[...Object.keys(TERMINALS), "orca"].join(", ")}, or leave --terminal out`);
  if (process.platform !== "win32" && !ANY_PLATFORM.has(terminal)) throw new Error(`--terminal ${terminal} only works on Windows so far; wezterm and orca work everywhere`);
  // The prompt is long Markdown with quotes and semicolons, so it travels in a file.
  const file = join(tmpdir(), `nk-linear-${id}-${process.pid}.md`);
  writeFileSync(file, prompt);
  const agentArgs = args.length ? ["--agent-args", JSON.stringify(args)] : [];
  const inner = [process.execPath, self, "--run", file, branch, agent, ...agentArgs, "--again", again];
  const { reason } = open({ dir, id, inner, wezterm, open: openIn });
  if (reason) {
    // The agent clears the new window, so Linear's window stays to show why.
    console.log(`  ${reason}`);
    if (process.stdin.isTTY) {
      process.stdout.write("  Press Enter to close this window.");
      await new Promise((done) => process.stdin.once("data", done).resume());
      process.stdin.pause();
    }
  }
  if (close) closeLinearWindow();
}

const TERMINAL_SHOWN = { wt: "Windows Terminal", warp: "Warp", wezterm: "WezTerm", orca: "Orca" };
const DEFAULT = "the agent's default";

/** The value `side` steps away from `current` in `values`, wrapping around. */
function step(values, current, side) {
  const at = values.indexOf(current);
  const from = at === -1 ? (side > 0 ? -1 : 0) : at;
  return values[(from + side + values.length) % values.length];
}

/**
 * The list in Linear's window before anything starts: Start, then what the
 * labels chose (agent, model, effort, terminal) and, for an issue that has
 * a workspace, what to do with it. Left and Right change a line in place;
 * Enter on a line lists its values, and Esc there goes back. A change holds
 * for this start only. It is one list that changes in place, never a list
 * that ends and another that starts (see pick).
 * Returns { again, picks }, or null when left with Esc.
 */
export async function review({ id, existing, again, prompt, flags, config, input = process.stdin, output = process.stdout }) {
  let state = { again: again === "ask" ? "continue" : again, picks: {} };
  const options = pickOptions(config);
  const one = (item) => [item.text];

  const main = (at = "start") => {
    const now = choose(prompt, { ...flags, picks: state.picks }, config);
    const againKeys = againChoices(now.terminal);
    const current = { agent: now.agent, terminal: TERMINAL_SHOWN[now.terminal] ?? "Here" };
    const rows = [
      { key: "start", text: `Start ${now.agent}` },
      ...(existing ? [{ key: "again", text: `Workspace ${existing.name}: ${AGAIN_SHORT[state.again]}` }] : []),
      { key: "agent", text: `Agent: ${now.agent}` },
      { key: "model", text: `Model: ${now.model?.id ?? DEFAULT}` },
      { key: "effort", text: `Effort: ${now.model?.effort ?? DEFAULT}` },
      { key: "terminal", text: `Terminal: ${TERMINAL_SHOWN[now.terminal] ?? "this window"}` },
    ];
    const valueOf = (key) => (key === "again" ? state.again : key in state.picks ? state.picks[key] : current[key]);
    const valuesOf = (key) => (key === "again" ? againKeys : options[key]);
    const set = (key, value) => {
      state = key === "again" ? { ...state, again: value } : { ...state, picks: { ...state.picks, [key]: value } };
    };
    // A sub-list of one line's values; choosing or Esc comes back here.
    const values = (row) => {
      const list = valuesOf(row.key).map((value) => ({ value, text: row.key === "again" ? AGAIN_SHORT[value] : (value ?? DEFAULT) }));
      return {
        title: row.key === "again" ? "Workspace" : row.text.split(":")[0],
        items: list,
        cells: one,
        text: (item) => item.text,
        start: list.find((item) => item.value === valueOf(row.key)),
        hint: row.key === "again" ? (item) => AGAIN[item.value] : undefined,
        onChoose: (item) => {
          set(row.key, item.value);
          return { view: main(row.key) };
        },
        onCancel: () => ({ view: main(row.key) }),
      };
    };
    return {
      title: `${id}: change a line, then Start`,
      items: rows,
      cells: one,
      text: (row) => row.text,
      start: rows.find((row) => row.key === at) ?? rows[0],
      sides: true,
      hint: (row) => (row.key === "again" ? AGAIN[state.again] : row.key === "start" ? `Enter starts ${id}` : ""),
      onChoose: (row, side) => {
        if (row.key === "start") return side ? { view: main("start") } : undefined;
        if (!side) return { view: values(row) };
        set(row.key, step(valuesOf(row.key), valueOf(row.key), side));
        return { view: main(row.key) };
      },
    };
  };

  const unicode = process.platform !== "win32" || Boolean(process.env.WT_SESSION);
  const chosen = await pick({ input, output, unicode, ...main() }).result;
  return "item" in chosen ? state : null;
}

/**
 * Run directly, not imported. Node gives this file its real path, so a path
 * through a link (fnm's aliases\default, for one) is resolved before comparing.
 */
function runDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(self);
  } catch {
    return resolve(process.argv[1]) === self;
  }
}

if (runDirectly()) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--run") insideTab(rest);
  else
    fromLinear(process.argv.slice(2)).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
