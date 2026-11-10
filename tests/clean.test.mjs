import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createContext } from "../src/context.mjs";
import { cleanWorkspaces } from "../src/commands/clean.mjs";
import { deleteWorkspace } from "../src/commands/rm.mjs";
import { NookError } from "../src/errors.mjs";
import { inspectWorkspace } from "../src/backup.mjs";
import { listWorkspaces } from "../src/commands/ls.mjs";
import { doctorWorkspace } from "../src/commands/doctor-workspace.mjs";
import { ciState, parsePrList } from "../src/forge.mjs";
import { makeRepo, nk, sh, tempDir, write } from "./helpers.mjs";

const commit = (dir, message) =>
  sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qam", message], dir);

test("sums up a PR's checks", () => {
  assert.equal(ciState([]), "no-ci");
  assert.equal(ciState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "passed");
  assert.equal(ciState([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "running");
  assert.equal(ciState([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failed");
  assert.equal(ciState([{ state: "PENDING" }]), "running");
});

test("keeps the newest PR per branch", () => {
  const prs = parsePrList(
    JSON.stringify([
      { number: 9, state: "OPEN", headRefName: "a", headRefOid: "x", url: "u9", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
      { number: 3, state: "MERGED", headRefName: "a", headRefOid: "y", url: "u3", statusCheckRollup: [] },
      { number: 4, state: "MERGED", headRefName: "b", headRefOid: "z", url: "u4", statusCheckRollup: [] },
    ]),
  );
  assert.deepEqual(prs.get("a"), { number: 9, state: "open", head: "x", url: "u9", ci: "passed" });
  assert.equal(prs.get("b").state, "merged");
});

function setup(t) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"), { ".gitignore": "*.log\n" });
  sh("git", ["init", "-q", "--bare", join(root, "origin.git")], root);
  sh("git", ["remote", "add", "origin", join(root, "origin.git")], repo);
  sh("git", ["push", "-q", "origin", "main"], repo);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes", "--allow-hooks"]).status, 0);
  const lines = [];
  const sink = { write: (text) => lines.push(text) };
  const ctx = () => createContext({ env: { ...process.env, NOOK_HOME: home }, cwd: repo, out: sink, err: sink });
  return { home, repo, run, lines, ctx, ws: (name) => join(home, "workspace", "demo", name) };
}

test("clean removes merged workspaces and keeps the rest", async (t) => {
  const { repo, run, lines, ctx, ws } = setup(t);
  for (const name of ["squashed", "extra", "dirty", "open", "fresh", "old"]) assert.equal(run(["-b", name]).status, 0);
  // Work that a squash merge brought into main: the branch is no ancestor of main.
  for (const name of ["squashed", "extra", "dirty"]) {
    write(ws(name), { [`${name}.txt`]: "work\n" });
    sh("git", ["add", "-A"], ws(name));
    commit(ws(name), name);
  }
  const head = (name) => sh("git", ["rev-parse", "HEAD"], ws(name));
  const prs = new Map([
    ["squashed", { number: 1, state: "merged", head: head("squashed"), ci: null }],
    ["extra", { number: 2, state: "merged", head: head("extra"), ci: null }],
    ["dirty", { number: 3, state: "merged", head: head("dirty"), ci: null }],
    ["open", { number: 4, state: "open", head: head("open"), ci: "running" }],
  ]);
  write(ws("extra"), { "later.txt": "after the merge\n" });
  sh("git", ["add", "-A"], ws("extra"));
  commit(ws("extra"), "later");
  write(ws("dirty"), { "README.md": "# edited\n" });
  const lookup = async () => ({ prs });
  const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const c = ctx();
  // "old" is a day old with nothing of its own; "fresh" is just as empty but new.
  c.config.repos.demo.workspaces.fresh.created = new Date(now).toISOString();
  c.save();

  assert.equal(await cleanWorkspaces(c, { dryRun: true, prs: lookup, now }), 0);
  let text = lines.join("");
  assert.match(text, /squashed \(demo\)\s+PR #1 merged/);
  assert.match(text, /old \(demo\)\s+merged into origin\/main/);
  assert.match(text, /extra \(demo\): has commits that are not in PR #2/);
  assert.match(text, /dirty \(demo\): 1 uncommitted change/);
  assert.doesNotMatch(text, /open \(demo\)|fresh \(demo\)/);
  assert.ok(existsSync(ws("squashed")), "dry run removes nothing");

  lines.length = 0;
  const no = { confirm: async () => false };
  await assert.rejects(cleanWorkspaces(ctx(), { prs: lookup, now, prompter: no }), /Nothing was removed/);
  assert.ok(existsSync(ws("squashed")));

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: ws("old"), stdio: "ignore" });
  t.after(() => child.kill());
  const exited = new Promise((done) => child.once("exit", done));
  await new Promise((done) => setTimeout(done, 500));
  lines.length = 0;
  assert.equal(await cleanWorkspaces(ctx(), { yes: true, prs: lookup, now }), 0);
  assert.match(lines.join(""), new RegExp(`${child.pid} node \\(old\\)`));
  await exited;
  for (const name of ["squashed", "old"]) {
    assert.ok(!existsSync(ws(name)), `${name} removed`);
    assert.equal(sh("git", ["branch", "--list", name], repo), "");
  }
  for (const name of ["extra", "dirty", "open", "fresh"]) assert.ok(existsSync(ws(name)), `${name} kept`);

  lines.length = 0;
  assert.equal(await listWorkspaces(ctx(), { prs: lookup }), 0);
  text = lines.join("");
  assert.match(text, /open\s+demo\s+\d+-\d+\s+clean\s+#4 open running/);
  assert.match(text, /extra\s+demo\s+\d+-\d+\s+clean\s+↑2\s+#2 merged/);
  assert.match(text, /Showing 4 workspaces and the main checkout, 1 with changes, 2 merged/);

  lines.length = 0;
  assert.equal(await listWorkspaces(ctx(), { json: true, prs: async () => ({ error: "gh is not logged in" }) }), 0);
  const data = JSON.parse(lines.join(""));
  assert.deepEqual(data.map((item) => item.name).sort(), ["dirty", "extra", "fresh", "main", "open"]);
  assert.equal(data.find((item) => item.name === "main").main, true);
  assert.equal(data.find((item) => item.name === "dirty").changes, 1);
});

test("clean deletes folders a removal left behind, and nothing else", async (t) => {
  const { lines, ctx, ws, run } = setup(t);
  assert.equal(run(["-b", "keep"]).status, 0);
  // What Windows can leave after git worktree remove: ignored folders such as node_modules.
  write(ws("half-removed"), { "node_modules/pkg/index.js": "x\n", "apps/web/node_modules/a.js": "x\n" });
  const noDocker = () => ({ ok: false, out: "", err: "not installed" });
  const lookup = async () => ({ prs: new Map() });

  assert.equal(await cleanWorkspaces(ctx(), { dryRun: true, prs: lookup, docker: noDocker }), 0);
  assert.match(lines.join(""), /Left from earlier removals[^]*half-removed/);
  assert.ok(existsSync(ws("half-removed")), "dry run removes nothing");

  lines.length = 0;
  assert.equal(await cleanWorkspaces(ctx(), { yes: true, prs: lookup, docker: noDocker }), 0);
  assert.ok(!existsSync(ws("half-removed")), "the leftover folder is deleted");
  assert.ok(existsSync(ws("keep")), "a workspace is not a leftover");
  assert.match(run(["doctor"]).out, /No problems found/);

  // A folder somebody put there holds files nk does not know: it is named and kept.
  write(ws("my-notes"), { "docs/todo.md": "important\n", "node_modules/pkg/index.js": "x\n" });
  lines.length = 0;
  assert.equal(await cleanWorkspaces(ctx(), { yes: true, prs: lookup, docker: noDocker }), 0);
  assert.match(lines.join(""), /my-notes: not a workspace, and it holds files nk does not know \(docs\/todo\.md\)/);
  assert.doesNotMatch(lines.join(""), /Left from earlier removals/);
  assert.ok(existsSync(join(ws("my-notes"), "docs", "todo.md")));
  assert.match(run(["doctor"]).out, /my-notes is not a workspace, and it holds files nk does not know \(docs\/todo\.md\); nk clean leaves it/);
});

/** A merged PR for each workspace, at its current HEAD. */
const mergedPrs = (ws, names) => new Map(names.map((name, i) => [name, { number: i + 1, state: "merged", head: sh("git", ["rev-parse", "HEAD"], ws(name)), ci: null }]));

test("clean removes a merged workspace nk made together with the files git ignores", async (t) => {
  const { repo, run, lines, ctx, ws } = setup(t);
  for (const name of ["generated", "data", "source"]) {
    assert.equal(run(["-b", name]).status, 0);
    write(ws(name), { ".gitignore": "*.log\nlocal.db\ndata/\nnext-env.d.ts\nplaywright-report/\n", "apps/web/page.js": "export {};\n" });
    sh("git", ["add", "-A"], ws(name));
    commit(ws(name), "ignore development files");
  }
  write(ws("generated"), { "apps/web/next-env.d.ts": "// generated\n" });
  write(ws("data"), { "local.db": "rows\n", "data/rows.json": "{}\n", "playwright-report/index.html": "x\n", "next-env.d.ts": "// generated\n", "debug.log": "x\n" });
  // A new file git does not ignore is work, whatever else is in the folder.
  write(ws("source"), { "local.db": "rows\n", "src/new.js": "export {};\n" });
  const prs = mergedPrs(ws, ["generated", "data", "source"]);
  const lookup = async () => ({ prs });

  assert.equal(await cleanWorkspaces(ctx(), { dryRun: true, prs: lookup }), 0);
  let text = lines.join("");
  assert.match(text, /Deleted with them, not backed up \(development files git ignores\):/);
  assert.match(text, /generated: apps\/web\/next-env\.d\.ts/);
  assert.match(text, /data: data\/, local\.db, next-env\.d\.ts, playwright-report\//);
  assert.match(text, /source \(demo\): 1 uncommitted change/);
  for (const name of ["generated", "data", "source"]) assert.ok(existsSync(ws(name)), "dry run removes nothing");

  lines.length = 0;
  assert.equal(await cleanWorkspaces(ctx(), { yes: true, prs: lookup }), 0);
  for (const name of ["generated", "data"]) {
    assert.ok(!existsSync(ws(name)), `${name} removed`);
    assert.equal(sh("git", ["branch", "--list", name], repo), "");
  }
  assert.ok(existsSync(join(ws("source"), "src", "new.js")), "-y does not remove a workspace with new work");
});

test("clean keeps a merged worktree nk did not make when ignored files would be lost", async (t) => {
  const { repo, lines, ctx, home } = setup(t);
  const other = join(home, "..", "elsewhere");
  const tree = (name) => join(other, name);
  for (const name of ["with-data", "plain"]) {
    sh("git", ["worktree", "add", "-q", "-b", name, tree(name)], repo);
    write(tree(name), { ".gitignore": "*.log\nlocal.db\n" });
    sh("git", ["add", ".gitignore"], tree(name));
    commit(tree(name), "ignore the database");
  }
  write(tree("with-data"), { "local.db": "rows\n" });
  const prs = mergedPrs(tree, ["with-data", "plain"]);
  assert.equal(await cleanWorkspaces(ctx(), { yes: true, prs: async () => ({ prs }) }), 0);
  assert.match(lines.join(""), /with-data \(demo\): not made by nk, and files git ignores would be lost: local\.db \(nk rm with-data to remove anyway\)/);
  assert.ok(existsSync(join(tree("with-data"), "local.db")));
  assert.ok(!existsSync(tree("plain")), "a merged worktree with nothing to lose is removed as before");
});

test("clean keeps a workspace whose folder git cannot read", async (t) => {
  const { run, lines, ctx, ws } = setup(t);
  for (const name of ["broken", "fine"]) assert.equal(run(["-b", name]).status, 0);
  // A removal that stopped halfway: the folder and the work in it remain, its .git is gone.
  write(ws("broken"), { "wip.txt": "not committed\n" });
  rmSync(join(ws("broken"), ".git"));
  const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const lookup = async () => ({ prs: new Map() });

  assert.equal(await cleanWorkspaces(ctx(), { yes: true, prs: lookup, now }), 0);
  const text = lines.join("");
  assert.match(text, /broken \(demo\): git cannot read the folder, so changes in it are unknown/);
  assert.ok(existsSync(join(ws("broken"), "wip.txt")), "the work is still there");
  assert.ok(!existsSync(ws("fine")), "the other merged workspace is still removed");
});

test("rm repairs a workspace git cannot read, then backs up and removes it", (t) => {
  const { home, repo, run, ws } = setup(t);
  for (const name of ["broken", "other"]) assert.equal(run(["-b", name]).status, 0);
  // A removal that stopped halfway: the folders and the work in them remain, their .git files are gone.
  for (const name of ["broken", "other"]) {
    write(ws(name), { "wip.txt": `${name} work\n` });
    rmSync(join(ws(name), ".git"));
  }
  assert.match(run(["ls"]).out, /broken\s+demo\s+\d+-\d+\s+unreadable/);
  const checked = run(["doctor"]);
  assert.equal(checked.status, 1);
  assert.match(checked.out, /workspace broken: git cannot read [^\n]*gitdir file points to non-existent location[^\n]*nk rm broken repairs it/);

  let r = run(["rm", "broken", "-n"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /git cannot read [^\n]*broken[^\n]*nk rm repairs the link/);
  assert.ok(!existsSync(join(ws("broken"), ".git")), "a dry run repairs nothing");

  r = run(["rm", "broken", "-y"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /Repaired the link between/);
  assert.ok(!existsSync(ws("broken")));
  const backups = join(home, "backup", "demo");
  const [saved] = readdirSync(backups);
  assert.equal(readFileSync(join(backups, saved, "untracked", "wip.txt"), "utf8"), "broken work\n");
  // Removing one workspace does not drop git's record of the other, which was as unreadable.
  assert.match(sh("git", ["worktree", "list", "--porcelain"], repo), /branch refs\/heads\/other(\n|$)/);
  assert.equal(readFileSync(join(ws("other"), "wip.txt"), "utf8"), "other work\n");
});

test("rm stops at a folder git has no record of", (t) => {
  const { repo, run, ws } = setup(t);
  assert.equal(run(["-b", "orphan"]).status, 0);
  write(ws("orphan"), { "wip.txt": "work\n" });
  rmSync(join(ws("orphan"), ".git"));
  sh("git", ["worktree", "prune"], repo);

  const r = run(["rm", "orphan", "-y"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /is no longer a git worktree: git has no record of it/);
  assert.match(r.err, /delete the folder, then run nk rm orphan again/);
  assert.ok(existsSync(join(ws("orphan"), "wip.txt")), "nothing was deleted");
  assert.match(run(["doctor"]).out, /workspace orphan: [^\n]*is no longer a git worktree/);

  // Once the person has deleted the folder, rm drops the record and the branch.
  rmSync(ws("orphan"), { recursive: true });
  assert.equal(run(["rm", "orphan", "-y"]).status, 0);
  assert.equal(sh("git", ["branch", "--list", "orphan"], repo), "");
  assert.match(run(["doctor"]).out, /No problems found/);
});

test("doctor --workspace says what a removal touches and what clean would do", async (t) => {
  const { run, lines, ctx, ws } = setup(t);
  for (const name of ["merged", "dirty", "open", "broken"]) {
    assert.equal(run(["-b", name]).status, 0);
    write(ws(name), { ".gitignore": "*.log\nlocal.db\n" });
    sh("git", ["add", ".gitignore"], ws(name));
    commit(ws(name), "ignore the database");
  }
  write(ws("merged"), { "local.db": "rows\n" });
  write(ws("dirty"), { "new.js": "export {};\n" });
  const prs = mergedPrs(ws, ["merged", "dirty"]);
  prs.set("open", { number: 7, state: "open", head: sh("git", ["rev-parse", "HEAD"], ws("open")), ci: "running" });
  rmSync(join(ws("broken"), ".git"));
  const noDocker = () => ({ ok: false, out: "", err: "not installed" });
  const check = async (name, options = {}) => {
    lines.length = 0;
    const status = await doctorWorkspace(ctx(), { name, prs: async () => ({ prs }), docker: noDocker, ...options });
    return { status, text: lines.join("") };
  };

  let r = await check("merged");
  assert.equal(r.status, 0);
  assert.match(r.text, /Workspace merged \(demo\)/);
  assert.match(r.text, /made by nk/);
  assert.match(r.text, /changes: none/);
  assert.match(r.text, /PR #1 merged/);
  assert.match(r.text, /programs: none running in it/);
  assert.match(r.text, /deleted with the workspace, not backed up \(git ignores them\): local\.db/);
  assert.match(r.text, /nk clean removes it: PR #1 merged/);

  r = await check("dirty");
  assert.match(r.text, /changes: 1 uncommitted change/);
  assert.match(r.text, /nk clean keeps it: 1 uncommitted change/);

  r = await check("open");
  assert.match(r.text, /PR #7 open, CI running/);
  assert.match(r.text, /nk clean leaves it: PR #7 is open/);

  // Docker that answers: a project of this workspace alone, and one shared with another folder.
  const docker = (args) => {
    if (args[0] === "container") return { ok: true, out: `c1\tmerged\t${ws("merged")}\nc2\tprod\t${ws("merged")}\nc3\tprod\t/srv/app\n`, err: "" };
    return { ok: true, out: args[0] === "volume" ? "v1\n" : "", err: "" };
  };
  r = await check("merged", { docker });
  assert.match(r.text, /Compose project merged: 1 container, 1 volume; it belongs to this workspace alone and is removed with it/);
  assert.match(r.text, /Compose project prod also has containers outside this workspace; it is kept/);

  r = await check("broken");
  assert.equal(r.status, 1);
  assert.match(r.text, /git cannot read [^\n]*broken \(gitdir file points to non-existent location\)/);
  assert.match(r.text, /Next: nk rm broken repairs the link first/);
  assert.ok(!existsSync(join(ws("broken"), ".git")), "doctor repairs nothing");

  const cli = run(["doctor", "--workspace", "dirty"]);
  assert.equal(cli.status, 0, cli.all);
  assert.match(cli.out, /Workspace dirty \(demo\)/);
  assert.equal(run(["doctor", "--workspace", "nope"]).status, 1);
  for (const name of ["merged", "dirty", "open", "broken"]) assert.ok(existsSync(ws(name)), "doctor removes nothing");
});

test("a removal that cannot delete the folder says where it stands", async (t) => {
  const { home, repo, run, ctx, ws } = setup(t);
  assert.equal(run(["-b", "held"]).status, 0);
  write(ws("held"), { "wip.txt": "work\n" });
  const c = ctx();
  const target = { repoName: "demo", repo: c.config.repos.demo, name: "held", ws: c.config.repos.demo.workspaces.held };
  const state = inspectWorkspace({ repo, path: ws("held"), branch: "held", base: "origin/main" });
  // What Windows does while a program holds the folder: git removes its record, the folder stays.
  // A scan that finds nobody the first time (before deleting) and a holder afterwards.
  // A scan that finds nobody before deleting, and a holder afterwards.
  let calls = 0;
  const scan = () => (calls++ ? { processes: [{ pid: 4242, name: "pwsh", reasons: ["working directory"] }], inaccessible: 3 } : { processes: [] });
  const remove = (path) => {
    throw new NookError(`Could not delete ${path}: EBUSY\nClose what uses it and run the command again`);
  };
  await assert.rejects(
    deleteWorkspace(c, target, { state, base: "origin/main", backupRoot: join(home, "backup", "demo"), prompter: {}, scan, remove, docker: () => ({ ok: false, out: "", err: "not installed" }) }),
    (error) => {
      assert.match(error.message, /Could not delete/);
      assert.match(error.message, /Running in it:\n\s+pwsh \(PID 4242\)/);
      assert.match(error.message, /sees working directories only, not open files; 3 processes could not be looked at/);
      assert.match(error.message, /Already done: changes backed up to [^;]+; git no longer lists the worktree\./);
      assert.match(error.message, /Not done: the folder, branch held and nk's record are still there, so nk rm held can finish/);
      return true;
    },
  );
  const kept = ctx().config.repos.demo.workspaces.held;
  assert.ok(kept, "nk still knows the workspace, so nk rm can finish");
  assert.equal(sh("git", ["branch", "--list", "held"], repo).trim(), "held");
});

test("clean says when it cannot check for running programs", async (t) => {
  const { run, lines, ctx } = setup(t);
  for (const name of ["one", "two"]) assert.equal(run(["-b", name]).status, 0);
  const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const scan = () => ({ processes: [], unsupported: "lsof not found" });
  assert.equal(await cleanWorkspaces(ctx(), { dryRun: true, prs: async () => ({ prs: new Map() }), now, scan }), 0);
  assert.equal(lines.join("").match(/Could not check for running programs: lsof not found/g)?.length, 1, "said once, not per workspace");
});
