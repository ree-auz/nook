import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { candidates } from "../src/commands/complete.mjs";
import { createContext } from "../src/context.mjs";
import { SUBCOMMANDS } from "../src/names.mjs";
import { makeRepo, nk, tempDir } from "./helpers.mjs";

function setup(t) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const repo = makeRepo(join(root, "demo"));
  const other = makeRepo(join(root, "other"));
  assert.equal(nk(["init", "--yes"], { cwd: repo, home }).status, 0);
  assert.equal(nk(["init", "--yes"], { cwd: other, home }).status, 0);
  for (const name of ["alpha", "beta"]) assert.equal(nk(["-b", name], { cwd: repo, home }).status, 0);
  assert.equal(nk(["-b", "gamma"], { cwd: other, home }).status, 0);
  const ctx = (cwd) => {
    const made = createContext({ env: { ...process.env, NOOK_HOME: home }, cwd, out: { write() {} }, err: { write() {} } });
    made.config.agents = { codex: { path: "codex", args: [] }, claude: { path: "claude", args: [] } };
    return made;
  };
  return { root, home, repo, other, ctx };
}

test("completion offers what can come next, and only that", (t) => {
  const { root, repo, other, ctx } = setup(t);
  const at = (before, current = "", cwd = repo) => candidates(ctx(cwd), before, current);
  const commands = SUBCOMMANDS.filter((name) => name !== "help" && name !== "version");

  // First word: the workspaces of this repository (nk <name> opens one) and the commands.
  assert.deepEqual(at([]), ["main", "alpha", "beta", ...commands]);
  assert.deepEqual(at([], "s"), ["switch", "shell-init"]);
  assert.deepEqual(at([], "al"), ["alpha"]);
  // In the other repository, its own; outside both, all of them.
  assert.deepEqual(at(["switch"], "", other), ["main", "gamma"]);
  assert.deepEqual(at(["switch"], "", root), ["main", "alpha", "beta", "gamma"]);
  assert.deepEqual(at(["switch", "--repo", "other"], "", root), ["main", "gamma"]);

  assert.deepEqual(at(["switch"]), ["main", "alpha", "beta"]);
  assert.deepEqual(at(["switch", "alpha"]), []);
  // rm never takes the main checkout, and not a name twice.
  assert.deepEqual(at(["rm"]), ["alpha", "beta"]);
  assert.deepEqual(at(["rm", "alpha"]), ["beta"]);
  assert.deepEqual(at(["doctor", "--workspace"], "b"), ["beta"]);
  assert.deepEqual(at(["ls", "--repo"]), ["demo", "other"]);
  assert.deepEqual(at(["forget"], "o"), ["other"]);
  assert.deepEqual(at(["hooks"]), ["write", "test"]);
  assert.deepEqual(at(["hooks", "write"]), ["codex", "claude"]);
  assert.deepEqual(at(["shell-init"], "p"), ["powershell"]);
  // After a workspace: an agent. After -b: a new name, which nothing can complete; then an agent.
  assert.deepEqual(at(["alpha"]), ["codex", "claude"]);
  assert.deepEqual(at(["-b"]), []);
  assert.deepEqual(at(["-b", "new"], "c"), ["codex", "claude"]);
  assert.deepEqual(at(["alpha", "codex", "-p"]), []);

  // Options of the command, when the word starts with "-".
  assert.deepEqual(at(["ls"], "--"), ["--json", "--no-pr", "--timing", "--repo"]);
  assert.deepEqual(at(["rm", "alpha"], "--d"), ["--dry-run"]);
  assert.deepEqual(at([], "--v"), ["--version"]);
  assert.deepEqual(at(["init"]), []);
  assert.deepEqual(at(["clean"]), []);
});

test("every option completion offers is one the command takes", async (t) => {
  const { repo, home } = setup(t);
  for (const command of ["init", "ls", "switch", "shell-init", "rm", "clean", "hooks", "forget", "doctor"]) {
    const options = candidates(createContext({ env: { ...process.env, NOOK_HOME: home }, cwd: repo, out: { write() {} }, err: { write() {} } }), [command], "-");
    assert.ok(options.length, command);
    for (const option of options) {
      // --help after the option: the parser has read the option by then, and nothing runs.
      const result = nk([command, option, "--definitely-not-an-option"], { cwd: repo, home });
      assert.match(result.err, /Unknown option '--definitely-not-an-option'|argument missing|ambiguous/, `${command} ${option}: ${result.err}`);
    }
  }
});

test("nk __complete prints one word a line and never an error", async (t) => {
  const { root, repo, home } = setup(t);
  const asked = (args, cwd = repo) => nk(["__complete", ...args], { cwd, home });
  assert.deepEqual(asked(["=sw"]), { status: 0, out: "switch\n", err: "", all: "switch\n" });
  assert.equal(asked(["=", "rm"]).out, "alpha\nbeta\n");
  assert.equal(asked(["=zz"]).all, "");
  assert.equal(asked([]).status, 0);
  // Words that look like options of nk are words of the line being completed.
  assert.equal(asked(["=--j", "ls", "--repo", "demo"]).out, "--json\n");
  // No repository registered at all, and an unknown --repo: nothing, quietly.
  assert.deepEqual(nk(["__complete", "=", "switch"], { cwd: root, home: join(root, "empty-home") }), { status: 0, out: "", err: "", all: "" });
  assert.equal(asked(["=", "switch", "--repo", "nope"]).all, "");
  const out = [];
  assert.equal(await run(["__complete", "=be", "switch"], { env: { ...process.env, NOOK_HOME: home }, cwd: repo, out: { write: (text) => out.push(text) }, err: { write() {} } }), 0);
  assert.equal(out.join(""), "beta\n");
});
