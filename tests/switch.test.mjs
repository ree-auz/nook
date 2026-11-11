import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { createContext } from "../src/context.mjs";
import { switchWorkspace } from "../src/commands/switch.mjs";
import { filter, fit, pick, press, width } from "../src/select.mjs";
import { makeRepo, nk, sh, tempDir } from "./helpers.mjs";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

/** A keyboard that is a terminal, with `keys` already typed. */
function keyboard(keys = "") {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, raw: [], setRawMode: (on) => input.raw.push(on) });
  input.write(keys);
  return input;
}

/** A screen that is a terminal and keeps what was written to it. */
function screen({ columns = 80, rows = 24 } = {}) {
  const written = [];
  return { isTTY: true, columns, rows, write: (text) => written.push(text), text: () => written.join(""), on() {}, off() {} };
}

function setup(t, workspaces = ["alpha", "beta", "gamma"]) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"));
  const cli = (args, cwd = repo) => nk(args, { cwd, home });
  assert.equal(cli(["init", "--yes"]).status, 0);
  for (const name of workspaces) assert.equal(cli(["-b", name]).status, 0);
  const io = (keys, cwd = repo) => {
    const out = [];
    const err = screen();
    return { env: { ...process.env, NOOK_HOME: home, NO_COLOR: "1" }, cwd, out: { write: (text) => out.push(text) }, err, in: keyboard(keys), printed: () => out.join("") };
  };
  return { root, home, repo, cli, io, ws: (name) => join(home, "workspace", "demo", name) };
}

test("filter takes every word, in any order and case", () => {
  const items = ["ree-281 fix login", "ree-284 Login page", "main"];
  const same = (text) => text;
  assert.deepEqual(filter(items, "", same), items);
  assert.deepEqual(filter(items, "LOGIN", same), items.slice(0, 2));
  assert.deepEqual(filter(items, "page ree", same), ["ree-284 Login page"]);
  assert.deepEqual(filter(items, "nothing", same), []);
});

test("width and fit count wide characters as two columns", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("工作区"), 6);
  assert.equal(fit("abcdef", 6), "abcdef");
  assert.equal(fit("abcdefg", 6), "abcde…");
  assert.equal(fit("工作区abc", 6), "工作…");
  assert.ok(width(fit("工作区abc", 6)) <= 6);
  assert.equal(fit("abcdefg", 6, "..."), "abc...");
});

test("press: arrows wrap around, typing filters, Enter needs a row", () => {
  const shown = ["a", "b", "c"];
  const state = { query: "", at: "a" };
  assert.equal(press(state, shown, undefined, { name: "down" }).at, "b");
  assert.equal(press(state, shown, undefined, { name: "up" }).at, "c");
  assert.equal(press({ query: "", at: "c" }, shown, undefined, { name: "n", ctrl: true }).at, "a");
  assert.deepEqual(press(state, shown, "x", { name: "x" }), { query: "x", at: "a" });
  assert.deepEqual(press({ query: "工作", at: "a" }, shown, undefined, { name: "backspace" }), { query: "工", at: "a" });
  assert.deepEqual(press({ query: "xy", at: "a" }, shown, undefined, { name: "u", ctrl: true }), { query: "", at: "a" });
  assert.deepEqual(press(state, shown, "\r", { name: "return" }), { done: "a" });
  // Nothing matches: Enter does nothing, it does not take a row that is not shown.
  const empty = { query: "zzz", at: undefined };
  assert.equal(press(empty, [], "\r", { name: "return" }), empty);
  assert.deepEqual(press(state, shown, undefined, { name: "escape" }), { cancelled: "escape" });
  assert.deepEqual(press(state, shown, "\x03", { name: "c", ctrl: true }), { cancelled: "interrupt" });
});

