import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { makeRepo, nk, tempDir } from "./helpers.mjs";

const script = fileURLToPath(new URL("../integrations/linear/open-issue.mjs", import.meta.url));

test("the Linear launcher creates the workspace once, then reopens it", (t) => {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"), { ".gitignore": "agent.json\n" });
  assert.equal(nk(["init", "--yes", "--allow-hooks"], { cwd: repo, home }).status, 0);
  // A stand-in agent that records what it was given.
  const configPath = join(home, "config.toml");
  const config = parse(readFileSync(configPath, "utf8"));
  config.agents = { ...config.agents, node: { args: ["-e", "require('fs').writeFileSync('agent.json', JSON.stringify(process.argv.slice(1)))"] } };
  writeFileSync(configPath, stringify(config));

  const prompt = 'Work on REE-270: "Linear" & nk\n\n- step one; step two\n';
  const run = () => {
    const file = join(root, `prompt-${Math.random()}.md`);
    writeFileSync(file, prompt);
    const r = spawnSync(process.execPath, [script, "--run", file, "ree-auz/ree-270-linear-接入", "node"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, NOOK_HOME: home, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(file), false, "the prompt file is removed");
  };

  run();
  const ws = join(home, "workspace", "demo", "ree-auz-ree-270-linear");
  assert.deepEqual(JSON.parse(readFileSync(join(ws, "agent.json"), "utf8")), [prompt]);
  run();
  assert.deepEqual(JSON.parse(readFileSync(join(ws, "agent.json"), "utf8")), [], "reopened without the task prompt");
});

test("for Warp, a tab config runs the launcher in the chosen folder", async (t) => {
  const { openInWarp } = await import("../integrations/linear/open-issue.mjs");
  const appData = tempDir(t);
  const opened = [];
  const inner = ["C:\\Program Files\\nodejs\\node.exe", "C:\\nook\\open-issue.mjs", "--run", "C:\\Temp\\it's.md", "ree-270-x", "codex"];
  const { config } = openInWarp({ dir: "D:\\Projects\\Pipit", id: "REE-270", inner, env: { APPDATA: appData }, start: (uri) => opened.push(uri) });
  assert.match(config, /nk-ree-270-\d+\.toml$/);
  const tab = parse(readFileSync(config, "utf8"));
  assert.deepEqual(opened, [`warp://tab_config/${tab.name}`]);
  assert.equal(tab.title, "REE-270");
  assert.equal(tab.panes[0].directory, "D:\\Projects\\Pipit");
  assert.equal(
    tab.panes[0].commands[0],
    `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\nook\\open-issue.mjs' '--run' 'C:\\Temp\\it''s.md' 'ree-270-x' 'codex' '--cleanup' '${config}'`,
  );
});

test("an issue label can pick the agent", async () => {
  const { agentFromLabels } = await import("../integrations/linear/choose.mjs");
  const prompt = "<issue>\n<label>Chore</label>\n<label>模型 › Sol · 低</label>\n<label>执行 › Claude</label>\n</issue>";
  assert.equal(agentFromLabels(prompt, "执行"), "claude");
  assert.equal(agentFromLabels("<label>Agent › Opus Max</label>", "Agent"), "opus-max", "any name in the group");
  // Without the group, a label named like a known agent still picks it.
  assert.equal(agentFromLabels(prompt, "Agent"), "claude");
  assert.equal(agentFromLabels(prompt, undefined), "claude");
  assert.equal(agentFromLabels("<label>Grok</label>", undefined), "grok", "a label outside any group");
  assert.equal(agentFromLabels("<label>Chore</label>", undefined), null);
  assert.equal(agentFromLabels("<label>Agent › Codex</label><label>Claude</label>", undefined), null, "two agents: neither");
});

test("a model label picks the model, its effort and, alone, its agent", async () => {
  const { choose, agentModelArgs } = await import("../integrations/linear/choose.mjs");
  const config = {
    labels: { agent: "Agent", model: "Model" },
    models: { Luna: { id: "gpt-6-luna", agent: "codex" }, Opus: { id: "claude-opus-5-5", agent: "claude" }, Fast: "grok-5-fast" },
    efforts: { 高: "high" },
  };
  const pick = (labels, flags = {}) => choose(labels.map((l) => `<label>${l}</label>`).join("\n"), flags, config);

  assert.deepEqual(pick(["Model › Luna · 高", "Agent › Codex"]), { agent: "codex", model: { id: "gpt-6-luna", effort: "high" }, args: ["-m", "gpt-6-luna", "-c", "model_reasoning_effort=high"], terminal: null, orca: "orca", wezterm: "wezterm", open: "tab", closeLinearWindow: true, notes: [] });
  assert.equal(pick(["Model › Opus · high"]).agent, "claude", "the model's agent when no agent label");
  assert.deepEqual(pick(["Model › gpt-6.1-sol · low"]).model, { id: "gpt-6.1-sol", effort: "low" }, "a label that is a model id needs no config");
  assert.deepEqual(pick(["Model › Fast", "Agent › Grok"]).model, { id: "grok-5-fast", effort: null });
  // A model of another agent: that agent's own default, and a note says why.
  const mismatch = pick(["Model › Luna · high", "Agent › Grok"]);
  assert.equal(mismatch.agent, "grok");
  assert.equal(mismatch.model, null);
  assert.match(mismatch.notes[0], /Model › Luna · high is a codex model; grok starts with its own default/);
  assert.match(pick(["Model › Luna · turbo"]).notes[0], /"turbo" is not an effort; add it to "efforts"/);
  assert.match(pick(["Model › Opus · high"]).notes[0], /"agentArgs" in the config says no effort argument for claude/);
  assert.deepEqual(pick(["Model › Opus · high"], { terminal: "orca" }).notes, [], "Orca takes the effort");
  assert.equal(pick([], { agent: "gemini" }).agent, "gemini", "flags give the default");

  assert.deepEqual(agentModelArgs("codex", { id: "gpt-6-luna", effort: "high" }), ["-m", "gpt-6-luna", "-c", "model_reasoning_effort=high"]);
  assert.deepEqual(agentModelArgs("claude", { id: "opus", effort: "high" }), ["--model", "opus"]);
});

test("the config file is optional unless named", async (t) => {
  const { loadConfig } = await import("../integrations/linear/choose.mjs");
  const dir = tempDir(t);
  assert.deepEqual(loadConfig(join(dir, "none.json")), {});
  assert.throws(() => loadConfig(join(dir, "none.json"), { required: true }), /Could not read/);
  writeFileSync(join(dir, "bad.json"), "{ nope");
  assert.throws(() => loadConfig(join(dir, "bad.json")), /is not valid JSON/);
});

test("for Orca, nk creates the workspace and Orca starts the agent in it", (t) => {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"));
  assert.equal(nk(["init", "--yes", "--allow-hooks"], { cwd: repo, home }).status, 0);
  // A stand-in Orca CLI that records each call.
  const log = join(root, "orca.log");
  const program = `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`;
  writeFileSync(join(root, "orca.cjs"), program);
  // On Windows an npm-style .cmd shim; with a multi-line prompt the launcher skips cmd.exe.
  const orca = join(root, process.platform === "win32" ? "orca.cmd" : "orca");
  writeFileSync(orca, process.platform === "win32" ? '@node "%~dp0\\orca.cjs" %*\r\n' : program, { mode: 0o755 });
  const env = {
    ...process.env,
    NOOK_HOME: home,
    LINEAR_ISSUE_BRANCH_NAME: "ree-auz/ree-280-orca",
    LINEAR_WORK_DIR: repo,
    LINEAR_ISSUE_IDENTIFIER: "REE-280",
    LINEAR_PROMPT: 'Work on REE-280: "Orca"\n\n- step one\n<label>Model › Sol · medium</label>\n',
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const config = join(root, "nook.json");
  writeFileSync(config, JSON.stringify({ labels: { model: "Model" }, models: { Sol: "gpt-6.1-sol" } }));
  const run = () => {
    const r = spawnSync(process.execPath, [script, "--config", config, "--terminal", "orca", "--orca", orca, "--agent", "codex"], { cwd: root, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };

  run();
  const ws = join(home, "workspace", "demo", "ree-auz-ree-280-orca");
  assert.ok(existsSync(ws), "nk created the workspace");
  run();
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const launch = ["agent", "launch", "--agent", "codex", "--worktree", `path:${ws}`, "--focus", "--json", "--model", "gpt-6.1-sol", "--effort", "medium"];
  assert.deepEqual(calls, [["open", "--json"], [...launch, "--prompt", env.LINEAR_PROMPT], ["open", "--json"], launch]);
});

test("the launcher runs when started through a linked folder, like fnm's aliases\\default", (t) => {
  const root = tempDir(t);
  const linked = join(root, "default");
  symlinkSync(fileURLToPath(new URL("..", import.meta.url)), linked, "junction");
  const env = { ...process.env };
  delete env.LINEAR_ISSUE_BRANCH_NAME;
  delete env.LINEAR_WORK_DIR;
  const r = spawnSync(process.execPath, [join(linked, "integrations", "linear", "open-issue.mjs"), "--agent", "codex"], { encoding: "utf8", env });
  // It ran: it asks for Linear's variables instead of exiting silently.
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LINEAR_ISSUE_BRANCH_NAME and LINEAR_WORK_DIR are missing/);
});

test("a label can pick the terminal, Orca included", async () => {
  const { terminalFromLabels } = await import("../integrations/linear/choose.mjs");
  assert.equal(terminalFromLabels("<label>Terminal › Orca</label>", "Terminal"), "orca");
  assert.equal(terminalFromLabels("<label>Terminal › Windows Terminal</label>", "Terminal"), "wt");
  assert.equal(terminalFromLabels("<label>Terminal › Here</label>", "Terminal"), null, "the window Linear opened");
  assert.equal(terminalFromLabels("<label>Warp</label>", undefined), "warp", "a label named like a terminal");
  assert.equal(terminalFromLabels("<label>Chore</label>", "Terminal"), undefined, "no label: --terminal decides");
  assert.throws(() => terminalFromLabels("<label>Terminal › Kitty</label>", "Terminal"), /not a terminal/);
});

test("a model tier gives each agent its own model", async () => {
  const { choose } = await import("../integrations/linear/choose.mjs");
  const config = {
    labels: { agent: "Agent", model: "Model" },
    models: {
      Strong: { codex: { id: "gpt-6-astra", effort: "medium" }, claude: "claude-opus-5-5" },
      Fast: { codex: "gpt-6-luna" },
    },
  };
  const pick = (labels, flags = {}) => choose(labels.map((l) => `<label>${l}</label>`).join("\n"), flags, config);
  assert.deepEqual(pick(["Model › Strong", "Agent › Codex"]).model, { id: "gpt-6-astra", effort: "medium" }, "the tier's effort");
  assert.deepEqual(pick(["Model › Strong · high", "Agent › Codex"]).model, { id: "gpt-6-astra", effort: "high" }, "the label's effort wins");
  assert.deepEqual(pick(["Model › Strong", "Agent › Claude"]).model, { id: "claude-opus-5-5", effort: null });
  assert.equal(pick(["Model › Strong"], { agent: "codex" }).model.id, "gpt-6-astra", "the default agent's model");
  const missing = pick(["Model › Fast", "Agent › Grok"]);
  assert.equal(missing.model, null);
  assert.match(missing.notes[0], /Model › Fast: the config gives no grok model for it; grok starts with its own default/);
});

test("an effort label group sets the effort", async () => {
  const { choose } = await import("../integrations/linear/choose.mjs");
  const config = { labels: { agent: "Agent", model: "Model", effort: "Effort" }, models: { Strong: { codex: { id: "gpt-6-astra", effort: "medium" } } }, efforts: { 高: "high" } };
  const pick = (labels) => choose(labels.map((l) => `<label>${l}</label>`).join("\n"), {}, config);
  assert.deepEqual(pick(["Model › Strong", "Effort › 高"]).model, { id: "gpt-6-astra", effort: "high" }, "wins over the tier's effort");
  assert.deepEqual(pick(["Model › Strong", "Effort › low"]).model, { id: "gpt-6-astra", effort: "low" });
  assert.match(pick(["Model › Strong", "Effort › 猛"]).notes[0], /Effort › 猛: "猛" is not an effort/);
  // An effort alone: the agent's default model with that effort.
  assert.deepEqual(pick(["Effort › high"]).args, ["-c", "model_reasoning_effort=high"]);
});

test("agents and terminals map label names in any language", async () => {
  const { choose } = await import("../integrations/linear/choose.mjs");
  const config = {
    labels: { agent: "执行", terminal: "终端" },
    agents: { 克劳德: "claude", "Cursor 代理": "cursor-agent" },
    terminals: { 终端窗口: "Windows Terminal", 本窗口: "here", 坏的: "kitty" },
  };
  const pick = (labels, flags = {}) => choose(labels.map((l) => `<label>${l}</label>`).join("\n"), flags, config);
  assert.equal(pick(["执行 › 克劳德"]).agent, "claude");
  assert.equal(pick(["执行 › cursor 代理"]).agent, "cursor-agent", "names match without case");
  assert.equal(pick(["执行 › Codex"]).agent, "codex", "unmapped names still work as the command");
  assert.equal(pick(["克劳德"]).agent, "claude", "a mapped name works outside the group");
  assert.equal(pick(["终端 › 终端窗口"]).terminal, "wt");
  assert.equal(pick(["终端 › 本窗口"], { terminal: "orca" }).terminal, null, "here wins over the default");
  assert.equal(pick(["终端 › Orca"]).terminal, "orca", "built-in names need no map");
  assert.throws(() => pick(["终端 › 坏的"]), /maps 终端 › 坏的 to "kitty", which is not a terminal/);
  assert.throws(() => pick(["终端 › 随便"]), /is not a terminal; .* or map it in "terminals"/);
  assert.equal(pick([], { terminal: "Windows Terminal" }).terminal, "wt", "the default can be written like a label");
  assert.equal(choose("", {}, { terminal: "终端窗口", terminals: config.terminals }).terminal, "wt", "and through the map");
  assert.equal(choose("", {}, { terminal: "here" }).terminal, null);
});

test("efforts and arguments differ per agent", async () => {
  const { choose } = await import("../integrations/linear/choose.mjs");
  const config = {
    labels: { agent: "Agent", model: "Model", effort: "Effort" },
    models: { Strong: { codex: "gpt-6-astra", claude: "opus", gemini: "gemini-pro" } },
    efforts: { high: "high", xhigh: { codex: "xhigh", claude: "max" } },
    agentArgs: { claude: { model: ["--model", "{model}"], effort: ["--effort", "{effort}"] } },
  };
  const pick = (labels, flags = {}) => choose(labels.map((l) => `<label>${l}</label>`).join("\n"), flags, config);
  assert.deepEqual(pick(["Model › Strong", "Effort › xhigh", "Agent › Codex"]).args, ["-m", "gpt-6-astra", "-c", "model_reasoning_effort=xhigh"]);
  assert.deepEqual(pick(["Model › Strong", "Effort › xhigh", "Agent › Claude"]).args, ["--model", "opus", "--effort", "max"]);
  assert.deepEqual(pick(["Effort › high", "Agent › Claude"]).args, ["--effort", "high"], "an effort without a model");
  // No value for this agent: its default effort, and a note.
  const gemini = pick(["Model › Strong", "Effort › xhigh", "Agent › Gemini"]);
  assert.deepEqual(gemini.args, ["--model", "gemini-pro"]);
  assert.match(gemini.notes[0], /Effort › xhigh: "efforts" gives no gemini value for it/);
  // Orca gets the agent's own effort value, and needs a model with it.
  assert.deepEqual(pick(["Model › Strong", "Effort › xhigh", "Agent › Claude"], { terminal: "orca" }).model, { id: "opus", effort: "max" });
  assert.match(pick(["Effort › high"], { terminal: "orca" }).notes[0], /Orca takes an effort only with a model/);
});

test("the preset config parses and covers the built-in agents", async () => {
  const preset = JSON.parse(readFileSync(fileURLToPath(new URL("../integrations/linear/nook.example.json", import.meta.url)), "utf8"));
  for (const agent of ["codex", "claude", "grok", "pi", "droid", "aider"]) assert.ok(preset.agentArgs[agent]?.effort, `${agent} has an effort argument`);
  const { KNOWN_AGENTS } = await import("../src/agents.mjs");
  for (const agent of KNOWN_AGENTS) assert.ok(preset.agentArgs[agent], `${agent} has an agentArgs entry`);
  const { choose } = await import("../integrations/linear/choose.mjs");
  const pick = (labels) => choose(labels.map((l) => `<label>${l}</label>`).join("\n"), {}, preset);
  assert.equal(pick([]).terminal, null, "starts in Linear's window, not in a terminal someone may not have");
  assert.deepEqual(pick(["Agent › Pi", "Model › Strong", "Effort › Max"]).args, ["--model", "anthropic/claude-opus-5-5", "--thinking", "max"]);
  assert.deepEqual(pick(["Agent › GitHub Copilot", "Model › Light"]).args, ["--model", "claude-haiku-5.5"]);
  assert.deepEqual(pick(["Agent › Amp", "Model › Strong"]).args, [], "Amp takes no model flag");
});

test("WezTerm opens a tab in the open WezTerm window, else a window", async () => {
  const { openInWezTerm } = await import("../integrations/linear/open-issue.mjs");
  const inner = ["C:\\Program Files\\nodejs\\node.exe", "C:\\nook\\open-issue.mjs", "--run", "C:\\Temp\\it's.md", "ree-270-x", "codex"];
  const calls = [];
  const started = [];
  const panes = JSON.stringify([
    { window_id: 0, tab_id: 0, pane_id: 0, is_active: false },
    { window_id: 3, tab_id: 5, pane_id: 7, is_active: true },
  ]);
  // answers: what list and spawn return; set-tab-title always works.
  // No list-clients by default, as in an older WezTerm.
  const answer = ({ list = { status: 0, stdout: panes }, spawn = { status: 0, stdout: "42\n" }, clients = { status: 1 } } = {}) => (command, args) => {
    calls.push([command, ...args]);
    return { list, spawn, "list-clients": clients, "set-tab-title": { status: 0 } }[args[args[1] === "--no-auto-start" ? 2 : 1]];
  };
  const start = (command, args) => started.push([command, ...args]);

  assert.deepEqual(openInWezTerm({ dir: "D:\\Projects\\Pipit", id: "REE-270", inner, run: answer(), start }), { opened: "tab", reason: null });
  assert.deepEqual(calls, [
    ["wezterm", "cli", "--no-auto-start", "list", "--format", "json"],
    ["wezterm", "cli", "--no-auto-start", "list-clients", "--format", "json"],
    ["wezterm", "cli", "--no-auto-start", "spawn", "--window-id", "3", "--cwd", "D:\\Projects\\Pipit", "--", ...inner],
    ["wezterm", "cli", "set-tab-title", "--pane-id", "42", "REE-270"],
  ], "the tab goes into the window of the active pane: outside WezTerm, spawn has no current window");
  assert.deepEqual(started, []);

  // Every window has an active pane; the focused one of the client used last wins.
  calls.length = 0;
  const clients = { status: 0, stdout: JSON.stringify([
    { pid: 1, focused_pane_id: 7, idle_time: { secs: 300, nanos: 0 } },
    { pid: 2, focused_pane_id: 0, idle_time: { secs: 2, nanos: 0 } },
  ]) };
  openInWezTerm({ dir: ".", id: "x", inner, run: answer({ clients }), start });
  assert.deepEqual(calls[2].slice(3, 6), ["spawn", "--window-id", "0"]);

  calls.length = 0;
  const none = openInWezTerm({ dir: "/work/pipit", id: "REE-270", inner, wezterm: "/opt/wezterm", run: answer({ list: { status: 1, stderr: "failed to connect to gui\n" } }), start });
  assert.equal(none.opened, "window", "no WezTerm open");
  assert.match(none.reason, /No WezTerm window found .*failed to connect to gui/);
  assert.equal(calls.length, 1);
  assert.deepEqual(started, [["/opt/wezterm", "start", "--cwd", "/work/pipit", "--", ...inner, "--note", none.reason]], "the new window says why");

  started.length = 0;
  const refused = openInWezTerm({ dir: ".", id: "x", inner, run: answer({ spawn: { status: 1, stderr: "no such window" } }), start });
  assert.match(refused.reason, /did not open a tab .*no such window/);
  assert.equal(started.length, 1);

  started.length = 0;
  calls.length = 0;
  assert.deepEqual(openInWezTerm({ dir: ".", id: "x", inner, open: "window", run: answer(), start }), { opened: "window", reason: null });
  assert.equal(calls.length, 0, "open: window does not look for a window");
  assert.deepEqual(started, [["wezterm", "start", "--cwd", ".", "--", ...inner]]);

  const missing = () => ({ status: null, error: Object.assign(new Error("spawn wezterm ENOENT"), { code: "ENOENT" }) });
  assert.throws(() => openInWezTerm({ dir: ".", id: "x", inner, run: missing, start }), /could not run wezterm.*--wezterm/);
});

test("Windows Terminal opens a tab or a window, and the config chooses", async () => {
  const { openInWindowsTerminal } = await import("../integrations/linear/open-issue.mjs");
  const { choose } = await import("../integrations/linear/choose.mjs");
  const started = [];
  const start = (command, args) => started.push([command, ...args]);
  openInWindowsTerminal({ dir: "D:\\p", id: "REE-1", inner: ["node"], start });
  openInWindowsTerminal({ dir: "D:\\p", id: "REE-1", inner: ["node"], open: "window", start });
  assert.deepEqual(started.map((call) => call.slice(1, 3)), [["-w", "0"], ["-w", "new"]]);
  assert.equal(choose("", {}, {}).open, "tab");
  assert.equal(choose("", {}, { open: "window" }).open, "window");
  assert.equal(choose("", { open: "tab" }, { open: "window" }).open, "tab", "--open wins");
  assert.throws(() => choose("", {}, { open: "pane" }), /use "tab" or "window"/);
  assert.equal(choose("", {}, {}).closeLinearWindow, true);
  assert.equal(choose("", {}, { closeLinearWindow: false }).closeLinearWindow, false);
});

test("WezTerm is a terminal a label or the default can name", async () => {
  const { choose } = await import("../integrations/linear/choose.mjs");
  const pick = (labels, flags = {}, config = {}) => choose(labels.map((l) => `<label>${l}</label>`).join("\n"), flags, { labels: { terminal: "终端" }, ...config });
  assert.equal(pick(["终端 › WezTerm"]).terminal, "wezterm");
  assert.equal(pick(["WezTerm"]).terminal, "wezterm", "outside the group");
  assert.equal(pick([], {}, { terminal: "WezTerm" }).terminal, "wezterm");
  assert.equal(pick(["终端 › 韦兹"], {}, { terminals: { 韦兹: "wezterm" } }).terminal, "wezterm");
  assert.equal(pick([]).wezterm, "wezterm");
  assert.equal(pick([], { wezterm: "C:\\WezTerm\\wezterm.exe" }, { wezterm: "x" }).wezterm, "C:\\WezTerm\\wezterm.exe", "--wezterm wins");
  assert.throws(() => pick(["终端 › Kitty"]), /use Orca, Warp, WezTerm, Windows Terminal or Here/);
});

test("the script moves the issue to its team's first started status", async () => {
  const { apiKey, startIssue } = await import("../integrations/linear/start-issue.mjs");
  assert.equal(apiKey({ linear: { apiKey: "from-config" } }, { LINEAR_API_KEY: "from-env" }), "from-env");
  assert.equal(apiKey({ linear: { apiKey: "from-config" } }, {}), "from-config");
  assert.equal(apiKey({}, {}), null);

  const states = [
    { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "s-review", name: "In Review", type: "started", position: 3 },
    { id: "s-progress", name: "In Progress", type: "started", position: 2 },
  ];
  const linear = (issue) => {
    const sent = [];
    const fetch = async (url, { headers, body }) => {
      const { query, variables } = JSON.parse(body);
      sent.push({ url, auth: headers.Authorization, mutation: query.startsWith("mutation"), variables });
      const data = query.startsWith("mutation") ? { issueUpdate: { success: true } } : { viewer: { id: "me" }, issue: issue && { id: "uuid-302", team: { states: { nodes: states } }, ...issue } };
      return { ok: true, json: async () => ({ data }) };
    };
    return { sent, fetch };
  };

  const todo = linear({ state: { type: "unstarted", name: "Todo" }, assignee: null });
  assert.equal(await startIssue({ id: "REE-302", key: "lin_api_x", fetch: todo.fetch }), "REE-302: Todo → In Progress");
  assert.deepEqual(todo.sent[1], { url: "https://api.linear.app/graphql", auth: "lin_api_x", mutation: true, variables: { id: "uuid-302", input: { stateId: "s-progress" } } });

  const assign = linear({ state: { type: "unstarted", name: "Todo" }, assignee: null });
  assert.equal(await startIssue({ id: "REE-302", key: "k", assign: true, fetch: assign.fetch }), "REE-302: Todo → In Progress, assigned to you");
  assert.deepEqual(assign.sent[1].variables.input, { stateId: "s-progress", assigneeId: "me" });

  const started = linear({ state: { type: "started", name: "In Review" }, assignee: { id: "me" } });
  assert.equal(await startIssue({ id: "REE-302", key: "k", fetch: started.fetch }), "REE-302: already In Review");
  assert.equal(started.sent.length, 1, "a started issue is left alone");

  const failing = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ message: "Authentication required" }] }) });
  await assert.rejects(startIssue({ id: "REE-302", key: "bad", fetch: failing }), /Authentication required/);
});

