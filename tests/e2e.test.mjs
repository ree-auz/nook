import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { makeRepo, nk, sh, tempDir, write } from "./helpers.mjs";

const agentScript =
  "require('fs').writeFileSync('agent.txt', JSON.stringify({ args: process.argv.slice(1), ws: process.env.NOOK_WORKSPACE, port: process.env.NOOK_PORT }))";

function setup(t) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"), {
    ".gitignore": ".env\nhook-*.txt\nagent.txt\n",
    ".env.example": "API_KEY=\n",
    ".nook/create.mjs": [
      'import { writeFileSync } from "node:fs";',
      "const { NOOK_WORKSPACE, NOOK_PORT, NOOK_REPO, NOOK_SHARED } = process.env;",
      'writeFileSync("hook-create.txt", [NOOK_WORKSPACE, NOOK_PORT, NOOK_REPO, NOOK_SHARED].join("\\n"));',
      "",
    ].join("\n"),
    ".nook/open.sh": "echo open-sh >> hook-open.txt\n",
    ".nook/open.cmd": "@echo off\r\necho open-cmd>> hook-open.txt\r\n",
    ".nook/remove.mjs": "console.log('remove hook for ' + process.env.NOOK_WORKSPACE)\n",
  });
  write(repo, { ".env": "API_KEY=fake-production-value\n" });
  return { root, home, repo, ws: join(home, "workspaces", "demo", "smoke") };
}

