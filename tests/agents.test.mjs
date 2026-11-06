import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { launch } from "../src/agents.mjs";
import { tempDir, write } from "./helpers.mjs";

// Prompts from trackers such as Linear are long Markdown with quotes and
// several lines. The agent must receive them as one argument, unchanged,
// including through an npm .cmd shim on Windows.
const prompt = 'Work on REE-1: "fix" it & ship\n\n- keep 100% of <tests>\n- path C:\\x\\ ; done';

test("the agent receives a multi-line prompt as one argument", (t) => {
  const dir = tempDir(t);
  const out = join(dir, "args.json");
  write(dir, {
    "agent.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
    // The same shape npm writes for a global command on Windows.
    "agent.cmd": '@ECHO off\r\nnode "%~dp0\\agent.mjs" %*\r\n',
    agent: `#!/bin/sh\nexec node "$(dirname "$0")/agent.mjs" "$@"\n`,
  });
  const command = process.platform === "win32" ? join(dir, "agent.cmd") : join(dir, "agent");
  if (process.platform !== "win32") chmodSync(command, 0o755);
  const status = launch({ command, args: ["--flag", prompt] }, { cwd: dir, env: process.env });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["--flag", prompt]);
});

