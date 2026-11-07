import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { makeRepo, nk, sh, tempDir, write } from "./helpers.mjs";
import { setupPrompt } from "../src/commands/write-hooks.mjs";

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
  return { root, home, repo, ws: join(home, "workspace", "demo", "smoke") };
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

  assert.equal(run(["-b", "仓库"]).status, 1, "nothing usable left after normalizing");
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

  assert.equal(run(["Smoke"]).out.trim(), ws, "names are normalized when opening too");
  assert.equal(readFileSync(join(ws, "hook-open.txt"), "utf8").trim().split(/\r?\n/).length, 2);
  r = run(["smoke", "node", "-p", "do the task", "--", "-e", agentScript]);
  assert.equal(r.status, 0, r.all);
  const agent = JSON.parse(readFileSync(join(ws, "agent.txt"), "utf8"));
  assert.deepEqual(agent, { args: ["do the task"], ws: "smoke", port });
  assert.equal(readFileSync(join(ws, "hook-open.txt"), "utf8").trim().split(/\r?\n/).length, 3);

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
  r = run(["rm", "smoke"]);
  assert.equal(r.status, 1, "asks for confirmation; no terminal means no removal");
  assert.match(r.err, new RegExp(`${child.pid} node`));
  assert.ok(existsSync(ws));

  const exited = new Promise((done) => child.once("exit", done));
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
  await exited;
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
  assert.match(r.err, /create: \.nook\/create\.mjs \(changed\)/);
  assert.match(r.err, /need your OK/);

  assert.equal(run(["init", "--yes"]).status, 0, "init allows the new version");
  const ws = join(home, "workspace", "demo", "failing");
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
  assert.ok(existsSync(join(home, "workspace", "demo", "keep")));
});

test("the old workspaces folder is renamed to workspace and git follows", (t) => {
  const { home, repo } = setup(t);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  const made = run(["-b", "old"]);
  assert.equal(made.status, 0, made.all);
  // Put things back the way nk before 0.1 kept them.
  const oldWs = join(home, "workspaces", "demo", "old");
  renameSync(join(home, "workspace"), join(home, "workspaces"));
  sh("git", ["worktree", "repair", oldWs], repo);
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, readFileSync(configPath, "utf8").replaceAll(join(home, "workspace").replaceAll("\\", "\\\\"), join(home, "workspaces").replaceAll("\\", "\\\\")));

  const r = run(["old"]);
  assert.equal(r.status, 0, r.all);
  assert.equal(r.out.trim(), join(home, "workspace", "demo", "old"));
  assert.ok(!existsSync(join(home, "workspaces")));
  assert.equal(sh("git", ["status", "--short"], r.out.trim()), "");
  assert.equal(run(["rm", "old", "-y"]).status, 0);
});

