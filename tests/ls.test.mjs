import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createContext } from "../src/context.mjs";
import { listWorkspaces } from "../src/commands/ls.mjs";
import { githubPrs, parsePrList } from "../src/forge.mjs";
import { gitRun } from "../src/git.mjs";
import { localState } from "../src/status.mjs";
import { makeRepo, nk, sh, tempDir, write } from "./helpers.mjs";

const commit = (dir, message) =>
  sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", message], dir);

function setup(t) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"));
  sh("git", ["init", "-q", "--bare", join(root, "origin.git")], root);
  sh("git", ["remote", "add", "origin", join(root, "origin.git")], repo);
  sh("git", ["push", "-q", "origin", "main"], repo);
  const run = (args) => nk(args, { cwd: repo, home });
  assert.equal(run(["init", "--yes"]).status, 0);
  const out = [];
  const err = [];
  const ctx = () => createContext({ env: { ...process.env, NOOK_HOME: home }, cwd: repo, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) } });
  return { root, home, repo, run, out, err, ctx, ws: (name) => join(home, "workspace", "demo", name) };
}

test("the open PRs' checks and the list of all PRs make one answer", () => {
  const open = JSON.stringify([
    { number: 9, state: "OPEN", headRefName: "a", headRefOid: "x", url: "u9", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
    { number: 12, state: "OPEN", headRefName: "quiet", headRefOid: "q", url: "u12", statusCheckRollup: [] },
  ]);
  const all = JSON.stringify([
    { number: 12, state: "OPEN", headRefName: "quiet", headRefOid: "q", url: "u12" },
    { number: 11, state: "MERGED", headRefName: "b", headRefOid: "z", url: "u11" },
    { number: 10, state: "CLOSED", headRefName: "a", headRefOid: "w", url: "u10" },
    { number: 9, state: "OPEN", headRefName: "a", headRefOid: "x", url: "u9" },
    { number: 8, state: "OPEN", headRefName: "far", headRefOid: "f", url: "u8" },
  ]);
  for (const prs of [parsePrList(open, all), parsePrList(all, open)]) {
    // The newest PR of a branch wins, whichever list it came from.
    assert.deepEqual(prs.get("a"), { number: 10, state: "closed", head: "w", url: "u10", ci: null });
    assert.deepEqual(prs.get("b"), { number: 11, state: "merged", head: "z", url: "u11", ci: null });
    // Asked and none: no-ci. Not asked (an open PR beyond the first list): no word, not "no-ci".
    assert.equal(prs.get("quiet").ci, "no-ci");
    assert.equal(prs.get("far").ci, null);
  }
});

test("githubPrs asks for checks of open PRs only", async (t) => {
  const dir = tempDir(t);
  const log = join(dir, "calls.txt");
  write(dir, {
    "gh.mjs": `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, args.join(" ") + "\\n");
const open = args[args.indexOf("--state") + 1] === "open";
const pr = (number, state, branch) => ({ number, state, headRefName: branch, headRefOid: "h" + number, url: "u" + number, ...(open ? { statusCheckRollup: [{ status: "IN_PROGRESS" }] } : {}) });
console.log(JSON.stringify(open ? [pr(5, "OPEN", "work")] : [pr(5, "OPEN", "work"), pr(4, "MERGED", "done")]));
`,
    gh: '#!/bin/sh\nexec node "$(dirname "$0")/gh.mjs" "$@"\n',
    "gh.cmd": '@ECHO off\r\nnode "%~dp0\\gh.mjs" %*\r\n',
  });
  if (process.platform !== "win32") chmodSync(join(dir, "gh"), 0o755);
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GH_LOG: log };
  const { prs, error } = await githubPrs(dir, env);
  assert.equal(error, undefined);
  assert.deepEqual(prs.get("work"), { number: 5, state: "open", head: "h5", url: "u5", ci: "running" });
  assert.deepEqual(prs.get("done"), { number: 4, state: "merged", head: "h4", url: "u4", ci: null });
  const calls = readFileSync(log, "utf8").trim().split("\n").sort();
  assert.equal(calls.length, 2);
  assert.match(calls[0], /--state all .*--json number,state,headRefName,headRefOid,url$/);
  assert.match(calls[1], /--state open .*statusCheckRollup$/);
});

