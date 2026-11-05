import assert from "node:assert/strict";
import test from "node:test";
import { PORT_BLOCK, allocatePort, portFree } from "../src/ports.mjs";

const config = (...ports) => ({ repos: { demo: { workspaces: Object.fromEntries(ports.map((port, i) => [`w${i}`, { port }])) } } });
const free = async () => true;

test("first block starts at the base", async () => {
  assert.equal(await allocatePort(config(), { base: 30000, isFree: free }), 30000);
});

test("skips blocks other workspaces own, including overlapping ones", async () => {
  assert.equal(await allocatePort(config(30000, 30010), { base: 30000, isFree: free }), 30020);
  assert.equal(await allocatePort(config(30005), { base: 30000, isFree: free }), 30020);
});

test("skips blocks where a port is taken", async () => {
  const busy = new Set([30003]);
  assert.equal(await allocatePort(config(), { base: 30000, isFree: async (port) => !busy.has(port) }), 30010);
});

test("reads port_base from config", async () => {
  assert.equal(await allocatePort({ ...config(), port_base: 41000 }, { isFree: free }), 41000);
});

test("gives up when no block fits", async () => {
  await assert.rejects(allocatePort(config(), { base: 65535 - PORT_BLOCK + 2, isFree: free }), /No free block/);
});

test("portFree sees a listening port", async (t) => {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  assert.equal(await portFree(server.address().port), false);
});
