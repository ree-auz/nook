import assert from "node:assert/strict";
import test from "node:test";
import { blockers, identifierFromBranch, next, normalizeIdentifier, promptFor, rank, showLines, agentFromIssue } from "../integrations/linear/issues.mjs";
import { createLinear } from "../integrations/linear/linear-api.mjs";
import { main } from "../integrations/linear/nkl.mjs";
import { press } from "../src/select.mjs";

const state = (name, type) => ({ name, type });
const STARTED = state("In Progress", "started");
const TODO = state("Todo", "unstarted");
const DONE = state("Done", "completed");

function issue(identifier, more = {}) {
  return {
    identifier,
    title: `Title of ${identifier}`,
    url: `https://linear.app/ree/issue/${identifier.toLowerCase()}`,
    branchName: `ree-auz/${identifier.toLowerCase()}-work`,
    priority: 3,
    priorityLabel: "Medium",
    sortOrder: 0,
    state: TODO,
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
    relations: { nodes: [] },
    children: { nodes: [] },
    comments: { nodes: [] },
    ...more,
  };
}

const blockedBy = (...issues) => ({ nodes: issues.map((other) => ({ type: "blocks", issue: other })) });

test("an issue is blocked only by unfinished blockers", () => {
  const open = issue("REE-1");
  const closed = issue("REE-2", { state: DONE });
  assert.deepEqual(blockers(issue("REE-3", { inverseRelations: blockedBy(open, closed) })).map((b) => b.identifier), ["REE-1"]);
  assert.deepEqual(blockers(issue("REE-4", { inverseRelations: blockedBy(closed) })), []);
});

test("the list puts ready, started, current-cycle and urgent issues first", () => {
  const issues = [
    issue("REE-1", { inverseRelations: blockedBy(issue("REE-9")), priority: 1 }),
    issue("REE-2", { priority: 4 }),
    issue("REE-3", { priority: 0 }),
    issue("REE-4", { priority: 1 }),
    issue("REE-5", { state: STARTED, priority: 4 }),
    issue("REE-6", { priority: 4, cycle: { number: 3, isActive: true } }),
  ];
  assert.deepEqual(rank(issues).map((i) => i.identifier), ["REE-5", "REE-6", "REE-4", "REE-2", "REE-3", "REE-1"]);
  assert.equal(next(issues, (i) => ["REE-5", "REE-6"].includes(i.identifier)).identifier, "REE-4", "skips issues that have a workspace");
  assert.equal(next([issues[0]]), null, "nothing ready");
});

test("identifiers come from branch names and loose typing", () => {
  assert.equal(identifierFromBranch("ree-auz/ree-292-fix-safari"), "REE-292");
  assert.equal(identifierFromBranch("ree-292"), "REE-292");
  assert.equal(identifierFromBranch("feature/login"), null);
  assert.equal(normalizeIdentifier(" ree-12 "), "REE-12");
  assert.equal(normalizeIdentifier("show"), null);
});

test("a label group picks the agent", () => {
  const labelled = issue("REE-1", { labels: { nodes: [{ name: "Chore" }, { name: "Claude Code", parent: { name: "Agent" } }] } });
  assert.equal(agentFromIssue(labelled, "Agent"), "claude-code");
  assert.equal(agentFromIssue(labelled, "Model"), null);
  assert.equal(agentFromIssue(labelled, undefined), null);
});

test("the prompt carries the description, relations and latest comments", () => {
  const full = issue("REE-7", {
    description: "Fix the **export** button.\n\n![shot](https://uploads.linear.app/x.png)",
    project: { name: "Pipit" },
    parent: issue("REE-5", { state: STARTED }),
    inverseRelations: blockedBy(issue("REE-6")),
    relations: { nodes: [{ type: "blocks", relatedIssue: issue("REE-8") }, { type: "related", relatedIssue: issue("REE-9") }] },
    children: { nodes: [issue("REE-10", { state: DONE })] },
    comments: {
      nodes: Array.from({ length: 7 }, (_, n) => ({ body: `comment ${n}`, createdAt: `2026-11-0${n + 1}T00:00:00Z`, user: { name: "bana" } })).reverse(),
    },
  });
  const prompt = promptFor(full);
  assert.match(prompt, /^Work on Linear issue REE-7: Title of REE-7\n/);
  assert.match(prompt, /- Project: Pipit/);
  assert.match(prompt, /- Parent: REE-5 Title of REE-5 \(In Progress\)/);
  assert.match(prompt, /!\[shot\]\(https:\/\/uploads\.linear\.app\/x\.png\)/);
  assert.match(prompt, /## Blocked by \(unfinished\)\n\n- REE-6/);
  assert.match(prompt, /## Blocks\n\n- REE-8/);
  assert.match(prompt, /## Sub-issues\n\n- REE-10 Title of REE-10 \(Done\)/);
  assert.match(prompt, /related: REE-9/);
  assert.doesNotMatch(prompt, /comment 1\b/, "only the latest five comments");
  assert.ok(prompt.indexOf("comment 2") < prompt.indexOf("comment 6"), "oldest first");
});

test("nkl show lists blockers, with finished ones unmarked", () => {
  const text = showLines(issue("REE-3", { assignee: { name: "bana" }, inverseRelations: blockedBy(issue("REE-1"), issue("REE-2", { state: DONE })) })).join("\n");
  assert.match(text, /Assignee  bana/);
  assert.match(text, /Blocked by:\n! REE-1 .*\(Todo\)\n  REE-2 .*\(Done\)/);
});

test("Tab marks several rows when the list allows it", () => {
  const items = ["a", "b", "c"];
  let s = { query: "", at: "a", marked: [] };
  s = press(s, items, "\t", { name: "tab" });
  assert.deepEqual(s, { query: "", at: "b", marked: ["a"] });
  s = press(s, items, "\t", { name: "tab" });
  assert.deepEqual(press(s, items, "\r", { name: "return" }), { done: "c", marked: ["a", "b"] });
  assert.equal(press({ query: "", at: "a" }, items, "\t", { name: "tab" }).marked, undefined, "only with multi");
});

test("the API client sends the key as it is and asks only for unfinished issues", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: { issues: { nodes: [issue("REE-1")], pageInfo: { hasNextPage: false } } } }));
  };
  const linear = createLinear({ key: "lin_api_test", fetch });
  const issues = await linear.issues({ team: "ree", cycle: true });
  assert.equal(issues[0].identifier, "REE-1");
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(calls[0].init.headers.authorization, "lin_api_test");
  assert.deepEqual(calls[0].body.variables.filter, {
    state: { type: { nin: ["completed", "canceled"] } },
    assignee: { isMe: { eq: true } },
    team: { key: { eqIgnoreCase: "ree" } },
    cycle: { isActive: { eq: true } },
  });
  const rejected = createLinear({ key: "bad", fetch: async () => new Response(JSON.stringify({ errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] }), { status: 401 }) });
  await assert.rejects(rejected.issues(), /did not accept LINEAR_API_KEY/);
  assert.throws(() => createLinear({ key: "" }), /LINEAR_API_KEY is not set/);
});