test("githubPrs gives the error when one of its requests fails", async (t) => {
  const dir = tempDir(t);
  write(dir, {
    "gh.mjs": `if (process.argv.includes("open")) { console.log("[]"); } else { console.error("gh: To get started with GitHub CLI, please run: gh auth login"); process.exit(4); }\n`,
    gh: '#!/bin/sh\nexec node "$(dirname "$0")/gh.mjs" "$@"\n',
    "gh.cmd": '@ECHO off\r\nnode "%~dp0\\gh.mjs" %*\r\n',
  });
  if (process.platform !== "win32") chmodSync(join(dir, "gh"), 0o755);
  const result = await githubPrs(dir, { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` });
  assert.deepEqual(result, { error: "gh is not logged in (run gh auth login)" });
});

test("githubPrs stops when its caller no longer needs the answer", async (t) => {
  const dir = tempDir(t);
  write(dir, {
    "gh.mjs": `setTimeout(() => console.log("[]"), 2000);\n`,
    gh: '#!/bin/sh\nexec node "$(dirname "$0")/gh.mjs" "$@"\n',
    "gh.cmd": '@ECHO off\r\nnode "%~dp0\\gh.mjs" %*\r\n',
  });
  if (process.platform !== "win32") chmodSync(join(dir, "gh"), 0o755);
  const stop = new AbortController();
  const started = Date.now();
  const asked = githubPrs(dir, { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` }, { signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  const result = await asked;
  assert.match(result.error, /^gh failed: /);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test("gitRun and localState read a workspace without blocking", async (t) => {
  const { repo, run, ws } = setup(t);
  assert.equal(run(["-b", "work"]).status, 0);
  write(ws("work"), { "a.txt": "a\n" });
  sh("git", ["add", "-A"], ws("work"));
  commit(ws("work"), "a");
  write(ws("work"), { "b.txt": "b\n", "c.txt": "c\n" });

  const ok = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ws("work") });
  assert.deepEqual({ ok: ok.ok, status: ok.status, out: ok.out }, { ok: true, status: 0, out: "work" });
  const bad = await gitRun(["rev-parse", "--verify", "--quiet", "refs/heads/none"], { cwd: repo });
  assert.equal(bad.ok, false);
  const nowhere = await gitRun(["status"], { cwd: join(repo, "no-such-folder") });
  assert.equal(nowhere.ok, false);

  assert.deepEqual(await localState(repo, ws("work"), "work", "origin/main"), { changes: 2, commits: { ahead: 1, behind: 0 } });
  // The main checkout has no branch to compare; a branch that does not exist has no counts.
  assert.deepEqual(await localState(repo, repo, null, "origin/main"), { changes: 0, commits: null });
  assert.deepEqual(await localState(repo, ws("work"), "none", "origin/main"), { changes: 2, commits: null });
  assert.deepEqual(await localState(repo, join(repo, "no-such-folder"), "work", "origin/main"), { changes: null, commits: { ahead: 1, behind: 0 } });
});

test("ls reads many workspaces, keeps their order and the --json fields", async (t) => {
  const { run, out, ctx, ws } = setup(t);
  const names = Array.from({ length: 8 }, (_, i) => `w${i}`);
  for (const name of names) assert.equal(run(["-b", name]).status, 0);
  write(ws("w3"), { "new.txt": "x\n" });
  write(ws("w6"), { "one.txt": "x\n", "two.txt": "x\n" });
  const prs = new Map([["w5", { number: 5, state: "open", head: "h", url: "u", ci: "passed" }]]);

  assert.equal(await listWorkspaces(ctx(), { json: true, prs: async () => ({ prs }) }), 0);
  const data = JSON.parse(out.join(""));
  assert.deepEqual(
    data.map((item) => item.name),
    ["main", ...names],
  );
  // Scripts and agents read these: none may go or change its meaning.
  for (const item of data)
    assert.deepEqual(Object.keys(item), ["name", "branch", "main", "managed", "locked", "repo", "path", "port", "base", "changes", "ahead", "behind", "pr"]);
  assert.deepEqual(
    data.map((item) => item.changes),
    [0, 0, 0, 0, 1, 0, 0, 2, 0],
  );
  assert.deepEqual(data[0], { ...data[0], main: true, ahead: null, behind: null, pr: null });
  assert.deepEqual(data[6], { ...data[6], name: "w5", ahead: 0, behind: 0, pr: prs.get("w5") });
});

test("ls --no-pr does not ask GitHub; --timing reports on stderr only", async (t) => {
  const { run, out, err, ctx } = setup(t);
  assert.equal(run(["-b", "work"]).status, 0);
  const never = () => assert.fail("GitHub was asked");

  assert.equal(await listWorkspaces(ctx(), { json: true, "no-pr": true, timing: true, prs: never }), 0);
  const data = JSON.parse(out.join(""));
  assert.equal(data.find((item) => item.name === "work").pr, null);
  assert.match(err.join(""), /Took \d+ ms: git \d+ ms\n/);
  assert.doesNotMatch(err.join(""), /GitHub|No PR status/);

  out.length = err.length = 0;
  assert.equal(await listWorkspaces(ctx(), { timing: true, prs: async () => ({ error: "gh is not logged in" }) }), 0);
  assert.match(err.join(""), /Took \d+ ms: git \d+ ms, GitHub \d+ ms/);
  assert.match(err.join(""), /No PR status: gh is not logged in/);
  assert.doesNotMatch(out.join(""), /Took/);

  // Through the command line too.
  const cli = run(["ls", "--no-pr", "--json"]);
  assert.equal(cli.status, 0);
  assert.equal(JSON.parse(cli.out).length, 2);
});
