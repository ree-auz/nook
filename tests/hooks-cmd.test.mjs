import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { makeRepo, nk, sh, tempDir, write } from "./helpers.mjs";

// A stand-in for the docker CLI that keeps volumes in a JSON file.
const fakeDocker = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_DOCKER_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const [kind, verb, name] = process.argv.slice(2);
if (kind === "volume" && verb === "create") state.push(name);
if (kind === "volume" && verb === "rm") state.splice(state.indexOf(process.argv.at(-1)), 1);
if (kind === "volume" && verb === "ls") console.log(state.join("\\n"));
writeFileSync(file, JSON.stringify(state));
`;

const dockerHook = (verb) =>
  `import { spawnSync } from "node:child_process";\nconst r = spawnSync("docker volume ${verb} " + process.env.NOOK_WORKSPACE + "-db", { stdio: "inherit", shell: true });\nprocess.exit(r.status ?? 1);\n`;

function setup(t, hooks) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const bin = join(root, "bin");
  write(bin, {
    "docker.mjs": fakeDocker,
    docker: `#!/bin/sh\nexec node "$(dirname "$0")/docker.mjs" "$@"\n`,
    "docker.cmd": '@echo off\r\nnode "%~dp0docker.mjs" %*\r\n',
  });
  if (process.platform !== "win32") chmodSync(join(bin, "docker"), 0o755);
  const repo = makeRepo(join(root, "demo"), hooks);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: join(root, "docker.json") };
  const run = (args) => nk(args, { cwd: repo, home, env });
  assert.equal(run(["init", "--yes"]).status, 0);
  return { root, home, repo, run, state: () => JSON.parse(readFileSync(env.FAKE_DOCKER_STATE, "utf8")) };
}

test("check passes when remove undoes create, and records the hooks", (t) => {
  const { home, run, state } = setup(t, { ".nook/create.mjs": dockerHook("create"), ".nook/remove.mjs": dockerHook("rm") });
  assert.match(run(["doctor"]).out, /not tested since changed/);
  assert.match(run(["hooks"]).out, /create .nook\/create\.mjs {2}allowed, not tested since it changed/);
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /The hooks passed/);
  assert.deepEqual(state(), []);
  const config = parse(readFileSync(join(home, "config.toml"), "utf8"));
  assert.deepEqual(Object.keys(config.repos.demo.checked).sort(), ["create.mjs", "remove.mjs"]);
  assert.doesNotMatch(run(["doctor"]).out, /not tested since changed/);
  assert.match(run(["hooks"]).out, /remove .nook\/remove\.mjs {2}allowed, tested/);
  assert.ok(!existsSync(join(home, "workspaces", "demo", "nook-hooks-test")));
});

test("check fails and names what remove left behind", (t) => {
  const { run } = setup(t, { ".nook/create.mjs": dockerHook("create") });
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /remove left a Docker volume: nook-hooks-test-db/);
});

test("check fails when open cannot run twice", (t) => {
  const { run } = setup(t, {
    ".nook/open.mjs": 'import { writeFileSync } from "node:fs";\nwriteFileSync("started.txt", "", { flag: "wx" });\n',
    ".gitignore": "started.txt\n",
  });
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /open, run a second time, failed/);
});

test("check runs the hooks of the folder it runs in, such as an agent's branch", (t) => {
  const { root, home, run } = setup(t, {});
  assert.equal(run(["-b", "setup-hooks"]).status, 0);
  const ws = join(home, "workspaces", "demo", "setup-hooks");
  write(ws, { ".nook/create.mjs": "console.log('branch hook ran')\n" });
  sh("git", ["add", "-A"], ws);
  sh("git", ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "hooks"], ws);
  const r = nk(["hooks", "test"], { cwd: ws, home, env: { PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: join(root, "docker.json") } });
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /branch hook ran/);
});
