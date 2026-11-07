import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  assert.equal(run(["init", "--yes"]).status, 0);
  const lines = [];
  const sink = { write: (text) => lines.push(text) };
  const ctx = () => createContext({ env: { ...process.env, NOOK_HOME: home }, cwd: repo, out: sink, err: sink });
  return { home, repo, run, lines, ctx, ws: (name) => join(home, "workspaces", "demo", name) };
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