test("an issue started again: the choices, the setting and the next branch", async () => {
  const { againChoices, againSetting, nextBranch } = await import("../integrations/linear/again.mjs");
  assert.equal(againSetting(), "ask");
  assert.equal(againSetting({}, { again: "new" }), "new");
  assert.equal(againSetting({ again: "prompt" }, { again: "new" }), "prompt", "--again wins");
  assert.throws(() => againSetting({}, { again: "twice" }), /use ask, continue, prompt, new, over, shell/);
  assert.deepEqual(againChoices("wezterm"), ["continue", "prompt", "new", "over", "shell"]);
  assert.ok(!againChoices("orca").includes("shell"), "Orca starts agents only");
  const branch = "ree-302-search-home";
  assert.equal(nextBranch(branch, [{ branch, name: branch }]), "ree-302-search-home-2");
  assert.equal(nextBranch(branch, [{ branch, name: branch }, { branch: `${branch}-2`, name: `${branch}-2` }]), "ree-302-search-home-3");
});

test("choices made in Linear's window win over the labels, for this start only", async () => {
  const { choose, pickOptions } = await import("../integrations/linear/choose.mjs");
  const config = {
    labels: { agent: "Agent", model: "Model", effort: "Effort", terminal: "Terminal" },
    models: { Strong: { codex: "gpt-6-astra", grok: "grok-4.7" } },
    efforts: { High: "high", Max: { codex: "max", grok: "high" } },
  };
  const prompt = ["Agent › Grok", "Model › Strong", "Effort › High", "Terminal › WezTerm"].map((l) => `<label>${l}</label>`).join("\n");
  const labels = choose(prompt, {}, config);
  assert.deepEqual([labels.agent, labels.model, labels.terminal], ["grok", { id: "grok-4.7", effort: "high" }, "wezterm"]);
  const picked = choose(prompt, { picks: { agent: "codex", effort: "Max", terminal: "Here" } }, config);
  assert.deepEqual([picked.agent, picked.model, picked.terminal], ["codex", { id: "gpt-6-astra", effort: "max" }, null], "the tier follows the picked agent");
  assert.equal(choose(prompt, { picks: { model: null, effort: null } }, config).model, null, "the agent's default model and effort");
  assert.equal(choose(prompt, { agentLabel: "Agent", picks: { agent: "claude" } }, config).agent, "claude", "over --agent-label too");
  const options = pickOptions(config);
  assert.deepEqual(options.model, [null, "Strong"]);
  assert.deepEqual(options.effort, [null, "High", "Max"]);
  assert.ok(options.agent.includes("grok") && options.terminal.includes("WezTerm"));
});

