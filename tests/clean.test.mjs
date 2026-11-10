import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createContext } from "../src/context.mjs";
import { cleanWorkspaces } from "../src/commands/clean.mjs";
import { listWorkspaces } from "../src/commands/ls.mjs";
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
