import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SHELL_NAMES, shellInit } from "../src/commands/shell-init.mjs";
import { samePath } from "../src/home.mjs";
import { makeRepo, nk, tempDir, write } from "./helpers.mjs";

const bin = fileURLToPath(new URL("../bin/nk.mjs", import.meta.url));
const has = (program) => !spawnSync(program, ["--version"], { stdio: "ignore", windowsHide: true }).error;

/** A repository with one workspace, and a folder that puts this checkout's nk on PATH. */
function setup(t) {
  const root = tempDir(t);
  // A space and letters outside ASCII in the workspace's path: the function must take it whole.
  const home = join(root, "nook home 工作区");
  const repo = makeRepo(join(root, "demo"));
  assert.equal(nk(["init", "--yes", "--name", "demo"], { cwd: repo, home }).status, 0);
  assert.equal(nk(["-b", "beta"], { cwd: repo, home }).status, 0);
  const tools = join(root, "tools");
  write(tools, {
    nk: `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`,
    "nk.cmd": `@ECHO off\r\n"${process.execPath}" "${bin}" %*\r\n`,
  });
  if (process.platform !== "win32") chmodSync(join(tools, "nk"), 0o755);
  const beta = join(home, "workspace", "demo", "beta");
  const env = { ...process.env, NOOK_HOME: home, NOOK_TEST_BETA: beta, PATH: `${tools}${delimiter}${process.env.PATH}` };
  const run = (program, args) => {
    const result = spawnSync(program, args, { cwd: repo, env, encoding: "utf8", timeout: 60000, windowsHide: true });
    return { status: result.status, lines: result.stdout.split(/\r?\n/).filter(Boolean), err: result.stderr };
  };
  return { repo, run, beta };
}

test("nk shell-init prints a function for each shell and the line that loads it", () => {
  assert.deepEqual(SHELL_NAMES, ["powershell", "bash", "zsh", "fish"]);
  for (const name of SHELL_NAMES) {
    const text = shellInit(name);
    assert.match(text, /nks/);
    assert.match(text, new RegExp(`nk shell-init ${name}`));
    // Loading it must not print anything: every line before the function is a comment.
    assert.ok(text.split("\n").slice(0, 3).every((line) => line.startsWith("#")), text);
  }
  // PowerShell reads this text in the console's encoding, so it keeps to ASCII.
  assert.ok([...shellInit("powershell")].every((char) => char.charCodeAt(0) < 128));
  assert.equal(shellInit("pwsh"), shellInit("powershell"));
  assert.equal(shellInit("PowerShell"), shellInit("powershell"));
  assert.throws(() => shellInit("cmd"), /Unknown shell "cmd"\nUse one of: powershell, bash, zsh, fish/);
  assert.throws(() => shellInit("constructor"), /Unknown shell/);
});

test("nk shell-init through the command line", (t) => {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const one = nk(["shell-init", "bash"], { cwd: root, home });
  assert.deepEqual({ status: one.status, out: one.out, err: one.err }, { status: 0, out: `${shellInit("bash")}\n`, err: "" });
  const none = nk(["shell-init"], { cwd: root, home });
  assert.equal(none.status, 1);
  assert.equal(none.out, "");
  assert.match(none.err, /Usage: nk shell-init <shell>/);
  assert.match(nk(["shell-init", "cmd"], { cwd: root, home }).err, /Unknown shell "cmd"/);
});

// In each shell: load the function the way its comment says, go to a workspace by name,
// then ask for one that does not exist and see that the shell stayed where it was.
const POSIX = (name) => `eval "$(nk shell-init ${name})"; nks beta; echo "status=$?"; pwd; nks no-such 2>/dev/null; echo "status=$?"; pwd`;
const SCRIPTS = {
  bash: ["bash", ["-c", POSIX("bash")]],
  zsh: ["zsh", ["-c", POSIX("zsh")]],
  fish: ["fish", ["-c", `nk shell-init fish | source; nks beta; echo "status=$status"; pwd; nks no-such 2>/dev/null; echo "status=$status"; pwd`]],
  pwsh: ["pwsh", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL()]],
  // Windows PowerShell 5.1, which every Windows has.
  powershell: ["powershell", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL()]],
};

// PowerShell compares the folders itself: what it prints goes through the console's
// encoding, which is the very thing the function has to get around.
function POWERSHELL() {
  const there = "Write-Output ((Get-Location).Path -eq $env:NOOK_TEST_BETA)";
  return ["Invoke-Expression (& nk shell-init powershell | Out-String)", "nks beta", 'Write-Output "status=$LASTEXITCODE"', there, "nks no-such 2>$null", 'Write-Output "status=$LASTEXITCODE"', there].join("; ");
}

for (const [name, [program, args]] of Object.entries(SCRIPTS)) {
  const skip = (name === "powershell" && process.platform !== "win32") || !has(program) ? `${program} is not installed` : false;
  test(`nks in ${name}: goes to the workspace, and stays put when nk switch fails`, { skip }, (t) => {
    const { run, beta } = setup(t);
    const result = run(program, args);
    assert.equal(result.lines.length, 4, `${result.lines.join("\n")}\n${result.err}`);
    const [first, there, second, still] = result.lines;
    const at = (line) => (program === "pwsh" || program === "powershell" ? line === "True" : samePath(line, beta));
    assert.equal(first, "status=0");
    assert.ok(at(there), `${there} is not ${beta}`);
    assert.equal(second, "status=1");
    assert.ok(at(still), `${still} is not ${beta}`);
  });
}