test("pick draws the list, follows the keys and leaves the terminal as it was", async () => {
  const items = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
  const options = { title: "choose", items, cells: (item) => ["+", item.name], text: (item) => item.name };

  let input = keyboard(`${DOWN}${DOWN}${UP}${ENTER}`);
  let output = screen();
  assert.deepEqual(await pick({ ...options, input, output }).result, { item: items[1] });
  assert.match(output.text(), /> \+ {2}alpha\n {2}\+ {2}beta/);
  assert.match(output.text(), /> \+ {2}beta/);
  // Raw mode is on while the list shows and off after; the cursor is hidden, then shown; the list is erased last.
  assert.deepEqual(input.raw, [true, false]);
  assert.ok(output.text().startsWith("\x1b[?25l"));
  assert.ok(output.text().endsWith("\x1b[J\x1b[?25h"));

  // Typing filters; the first row left is chosen.
  input = keyboard(`mm${ENTER}`);
  output = screen();
  assert.deepEqual(await pick({ ...options, input, output }).result, { item: items[2] });
  assert.match(output.text(), /choose {2}filter: mm {2}1 of 3/);

  // Nothing matches: Enter is ignored until the filter is cleared.
  input = keyboard(`zz${ENTER}\x7f\x7f${ENTER}`);
  output = screen();
  assert.deepEqual(await pick({ ...options, input, output }).result, { item: items[0] });
  assert.match(output.text(), /nothing matches "zz"/);

  assert.deepEqual(await pick({ ...options, input: keyboard(CTRL_C), output: screen() }).result, { cancelled: "interrupt" });
  assert.deepEqual(await pick({ ...options, input: keyboard(ESC), output: screen() }).result, { cancelled: "escape" });

  // With sides, Left and Right choose too; with keep, raw mode stays on for the next list.
  input = keyboard(`${DOWN}${RIGHT}`);
  output = screen();
  assert.deepEqual(await pick({ ...options, input, output, sides: true, keep: true, hint: (item) => `about ${item.name}` }).result, { item: items[1], side: 1 });
  assert.deepEqual(input.raw, [true]);
  assert.match(output.text(), /about beta\n.*←→ change/);
  assert.deepEqual(await pick({ ...options, input: keyboard(`${LEFT}${ENTER}`), output: screen() }).result, { item: items[0] }, "without sides, Left does nothing");
});

test("pick keeps the chosen row in sight in a short terminal and cuts long lines", async () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ name: `workspace-${String(i).padStart(2, "0")}-${"x".repeat(60)}` }));
  const output = screen({ columns: 40, rows: 10 });
  const input = keyboard(`${DOWN.repeat(9)}${ENTER}`);
  const picker = pick({ title: "choose", items, cells: (item) => ["+", item.name], text: (item) => item.name, input, output });
  assert.deepEqual(await picker.result, { item: items[9] });
  assert.match(output.text(), /… 11 more below/);
  assert.match(output.text(), /> \+ {2}workspace-09/);
  // A line longer than the terminal would wrap, and the next draw would start too low.
  const codes = new RegExp(`${ESC}\\[[0-9?]*[A-Za-z]`, "g");
  for (const line of output.text().replace(codes, "").split(/\r|\n/)) assert.ok(width(line) < 40, line);
});

test("nk switch <name> prints the folder and nothing else", (t) => {
  const { repo, cli, ws, root } = setup(t);
  const one = cli(["switch", "beta"]);
  assert.deepEqual({ status: one.status, out: one.out, err: one.err }, { status: 0, out: `${ws("beta")}\n`, err: "" });
  // From inside another workspace, and the main checkout by its branch name.
  assert.equal(cli(["switch", "alpha"], ws("gamma")).out, `${ws("alpha")}\n`);
  assert.equal(cli(["switch", "main"], ws("gamma")).out, `${repo}\n`);
  // Outside every repository the name is looked for in all of them.
  assert.equal(cli(["switch", "beta"], root).out, `${ws("beta")}\n`);
  assert.equal(cli(["switch", "beta", "--repo", "demo"], root).out, `${ws("beta")}\n`);

  const none = cli(["switch", "nope"]);
  assert.equal(none.status, 1);
  assert.equal(none.out, "");
  assert.match(none.err, /No workspace named "nope"/);
  assert.match(cli(["switch", "nope"], root).err, /No workspace named "nope" in any registered repository/);
  assert.match(cli(["switch", "a", "b"]).err, /Usage: nk switch/);
  // The word is a command now, so it cannot name a new workspace.
  assert.match(cli(["-b", "switch"]).err, /is a nk command/);
});

test("nk switch <name> outside a repository asks for --repo when two have the name", (t) => {
  const { root, home, ws } = setup(t, ["same"]);
  const other = makeRepo(join(root, "other"));
  assert.equal(nk(["init", "--yes"], { cwd: other, home }).status, 0);
  assert.equal(nk(["-b", "same"], { cwd: other, home }).status, 0);
  const result = nk(["switch", "same"], { cwd: root, home });
  assert.equal(result.status, 1);
  assert.equal(result.out, "");
  assert.match(result.err, /"same" is in several repositories: demo, other/);
  assert.equal(nk(["switch", "same", "--repo", "demo"], { cwd: root, home }).out, `${ws("same")}\n`);
  assert.equal(nk(["switch", "same"], { cwd: other, home }).out, `${join(home, "workspace", "other", "same")}\n`);
});

