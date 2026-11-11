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
  const { agentFromLabels } = await import("../integrations/linear/open-issue.mjs");
  const prompt = "<issue>\n<label>Chore</label>\n<label>模型 › Sol · 低</label>\n<label>执行 › Claude</label>\n</issue>";
  assert.equal(agentFromLabels(prompt, "执行"), "claude");
  assert.equal(agentFromLabels("<label>Agent › Opus Max</label>", "Agent"), "opus-max", "any name in the group");
  // Without the group, a label named like a known agent still picks it.
  assert.equal(agentFromLabels(prompt, "Agent"), "claude");
  assert.equal(agentFromLabels(prompt, undefined), "claude");
  assert.equal(agentFromLabels("<label>Grok</label>", undefined), "grok", "a label outside any group");
  assert.equal(agentFromLabels("<label>Chore</label>", undefined), null);
  assert.equal(agentFromLabels("<label>执行 › Codex</label><label>Claude</label>", undefined), null, "two agents: neither");
});

test("a model label picks Codex's model and effort", async () => {
  const { chooseAgent, agentModelArgs } = await import("../integrations/linear/open-issue.mjs");
  const prompt = "<label>Chore</label>\n<label>模型 › Luna · 高</label>\n<label>执行 › Codex</label>";
  const args = ["--agent-label", "执行", "--model-label", "模型", "--model", "Luna=gpt-6-luna", "--model", "Sol=gpt-6.1-sol"];
  const chosen = chooseAgent(args, prompt);
  assert.deepEqual(chosen, { agent: "codex", model: { id: "gpt-6-luna", effort: "high" }, notes: [] });
  assert.deepEqual(agentModelArgs("codex", chosen.model), ["-m", "gpt-6-luna", "-c", "model_reasoning_effort=high"]);
  assert.deepEqual(agentModelArgs("claude", { id: "opus", effort: "high" }), ["--model", "opus"]);
  // A model label on an issue another agent works on: that agent's own model.
  const grok = chooseAgent(args, prompt.replace("执行 › Codex", "执行 › Grok"));
  assert.equal(grok.agent, "grok");
  assert.equal(grok.model, null);
  assert.match(grok.notes[0], /模型 › Luna · 高 is for codex; grok starts with its own default model/);
  // A model with no id: say how to add one.
  const unmapped = chooseAgent(["--model-label", "模型"], prompt);
  assert.equal(unmapped.model, null);
  assert.match(unmapped.notes[0], /add "--model", "Luna=<model id>"/);
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
    LINEAR_PROMPT: 'Work on REE-280: "Orca"\n\n- step one\n<label>模型 › Sol · 中</label>\n',
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const run = () => {
    const r = spawnSync(process.execPath, [script, "--terminal", "orca", "--orca", orca, "--agent", "codex", "--model-label", "模型", "--model", "Sol=gpt-6.1-sol"], { cwd: root, encoding: "utf8", env });
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
  const { terminalFromLabels } = await import("../integrations/linear/open-issue.mjs");
  assert.equal(terminalFromLabels("<label>终端 › Orca</label>", "终端"), "orca");
  assert.equal(terminalFromLabels("<label>终端 › Windows Terminal</label>", "终端"), "wt");
  assert.equal(terminalFromLabels("<label>终端 › Here</label>", "终端"), null, "the window Linear opened");
  assert.equal(terminalFromLabels("<label>Warp</label>", undefined), "warp", "a label named like a terminal");
  assert.equal(terminalFromLabels("<label>Chore</label>", "终端"), undefined, "no label: --terminal decides");
  assert.throws(() => terminalFromLabels("<label>终端 › Kitty</label>", "终端"), /not a terminal/);
});
