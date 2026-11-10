import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createContext } from "../src/context.mjs";
import { init } from "../src/commands/init.mjs";
import { SHELL_NAMES, installProfile, profileBlock, profileState, profiles, shellInit } from "../src/commands/shell-init.mjs";
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
    assert.ok(text.split("\n").slice(0, 4).every((line) => line.startsWith("#")), text);
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
  assert.match(none.err, /Usage: nk shell-init <shell> \| nk shell-init --install/);
  assert.match(nk(["shell-init", "cmd"], { cwd: root, home }).err, /Unknown shell "cmd"/);
});

// In each shell: load the function the way its comment says, go to a workspace by name,
// then ask for one that does not exist and see that the shell stayed where it was.
// Git Bash on Windows says /c/Users/... for pwd; pwd -W gives the path as Windows writes it.
const PWD = process.platform === "win32" ? "pwd -W" : "pwd";
const POSIX = (name) => `eval "$(nk shell-init ${name})"; nks beta; echo "status=$?"; ${PWD}; nks no-such 2>/dev/null; echo "status=$?"; ${PWD}`;
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

test("profiles: the login shell's file elsewhere, what PowerShell says on Windows", () => {
  const home = join("/", "home", "me");
  const at = (SHELL, more = {}) => profiles({ env: { SHELL, ...more }, platform: "linux", home });
  assert.deepEqual(at("/bin/bash"), [{ shell: "bash", file: join(home, ".bashrc") }]);
  assert.deepEqual(at("/usr/bin/zsh"), [{ shell: "zsh", file: join(home, ".zshrc") }]);
  assert.deepEqual(at("/usr/bin/zsh", { ZDOTDIR: join(home, "z") }), [{ shell: "zsh", file: join(home, "z", ".zshrc") }]);
  assert.deepEqual(at("/usr/bin/fish"), [{ shell: "fish", file: join(home, ".config", "fish", "config.fish") }]);
  assert.deepEqual(at("/usr/bin/fish", { XDG_CONFIG_HOME: join(home, "x") }), [{ shell: "fish", file: join(home, "x", "fish", "config.fish") }]);
  // A shell nk has no function for, or none named: nothing is guessed.
  assert.deepEqual(at("/bin/tcsh"), []);
  assert.deepEqual(at(undefined), []);
  // A named shell is used whatever the login shell is.
  assert.deepEqual(profiles({ env: { SHELL: "/bin/bash" }, platform: "linux", home, only: "fish" }), [{ shell: "fish", file: join(home, ".config", "fish", "config.fish") }]);
  assert.throws(() => profiles({ env: {}, platform: "linux", home, only: "cmd" }), /Unknown shell "cmd"/);
});

test("installProfile adds its lines once, keeps the rest of the file, and replaces older lines of its own", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "deep", "profile");
  // No file and no folder yet.
  assert.equal(profileState(file, "bash"), "missing");
  assert.equal(installProfile(file, "bash"), "added");
  assert.equal(readFileSync(file, "utf8"), `${profileBlock("bash")}\n`);
  assert.equal(installProfile(file, "bash"), "current");

  // A file with content of its own, no newline at its end, Windows line endings and a letter outside ASCII.
  const mine = "Set-Alias g git\r\n# 我的配置";
  writeFileSync(file, mine);
  assert.equal(installProfile(file, "powershell"), "added");
  const crlf = profileBlock("powershell").replace(/\n/g, "\r\n");
  assert.equal(readFileSync(file, "utf8"), `${mine}\r\n\r\n${crlf}\r\n`);
  assert.equal(profileState(file, "powershell"), "current");

  // Lines an older nk wrote are replaced where they are; what is around them stays.
  writeFileSync(file, `before\n# >>> nk shell-init >>>\nfunction nks { old }\n# <<< nk shell-init <<<\nafter\n`);
  assert.equal(profileState(file, "powershell"), "outdated");
  assert.equal(installProfile(file, "powershell"), "updated");
  assert.equal(readFileSync(file, "utf8"), `before\n${profileBlock("powershell")}\nafter\n`);

  // A UTF-16 profile, as Notepad on older Windows saves them, stays UTF-16.
  writeFileSync(file, Buffer.from("\ufeff# 我的配置\r\n", "utf16le"));
  assert.equal(installProfile(file, "powershell"), "added");
  const bytes = readFileSync(file);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString("utf16le"), `# 我的配置\r\n\r\n${crlf}\r\n`);
});

test("nk shell-init --install writes the profile of the login shell, or of the shell named", { skip: process.platform === "win32" ? "asks PowerShell, which the PowerShell tests cover" : false }, (t) => {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const env = { HOME: root, SHELL: "/bin/bash", ZDOTDIR: "", XDG_CONFIG_HOME: "" };
  const first = nk(["shell-init", "--install"], { cwd: root, home, env });
  assert.equal(first.status, 0);
  assert.equal(first.out, "");
  assert.match(first.err, /Added nks to .*\.bashrc/);
  assert.equal(readFileSync(join(root, ".bashrc"), "utf8"), `${profileBlock("bash")}\n`);
  assert.match(nk(["shell-init", "--install"], { cwd: root, home, env }).err, /nks is already in .*\.bashrc/);
  assert.match(nk(["shell-init", "--install", "fish"], { cwd: root, home, env }).err, /Added nks to .*config\.fish/);
  const unknown = nk(["shell-init", "--install"], { cwd: root, home, env: { ...env, SHELL: "/bin/tcsh" } });
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /Cannot tell which shell you use \(\/bin\/tcsh\)/);
});

test("nk init offers nks in a terminal, once; with --yes it only says how", async (t) => {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"));
  const file = join(root, "profile.ps1");
  const shellProfiles = () => [{ shell: "powershell", file }];
  const session = (answer) => {
    const err = [];
    const asked = [];
    const ctx = createContext({ env: { ...process.env, NOOK_HOME: home }, cwd: repo, out: { write() {} }, err: { write: (text) => err.push(text) } });
    const prompter = {
      interactive: true,
      yes: false,
      ask: async (question, fallback) => fallback,
      confirm: async (question, fallback) => (asked.push(question), /Add nks/.test(question) ? answer : fallback),
    };
    return { ctx, prompter, asked: () => asked.filter((question) => /nks/.test(question)), err: () => err.join("") };
  };

  // Declined: nothing is written, and the next init asks again.
  let run = session(false);
  assert.equal(await init(run.ctx, { prompter: run.prompter, shellProfiles }), 0);
  assert.equal(run.asked().length, 1);
  assert.match(run.asked()[0], /Add nks to .*profile\.ps1\?/);
  assert.equal(profileState(file, "powershell"), "missing");
  assert.match(run.err(), /nk shell-init --install/);

  run = session(true);
  assert.equal(await init(run.ctx, { prompter: run.prompter, shellProfiles }), 0);
  assert.equal(profileState(file, "powershell"), "current");
  assert.match(run.err(), /Added nks to .*profile\.ps1/);

  // It is in: init does not ask again.
  run = session(true);
  assert.equal(await init(run.ctx, { prompter: run.prompter, shellProfiles }), 0);
  assert.equal(run.asked().length, 0);

  // --yes is a script or an agent: the profile is not looked for and not written.
  const other = join(root, "other.ps1");
  run = session(true);
  const never = () => assert.fail("looked for a profile");
  assert.equal(await init(run.ctx, { yes: true, prompter: { ...run.prompter, yes: true }, shellProfiles: never }), 0);
  assert.equal(profileState(other, "powershell"), "missing");
  assert.match(run.err(), /To go to a workspace from your shell \(nks\): nk shell-init --install/);
});