test("the list in Linear's window changes a choice, then starts", async () => {
  const { review } = await import("../integrations/linear/open-issue.mjs");
  const config = { labels: { agent: "Agent", model: "Model" }, models: { Strong: { codex: "gpt-6-astra", claude: "opus" } } };
  const prompt = "<label>Agent › Codex</label>\n<label>Model › Strong</label>";
  // Each answer picks a row by its text, or leaves with Esc (null).
  const run = async (answers, existing = null) => {
    const shown = [];
    const ask = async (title, items, text) => {
      shown.push(items.map(text));
      const answer = answers.shift();
      if (answer === null) return null;
      const [want, side] = Array.isArray(answer) ? answer : [answer];
      const item = items.find((i) => text(i).startsWith(want));
      assert.ok(item !== undefined, `no row "${want}" in ${items.map(text).join(" | ")}`);
      return side ? { item, side } : { item };
    };
    return { result: await review({ id: "REE-1", existing, again: "ask", prompt, flags: {}, config, ask }), shown };
  };
  const { result, shown } = await run(["Agent", "claude", "Start"]);
  assert.deepEqual(result, { again: "continue", picks: { agent: "claude" } });
  assert.ok(shown[2].includes("Model: opus"), "the model follows the new agent");
  assert.deepEqual((await run(["Model", "the agent's default", "Start"])).result.picks, { model: null });
  const again = await run(["Workspace", "Run again", "Start"], { name: "ree-1" });
  assert.equal(again.result.again, "new");
  assert.equal((await run([null])).result, null, "Esc starts nothing");
  // Left and Right change a line in place: [row text, side].
  const sides = await run([["Workspace", 1], ["Workspace", 1], ["Agent", -1], "Start"], { name: "ree-1" });
  assert.equal(sides.result.again, "new", "two steps right from continue");
  assert.ok(sides.shown[1][1].startsWith("Workspace ree-1: Start over"));
  assert.notEqual(sides.result.picks.agent, "codex");
  assert.ok(sides.shown[3][0].startsWith("Start ") && !sides.shown[3][0].endsWith("codex"), "Start shows the new agent");
});