test("init -> -b -> open -> rm", async (t) => {
  const { home, repo, ws } = setup(t);
  const run = (args, cwd = repo) => nk(args, { cwd, home });

  let r = run(["init", "--yes"]);
  assert.equal(r.status, 0, r.all);
  const config = parse(readFileSync(join(home, "config.toml"), "utf8"));
  assert.equal(config.repos.demo.default_branch, "main");
  assert.deepEqual(Object.keys(config.repos.demo.hooks).sort(), process.platform === "win32" ? ["create.mjs", "open.cmd", "remove.mjs"] : ["create.mjs", "open.sh", "remove.mjs"]);
  assert.equal(readFileSync(join(home, "shared", "demo", ".env"), "utf8"), "API_KEY=\n", "starts from the template, not the repository .env");

  assert.equal(run(["-b", "Bad/Name"]).status, 1);
  assert.equal(run(["-b", "ls"]).status, 1);

  r = run(["-b", "smoke"]);
  assert.equal(r.status, 0, r.all);
  assert.equal(r.out.trim(), ws);
  assert.equal(readFileSync(join(ws, ".env"), "utf8"), "API_KEY=\n");
  const [name, port, repoPath, shared] = readFileSync(join(ws, "hook-create.txt"), "utf8").split("\n");
  assert.equal(name, "smoke");
  assert.equal(Number(port) % 10, 0);
  assert.equal(repoPath, repo);
  assert.equal(shared, join(home, "shared", "demo"));
  assert.match(readFileSync(join(ws, "hook-open.txt"), "utf8"), /open-(sh|cmd)/);
  assert.equal(sh("git", ["branch", "--show-current"], ws), "smoke");
  assert.equal(run(["-b", "smoke"]).status, 1, "cannot create twice");

  r = run(["smoke", "node", "-p", "do the task", "--", "-e", agentScript]);
  assert.equal(r.status, 0, r.all);
  const agent = JSON.parse(readFileSync(join(ws, "agent.txt"), "utf8"));
  assert.deepEqual(agent, { args: ["do the task"], ws: "smoke", port });
  assert.equal(readFileSync(join(ws, "hook-open.txt"), "utf8").trim().split(/\r?\n/).length, 2);

  r = run(["ls"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.out, /smoke\s+demo\s+\d+-\d+\s+clean/);
  r = run(["doctor"]);
  assert.equal(r.status, 0, r.all);

  // Uncommitted work, an unpushed commit, and a program inside the folder.
  write(ws, { "README.md": "# changed\n", "notes.txt": "draft\n" });
  assert.match(run(["ls"]).out, /2 changed/);

  r = run(["rm", "smoke", "-y"], ws);
  assert.equal(r.status, 1);
  assert.match(r.err, /You are inside/);

  r = run(["rm", "smoke", "-n"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /2 uncommitted/);
  assert.ok(existsSync(ws));

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: ws, stdio: "ignore" });
  t.after(() => child.kill());
  await new Promise((done) => setTimeout(done, 500));
  r = run(["rm", "smoke", "-y"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /still using/);
  assert.match(r.err, new RegExp(`PID ${child.pid}`));
  assert.ok(existsSync(ws));
  child.kill();
  await new Promise((done) => child.once("exit", done));

  r = run(["rm", "smoke"]);
  assert.equal(r.status, 1, "asks for confirmation; no terminal means no removal");
  assert.ok(existsSync(ws));

  r = run(["rm", "smoke", "-y"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /remove hook for smoke/);
  assert.ok(!existsSync(ws));
  assert.equal(sh("git", ["branch", "--list", "smoke"], repo), "");
  const [backup] = readdirSync(join(home, "backup", "demo"));
  assert.match(backup, /^smoke-\d{8}-\d{4}$/);
  assert.match(readFileSync(join(home, "backup", "demo", backup, "changes.patch"), "utf8"), /# changed/);
  assert.equal(readFileSync(join(home, "backup", "demo", backup, "untracked", "notes.txt"), "utf8"), "draft\n");
  assert.ok(readdirSync(join(home, "logs")).some((file) => file.startsWith("demo-smoke-remove-")));
  assert.equal(parse(readFileSync(join(home, "config.toml"), "utf8")).repos.demo.workspaces.smoke, undefined);
});

test("a changed hook needs a new OK; a failing create hook keeps the workspace", (t) => {
  const { home, repo } = setup(t);
  const run = (args, cwd = repo) => nk(args, { cwd, home });
  assert.equal(run(["init", "--yes"]).status, 0);

  write(repo, { ".nook/create.mjs": "process.exit(4)\n" });
  sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qam", "change hook"], repo);
  let r = run(["-b", "changed"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /Changed hook \.nook\/create\.mjs/);
  assert.match(r.err, /needs your OK/);

  assert.equal(run(["init", "--yes"]).status, 0, "init allows the new version");
  const ws = join(home, "workspaces", "demo", "failing");
  r = run(["-b", "failing", "node", "--", "-e", agentScript]);
  assert.equal(r.status, 4, r.all);
  assert.match(r.err, /create\.mjs failed \(exit 4\)/);
  assert.match(r.err, /kept/);
  assert.ok(existsSync(ws));
  assert.ok(!existsSync(join(ws, "agent.txt")), "agent does not start after a failed hook");
  assert.equal(run(["rm", "failing", "-y"]).status, 0);
});

test("a failing remove hook stops the removal", (t) => {
  const { home, repo } = setup(t);
  write(repo, { ".nook/remove.mjs": "process.exit(2)\n" });
  sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qam", "fail remove"], repo);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  assert.equal(run(["-b", "keep"]).status, 0);
  const r = run(["rm", "keep", "-y"]);
  assert.equal(r.status, 2, r.all);
  assert.match(r.err, /nothing was deleted/);
  assert.ok(existsSync(join(home, "workspaces", "demo", "keep")));
});

test("init adopts nothing by default and keeps settings on a second run", (t) => {
  const { root, home, repo } = setup(t);
  sh("git", ["worktree", "add", "-q", "-b", "elsewhere", join(root, "elsewhere"), "main"], repo);
  assert.equal(nk(["init", "--yes", "--name", "demo"], { cwd: repo, home }).status, 0);
  const second = nk(["init", "--yes"], { cwd: repo, home });
  assert.equal(second.status, 0, second.all);
  assert.match(second.err, /elsewhere/);
  const config = parse(readFileSync(join(home, "config.toml"), "utf8"));
  assert.deepEqual(Object.keys(config.repos), ["demo"]);
  assert.equal(Object.keys(config.repos.demo.workspaces).length, 0);
});
