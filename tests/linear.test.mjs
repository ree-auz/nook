import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.equal(nk(["init", "--yes"], { cwd: repo, home }).status, 0);
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
  const ws = join(home, "workspaces", "demo", "ree-auz-ree-270-linear");
  assert.deepEqual(JSON.parse(readFileSync(join(ws, "agent.json"), "utf8")), [prompt]);
  run();
  assert.deepEqual(JSON.parse(readFileSync(join(ws, "agent.json"), "utf8")), [], "reopened without the task prompt");
});