/** Runs nkl with a fake Linear and records what it would start. */
async function nkl(argv, { issues = [], workspaces = [], env = {} } = {}) {
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  const started = [];
  const opened = [];
  const output = { out: "", err: "" };
  const stream = (key) => ({ write: (text) => (output[key] += text), isTTY: false });
  const linear = {
    issue: async (id) => byId.get(id) ?? Promise.reject(new Error(`no ${id}`)),
    issues: async () => issues,
    issuesById: async (ids) => new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)])),
  };
  const code = await main(argv, {
    env,
    linear,
    out: stream("out"),
    err: stream("err"),
    input: { isTTY: false },
    start: (spec) => (started.push(spec), 0),
    workspaces: () => workspaces,
    open: (terminal, args) => opened.push({ terminal, ...args }),
  });
  return { code, started, opened, ...output };
}

test("nkl <ISSUE> starts its branch with the prompt and the chosen agent", async () => {
  const labelled = issue("REE-5", { labels: { nodes: [{ name: "Claude", parent: { name: "Agent" } }] } });
  const plain = await nkl(["ree-5"], { issues: [labelled] });
  assert.equal(plain.code, 0, plain.err);
  assert.equal(plain.started[0].branch, "ree-auz/ree-5-work");
  assert.equal(plain.started[0].agent, "codex");
  assert.match(plain.started[0].prompt, /^Work on Linear issue REE-5/);
  assert.equal((await nkl(["REE-5"], { issues: [labelled], env: { NKL_AGENT_LABEL: "Agent" } })).started[0].agent, "claude");
  assert.equal((await nkl(["REE-5", "gemini", "--agent-label", "Agent"], { issues: [labelled] })).started[0].agent, "gemini", "the agent given wins");
});

test("a blocked issue starts after a warning when nobody can be asked", async () => {
  const blocked = issue("REE-2", { inverseRelations: blockedBy(issue("REE-1", { state: STARTED })) });
  const r = await nkl(["REE-2"], { issues: [blocked] });
  assert.equal(r.started.length, 1);
  assert.match(r.err, /REE-2 is blocked by REE-1 Title of REE-1 \(In Progress\)/);
});

test("nkl next starts the first ready issue without a workspace", async () => {
  const issues = [issue("REE-1", { state: STARTED }), issue("REE-2", { priority: 1 }), issue("REE-3", { inverseRelations: blockedBy(issue("REE-9")) })];
  const r = await nkl(["next"], { issues, workspaces: [{ name: "ree-auz-ree-1-work", branch: "ree-auz/ree-1-work", main: false }] });
  assert.equal(r.started[0].branch, "ree-auz/ree-2-work");
});

test("nkl ls shows each workspace's issue and flags closed ones not merged", async () => {
  const workspaces = [
    { name: "main", branch: "main", main: true },
    { name: "ree-auz-ree-1-work", branch: "ree-auz/ree-1-work", main: false, pr: { number: 3, state: "open" } },
    { name: "ree-auz-ree-2-work", branch: "ree-auz/ree-2-work", main: false, pr: null },
    { name: "spike", branch: "spike", main: false, pr: null },
  ];
  const r = await nkl(["ls"], { issues: [issue("REE-1", { state: STARTED }), issue("REE-2", { state: state("Canceled", "canceled") })], workspaces });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split("\n");
  assert.match(lines[0], /^NAME\s+ISSUE\s+STATUS\s+PR\s+TITLE$/);
  assert.match(lines[1], /^ree-auz-ree-1-work\s+REE-1\s+In Progress\s+#3 open\s+Title of REE-1$/);
  assert.match(lines[3], /^spike\s*$/);
  assert.match(r.err, /Closed in Linear but not merged: ree-auz-ree-2-work \(REE-2 Canceled\)/);
});

test("nkl without a terminal prints the ranked list", async () => {
  const r = await nkl([], { issues: [issue("REE-1", { priority: 4 }), issue("REE-2", { priority: 1 })] });
  assert.deepEqual(r.out.trim().split("\n").map((row) => row.split("\t")[0]), ["REE-2", "REE-1"]);
});

test("unknown words and missing issues fail clearly", async () => {
  assert.match((await nkl(["frobnicate"])).err, /"frobnicate" is not an issue like REE-292/);
  assert.match((await nkl(["show"])).err, /Which issue\? nkl show REE-292/);
  assert.equal((await nkl(["--bogus"])).code, 2);
});
