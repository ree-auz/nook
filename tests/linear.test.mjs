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
  const config = openInWarp({ dir: "D:\\Projects\\Pipit", id: "REE-270", inner, env: { APPDATA: appData }, start: (uri) => opened.push(uri) });
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

  assert.deepEqual(pick(["Model › Luna · 高", "Agent › Codex"]), { agent: "codex", model: { id: "gpt-6-luna", effort: "high" }, args: ["-m", "gpt-6-luna", "-c", "model_reasoning_effort=high"], terminal: null, orca: "orca", notes: [] });
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
  for (const agent of ["codex", "claude", "grok"]) assert.ok(preset.agentArgs[agent]?.effort, `${agent} has an effort argument`);
});
