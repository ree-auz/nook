import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ensureTrusted, findHook, hookCommand, hookHash, hookExtensions, runHook, trustState } from "../src/hooks.mjs";
import { tempDir, write } from "./helpers.mjs";

test("picks the platform script first, then portable ones", (t) => {
  const dir = tempDir(t);
  write(dir, { ".nook/create.sh": "", ".nook/create.ps1": "", ".nook/create.mjs": "", ".nook/open.py": "", ".nook/remove.cmd": "" });
  assert.equal(findHook(dir, "create", "linux").name, "create.sh");
  assert.equal(findHook(dir, "create", "darwin").name, "create.sh");
  assert.equal(findHook(dir, "create", "win32").name, "create.ps1");
  assert.equal(findHook(dir, "open", "linux").name, "open.py");
  assert.equal(findHook(dir, "remove", "win32").name, "remove.cmd");
  assert.equal(findHook(dir, "remove", "linux"), null);
  assert.equal(findHook(join(dir, "missing"), "create"), null);
  assert.deepEqual(hookExtensions("win32"), [".ps1", ".cmd", ".mjs", ".py"]);
});

test("maps each hook type to a runner", () => {
  const none = () => null;
  const hook = (ext) => ({ ext, file: `/x/create${ext}`, name: `create${ext}` });
  assert.equal(hookCommand(hook(".mjs"), { find: none }).command, process.execPath);
  assert.equal(hookCommand(hook(".sh"), { find: none }).command, "sh");
  assert.equal(hookCommand(hook(".sh"), { find: (c) => (c === "bash" ? "/bin/bash" : null) }).command, "/bin/bash");
  assert.equal(hookCommand(hook(".ps1"), { platform: "win32", find: none }).command, "powershell.exe");
  assert.equal(hookCommand(hook(".py"), { find: (c) => (c === "python" ? "python" : null) }).command, "python");
  assert.deepEqual(hookCommand(hook(".cmd"), { find: none }), { command: "/x/create.cmd", args: [] });
});

test("asks before the first run and after a change", async (t) => {
  const dir = tempDir(t);
  write(dir, { ".nook/create.mjs": "console.log(1)\n" });
  const hook = findHook(dir, "create");
  const repoConfig = { hooks: {} };
  let asked = 0;
  let saved = 0;
  const yes = { confirm: async () => (asked++, true) };
  const output = { write() {} };
  assert.equal(trustState(repoConfig, hook), "new");
  await ensureTrusted({ repoConfig, hook, prompter: yes, save: () => saved++, output });
  assert.equal(repoConfig.hooks["create.mjs"], hookHash(hook.file));
  await ensureTrusted({ repoConfig, hook, prompter: yes, save: () => saved++, output });
  assert.equal(asked, 1);
  writeFileSync(hook.file, "console.log(2)\n");
  assert.equal(trustState(repoConfig, hook), "changed");
  const no = { confirm: async () => false };
  await assert.rejects(ensureTrusted({ repoConfig, hook, prompter: no, save: () => saved++, output }), /not allowed/);
  await ensureTrusted({ repoConfig, hook, prompter: yes, save: () => saved++, output });
  assert.equal(asked, 2);
  assert.equal(saved, 2);
});

test("runs a hook with the environment and writes a log", async (t) => {
  const dir = tempDir(t);
  write(dir, { ".nook/create.mjs": "console.log('port=' + process.env.NOOK_PORT); process.exit(3)\n" });
  let shown = "";
  const result = await runHook(findHook(dir, "create"), {
    cwd: dir,
    env: { ...process.env, NOOK_PORT: "20010" },
    logsDir: join(dir, "logs"),
    label: "demo-x",
    output: { write: (chunk) => (shown += chunk) },
  });
  assert.equal(result.status, 3);
  assert.match(shown, /port=20010/);
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(result.log, "utf8"), /port=20010/);
});

test("line endings alone do not count as a change", (t) => {
  const dir = tempDir(t);
  write(dir, { "lf.mjs": "a\nb\n", "crlf.mjs": "a\r\nb\r\n", "other.mjs": "a\nc\n" });
  assert.equal(hookHash(join(dir, "lf.mjs")), hookHash(join(dir, "crlf.mjs")));
  assert.notEqual(hookHash(join(dir, "lf.mjs")), hookHash(join(dir, "other.mjs")));
});