test("-b turns any branch text into a workspace name", (t) => {
  const { home, repo } = setup(t);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  const r = run(["-b", "REE-12-修复登录/Login"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /Using the name ree-12-login/);
  assert.equal(r.out.trim(), join(home, "workspace", "demo", "ree-12-login"));
  assert.equal(sh("git", ["branch", "--show-current"], r.out.trim()), "ree-12-login");
  assert.equal(run(["rm", "REE-12-修复登录/Login", "-y"]).status, 0);
});

test("a converted name can be edited before the workspace is created", async (t) => {
  const { createContext } = await import("../src/context.mjs");
  const { createWorkspace } = await import("../src/commands/workspace.mjs");
  const { home, repo } = setup(t);
  assert.equal(nk(["init", "--yes"], { cwd: repo, home }).status, 0);
  const sink = { write() {} };
  const ctx = createContext({ env: { ...process.env, NOOK_HOME: home }, cwd: repo, out: sink, err: sink });
  const offered = [];
  const prompter = { interactive: true, edit: async (_q, initial) => (offered.push(initial), "Fix Login") };
  assert.equal(await createWorkspace(ctx, { name: "REE-12-修复登录", prompter }), 0);
  assert.deepEqual(offered, ["ree-12"]);
  assert.ok(existsSync(join(home, "workspace", "demo", "fix-login")));
  assert.equal(nk(["rm", "fix-login", "-y"], { cwd: repo, home }).status, 0);
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

test("an old branch without .nook still gets the hooks; a branch with / keeps its name", (t) => {
  const { home, repo } = setup(t);
  const run = (args) => nk(args, { cwd: repo, home });
  const git = (args) => sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], repo);
  git(["checkout", "-q", "-b", "feat/Login"]);
  git(["rm", "-rq", ".nook"]);
  git(["commit", "-qm", "before hooks existed"]);
  git(["checkout", "-q", "main"]);
  assert.equal(run(["init", "--yes"]).status, 0);

  const r = run(["-b", "feat/Login"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /Using the name feat-login for branch feat\/Login/);
  const ws = r.out.trim();
  assert.equal(ws, join(home, "workspace", "demo", "feat-login"));
  assert.equal(sh("git", ["branch", "--show-current"], ws), "feat/Login");
  assert.ok(!existsSync(join(ws, ".nook")), "the branch has no hooks of its own");
  assert.ok(existsSync(join(ws, "hook-create.txt")), "the repository's hooks ran");
  assert.equal(parse(readFileSync(join(home, "config.toml"), "utf8")).repos.demo.workspaces["feat-login"].branch, "feat/Login");
  assert.equal(JSON.parse(run(["ls", "--json"]).out).find((item) => !item.main).branch, "feat/Login");
  assert.equal(run(["doctor"]).status, 0);
  write(join(home, "workspace", "demo", "half-removed"), { "left.txt": "x\n" });
  const checked = run(["doctor"]);
  assert.equal(checked.status, 0, "a leftover folder is a warning, not a problem");
  assert.match(checked.out, /half-removed is not a workspace, only a leftover folder \(nk clean deletes it\)/);
  assert.match(checked.out, /No problems found, \d+ warning/);

  const removed = run(["rm", "feat-login", "-y"]);
  assert.equal(removed.status, 0, removed.all);
  assert.match(removed.all, /remove hook for feat-login/);
  assert.equal(sh("git", ["branch", "--list", "feat/Login"], repo), "");
});

test("init again keeps the shared files you filled in", (t) => {
  const { home, repo } = setup(t);
  assert.equal(nk(["init", "--yes"], { cwd: repo, home }).status, 0);
  const shared = join(home, "shared", "demo", ".env");
  write(join(home, "shared", "demo"), { ".env": "API_KEY=filled\n" });
  const r = nk(["init", "--yes"], { cwd: repo, home });
  assert.equal(r.status, 0, r.all);
  assert.equal(readFileSync(shared, "utf8"), "API_KEY=filled\n");
  assert.match(r.err, /Kept shared files: \.env/);
});

test("worktrees made by other tools are listed and removable; the main checkout is not", (t) => {
  const { root, home, repo } = setup(t);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  const other = join(root, "orca", "REE-228");
  sh("git", ["worktree", "add", "-q", "-b", "ree-auz/REE-228", other, "main"], repo);
  const locked = join(root, "orca", "kept");
  sh("git", ["worktree", "add", "-q", "-b", "kept", locked, "main"], repo);
  sh("git", ["worktree", "lock", locked], repo);

  const data = JSON.parse(run(["ls", "--json"]).out);
  const outside = data.find((item) => item.path === other);
  assert.equal(outside.name, "ree-auz-ree-228");
  assert.equal(outside.branch, "ree-auz/REE-228");
  assert.equal(outside.managed, false);
  assert.equal(data.find((item) => item.main).path, repo);
  assert.equal(data.find((item) => item.path === locked).locked, true);

  assert.equal(run(["main"]).out.trim(), repo, "nk main opens the main checkout");
  let r = run(["rm", "main", "-y"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /main checkout/);
  r = run(["rm", "kept", "-y"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /locked/);
  r = run(["rm", "ree-228", "-y"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /remove hook for ree-auz-ree-228/);
  assert.ok(!existsSync(other));
  assert.equal(sh("git", ["branch", "--list", "ree-auz/REE-228"], repo), "");
  sh("git", ["worktree", "unlock", locked], repo);
});

test("a changed remove hook is approved before any program is stopped", async (t) => {
  const { home, repo } = setup(t);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  const created = run(["-b", "busy"]);
  assert.equal(created.status, 0, created.all);
  const ws = created.out.trim();
  write(repo, { ".nook/remove.mjs": "console.log('new remove hook')\n" });
  sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qam", "change remove hook"], repo);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: ws, stdio: "ignore" });
  t.after(() => child.kill());
  await new Promise((done) => setTimeout(done, 500));

  const r = run(["rm", "busy", "-y"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /need your OK/);
  assert.doesNotMatch(r.err, /Stopped/);
  assert.equal(child.exitCode, null, "the program is still running");
  assert.ok(existsSync(ws));
  // Stop it before the temp folder is deleted: Windows cannot delete a folder a process runs in.
  const exited = new Promise((done) => child.once("exit", done));
  child.kill();
  await exited;
});

test("outside a repository nothing is created or removed unless --repo names one", (t) => {
  const { root, home, repo } = setup(t);
  const other = makeRepo(join(root, "other"));
  const elsewhere = join(root, "elsewhere");
  write(elsewhere, { "note.txt": "not a repository\n" });
  assert.equal(nk(["init", "--yes"], { cwd: repo, home }).status, 0);

  let r = nk(["-b", "smoke"], { cwd: elsewhere, home });
  assert.equal(r.status, 1, "even with only one repository registered");
  assert.match(r.err, /Not inside a registered repository/);
  assert.equal(nk(["-b", "smoke"], { cwd: other, home }).status, 1, "a repository nk does not know");
  assert.equal(nk(["-b", "smoke", "--repo", "demo"], { cwd: elsewhere, home }).status, 0);

  assert.equal(nk(["rm", "smoke", "-y"], { cwd: elsewhere, home }).status, 1);
  assert.equal(nk(["clean", "-n"], { cwd: elsewhere, home }).status, 1);
  assert.match(nk(["ls"], { cwd: elsewhere, home }).out, /smoke/, "ls only reads, so it lists every repository");
  r = nk(["rm", "smoke", "-y"], { cwd: repo, home });
  assert.equal(r.status, 0, r.all);
});

test("-b -y keeps the converted name without asking", (t) => {
  const { home, repo } = setup(t);
  assert.equal(nk(["init", "--yes"], { cwd: repo, home }).status, 0);
  const r = nk(["-b", "ree-9-修复：Login", "-y"], { cwd: repo, home });
  assert.equal(r.status, 0, r.all);
  assert.match(r.out, /ree-9-login$/m);
});

test("rm removes several workspaces after one check of all of them", (t) => {
  const { home, repo } = setup(t);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  for (const name of ["one", "two", "three"]) assert.equal(run(["-b", name]).status, 0);

  let r = run(["rm", "one", "missing", "-y"]);
  assert.equal(r.status, 1, "an unknown name stops everything");
  assert.match(r.err, /No workspace named "missing"/);
  assert.ok(existsSync(join(home, "workspace", "demo", "one")), "nothing removed before every name checked out");

  r = run(["rm", "one", "two", "-y"]);
  assert.equal(r.status, 0, r.all);
  assert.ok(!existsSync(join(home, "workspace", "demo", "one")));
  assert.ok(!existsSync(join(home, "workspace", "demo", "two")));
  assert.ok(existsSync(join(home, "workspace", "demo", "three")));
});

test("the agent's prompt carries what nk knows and never reads out values", (t) => {
  const { home, repo } = setup(t);
  write(repo, { "pnpm-lock.yaml": "", "compose.yaml": "services: {}\n", ".github/workflows/ci.yml": "on: push\n" });
  sh("git", ["add", "-A"], repo);
  sh("git", ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "markers"], repo);
  write(join(home, "shared", "demo"), { ".env": "API_KEY=\nDB_PASSWORD=secret-value\n" });
  const ctx = { paths: { shared: join(home, "shared") } };
  const generated = { written: ["create.mjs"], plan: { source: ".github/workflows/ci.yml", job: "test", untranslated: [{ step: "deploy key", why: "uses a CI expression" }] } };
  const prompt = setupPrompt(ctx, { repoName: "demo", repo: { path: repo }, generated });
  assert.match(prompt, /nk already wrote \.nook\/create\.mjs from \.github\/workflows\/ci\.yml \(job test\)/);
  assert.match(prompt, /- deploy key: uses a CI expression/);
  assert.match(prompt, /CI configuration:\n- \.github\/workflows\/ci\.yml/);
  assert.match(prompt, /- compose\.yaml\n- pnpm-lock\.yaml/);
  assert.match(prompt, /\.env \(empty: API_KEY\)/);
  assert.doesNotMatch(prompt, /secret-value/);
});

test("forget keeps the repository's workspaces until nk rm, then removes its registration and shared files", (t) => {
  const { home, repo, run } = setupForget(t);
  assert.equal(run(["-b", "feat"]).status, 0);
  let r = run(["forget", "-y"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /still has workspaces: feat[^]*nk rm feat --repo demo/);
  assert.equal(run(["rm", "feat", "-y"]).status, 0);
  r = run(["forget", "-y"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /Deletes the shared files/);
  assert.ok(!existsSync(join(home, "shared", "demo")), "shared files deleted");
  assert.ok(existsSync(join(repo, "README.md")), "the repository folder stays");
  assert.equal(parse(readFileSync(join(home, "config.toml"), "utf8")).repos?.demo, undefined);
  assert.equal(run(["init", "--yes"]).status, 0, "it can be registered again");
});

test("forget a repository whose folder is gone deletes what its workspaces left", (t) => {
  const { root, home, repo, run } = setupForget(t);
  assert.equal(run(["-b", "feat"]).status, 0);
  rmSync(repo, { recursive: true, force: true });
  const r = nk(["forget", "demo", "-y"], { cwd: root, home });
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /which no longer exists/);
  assert.ok(!existsSync(join(home, "workspace", "demo")), "the orphaned workspace folder is deleted");
  assert.equal(parse(readFileSync(join(home, "config.toml"), "utf8")).repos?.demo, undefined);
});

function setupForget(t) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"), { ".gitignore": ".env\n", ".env.example": "KEY=\n" });
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  assert.ok(existsSync(join(home, "shared", "demo")));
  return { root, home, repo, run };
}

test("init points a template's Compose service addresses at this machine", (t) => {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"), {
    ".gitignore": ".env\n",
    "docker-compose.yml": "services:\n  postgres: { image: postgres, ports: ['127.0.0.1:5432:5432'] }\n  redis: { image: redis, ports: ['${REDIS_PORT:-6380}:6379'] }\n  app: { build: ., ports: ['3000:3000'] }\n",
    ".env.sample": "DATABASE_URL=postgres://user:pass@postgres:5432/app\nREDIS_URL=redis://redis:6379\nAPP_URL=http://app:3000\nSECRET_KEY=\n",
  });
  const r = nk(["init", "--yes"], { cwd: repo, home });
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /Pointed DATABASE_URL, REDIS_URL in \.env at the Compose services on this machine/);
  assert.equal(
    readFileSync(join(home, "shared", "demo", ".env"), "utf8"),
    "DATABASE_URL=postgres://user:pass@127.0.0.1:5432/app\nREDIS_URL=redis://127.0.0.1:6380\nAPP_URL=http://app:3000\nSECRET_KEY=\n",
    "only services nk starts; the app built from the repository is not one",
  );
});
