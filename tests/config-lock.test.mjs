import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { applyChanges, withLockSync } from "../src/config.mjs";
import { createContext } from "../src/context.mjs";
import { tempDir } from "./helpers.mjs";

test("a save keeps what another nk recorded meanwhile", (t) => {
  const home = tempDir(t);
  const env = { NOOK_HOME: home };
  const a = createContext({ env });
  const b = createContext({ env });
  a.config.repos.one = { path: "/one", workspaces: { x: { path: "/one/x", port: 20000 } }, hooks: {} };
  a.save();
  b.config.repos.two = { path: "/two", workspaces: {}, hooks: {} };
  b.save();
  const disk = parse(readFileSync(join(home, "config.toml"), "utf8"));
  assert.deepEqual(Object.keys(disk.repos).sort(), ["one", "two"]);
  assert.equal(b.config.repos.one.workspaces.x.port, 20000, "b now sees a's workspace too");

  delete a.config.repos.one.workspaces.x;
  a.save();
  assert.deepEqual(Object.keys(parse(readFileSync(join(home, "config.toml"), "utf8")).repos.one.workspaces), [], "a removal is saved");
});

test("applyChanges carries additions, changes and removals at any depth", () => {
  const base = { repos: { r: { workspaces: { a: { port: 1 }, b: { port: 2 } } } } };
  const current = { repos: { r: { workspaces: { a: { port: 1 }, c: { port: 3 } } } } };
  const disk = { repos: { r: { workspaces: { a: { port: 1 }, b: { port: 2 }, d: { port: 4 } } }, s: {} } };
  assert.deepEqual(applyChanges(base, current, disk), { repos: { r: { workspaces: { a: { port: 1 }, c: { port: 3 }, d: { port: 4 } } }, s: {} } });
});

test("ten nk updating at once each get their own ports", async (t) => {
  const home = tempDir(t);
  const script = `
    import { createContext } from ${JSON.stringify(new URL("../src/context.mjs", import.meta.url).href)};
    import { allocatePort } from ${JSON.stringify(new URL("../src/ports.mjs", import.meta.url).href)};
    const ctx = createContext({ env: { NOOK_HOME: process.env.NOOK_HOME } });
    await ctx.update(async (config) => {
      config.repos.r ??= { path: "/r", workspaces: {}, hooks: {} };
      const port = await allocatePort(config, { isFree: async () => { await new Promise((r) => setTimeout(r, 5)); return true; } });
      config.repos.r.workspaces["w" + process.argv[1]] = { path: "/r/w", port };
    });
  `;
  const runs = Array.from({ length: 10 }, (_, i) =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(i)], { env: { ...process.env, NOOK_HOME: home }, stdio: "inherit" });
      child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`exit ${code}`))));
    }),
  );
  await Promise.all(runs);
  const ports = Object.values(parse(readFileSync(join(home, "config.toml"), "utf8")).repos.r.workspaces).map((ws) => ws.port);
  assert.equal(ports.length, 10, "no workspace was written over");
  assert.equal(new Set(ports).size, 10, "no two share a port block");
});

test("a lock left by a killed nk is taken over", (t) => {
  const file = join(tempDir(t), "config.toml");
  mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  assert.equal(withLockSync(file, () => 7), 7);
  assert.ok(!existsSync(`${file}.lock`));
});