test("nk switch without a terminal does not wait: it says to pass a name", (t) => {
  const { cli } = setup(t, ["alpha"]);
  const result = cli(["switch"]);
  assert.equal(result.status, 1);
  assert.equal(result.out, "");
  assert.match(result.err, /needs a terminal/);
  assert.match(result.err, /nk switch <name>/);
});

test("nk switch shows the list on stderr and prints only the chosen folder on stdout", async (t) => {
  const { repo, io, ws } = setup(t);

  // The list is in the order of nk ls; the main checkout is where we are, so alpha is chosen at first.
  let terminal = io(ENTER);
  assert.equal(await switchWorkspace(createContext(terminal), { input: terminal.in, prs: false }), 0);
  assert.equal(terminal.printed(), `${ws("alpha")}\n`);
  assert.match(terminal.err.text(), /nk switch · demo/);
  assert.match(terminal.err.text(), / {2}@ {2}main {3}clean\n> \+ {2}alpha {2}clean\n {2}\+ {2}beta {3}clean\n {2}\+ {2}gamma {2}clean\n/);

  // From inside alpha, the first row (the main checkout) is chosen at first; typing finds another.
  terminal = io(ENTER, ws("alpha"));
  assert.equal(await switchWorkspace(createContext(terminal), { input: terminal.in, prs: false }), 0);
  assert.equal(terminal.printed(), `${repo}\n`);
  terminal = io(`gam${ENTER}`, ws("alpha"));
  assert.equal(await switchWorkspace(createContext(terminal), { input: terminal.in, prs: false }), 0);
  assert.equal(terminal.printed(), `${ws("gamma")}\n`);

  // Leaving prints no folder and is not a success, so a shell function does not cd.
  terminal = io(ESC);
  assert.equal(await switchWorkspace(createContext(terminal), { input: terminal.in, prs: false }), 1);
  assert.equal(terminal.printed(), "");
  terminal = io(CTRL_C);
  assert.equal(await switchWorkspace(createContext(terminal), { input: terminal.in, prs: false }), 130);
  assert.equal(terminal.printed(), "");

  // Through the command line parser too.
  terminal = io(`${DOWN}${ENTER}`);
  assert.equal(await run(["switch"], terminal), 0);
  assert.equal(terminal.printed(), `${ws("beta")}\n`);
});

test("nk switch does not wait for GitHub: PRs are added when they come, and no longer asked for after the choice", async (t) => {
  const { repo, io, ws, cli } = setup(t);
  sh("git", ["init", "-q", "--bare", join(repo, "..", "origin.git")], repo);
  sh("git", ["remote", "add", "origin", join(repo, "..", "origin.git")], repo);
  assert.equal(cli(["ls", "--no-pr"]).status, 0);

  // GitHub answers: the row gains its PR while the list is open.
  let terminal = io();
  let asked;
  const answer = new Promise((done) => (asked = done));
  const prs = new Map([["beta", { number: 7, state: "open", head: "h", url: "u", ci: "passed" }]]);
  const lookup = (path, env, { signal }) => answer.then(() => ({ prs, signal }));
  const running = switchWorkspace(createContext(terminal), { input: terminal.in, prs: lookup });
  await new Promise((done) => setTimeout(done, 300));
  assert.match(terminal.err.text(), /beta {3}clean\n/);
  assert.doesNotMatch(terminal.err.text(), /#7/);
  asked();
  await new Promise((done) => setTimeout(done, 50));
  assert.match(terminal.err.text(), /beta {3}clean · #7 open passed\n/);
  terminal.in.write(ENTER);
  assert.equal(await running, 0);
  assert.equal(terminal.printed(), `${ws("alpha")}\n`);

  // GitHub never answers: the choice is made all the same, and the request is stopped.
  terminal = io(`${DOWN}${ENTER}`);
  let stopped;
  const never = (path, env, { signal }) => new Promise(() => (stopped = signal));
  assert.equal(await switchWorkspace(createContext(terminal), { input: terminal.in, prs: never }), 0);
  assert.equal(terminal.printed(), `${ws("beta")}\n`);
  assert.equal(stopped.aborted, true);

  // GitHub fails: the list is as without it.
  terminal = io(ENTER);
  assert.equal(await switchWorkspace(createContext(terminal), { input: terminal.in, prs: async () => ({ error: "gh is not logged in" }) }), 0);
  assert.equal(terminal.printed(), `${ws("alpha")}\n`);
  assert.doesNotMatch(terminal.err.text(), /logged in/);
});
