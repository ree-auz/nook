import assert from "node:assert/strict";
import test from "node:test";
import { PORT_BLOCK, allocatePort, inEphemeral, parseDynamicPorts, portFree } from "../src/ports.mjs";

const config = (...ports) => ({ repos: { demo: { workspaces: Object.fromEntries(ports.map((port, i) => [`w${i}`, { port }])) } } });
const free = async () => true;

test("first block starts at the base", async () => {
  assert.equal(await allocatePort(config(), { base: 30000, isFree: free, ephemeral: null }), 30000);
});

test("skips blocks other workspaces own, including overlapping ones", async () => {
  assert.equal(await allocatePort(config(30000, 30010), { base: 30000, isFree: free, ephemeral: null }), 30020);
  assert.equal(await allocatePort(config(30005), { base: 30000, isFree: free, ephemeral: null }), 30020);
});

test("skips blocks where a port is taken", async () => {
  const busy = new Set([30003]);
  assert.equal(await allocatePort(config(), { base: 30000, isFree: async (port) => !busy.has(port), ephemeral: null }), 30010);
});

test("reads port_base from config", async () => {
  assert.equal(await allocatePort({ ...config(), port_base: 41000 }, { isFree: free, ephemeral: null }), 41000);
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

test("skips the ports outgoing connections take, unless nothing else is left", async () => {
  const ephemeral = { start: 20000, end: 49151 };
  assert.equal(await allocatePort(config(), { base: 20000, isFree: free, ephemeral }), 49160);
  assert.equal(await allocatePort(config(), { base: 20000, isFree: free, ephemeral: { start: 1025, end: 65535 } }), 20000);
  assert.equal(inEphemeral(20000, { start: 20005, end: 30000 }), true);
  assert.equal(inEphemeral(19990, { start: 20000, end: 30000 }), false);
});

test("reads Windows' dynamic port range in any language", () => {
  assert.deepEqual(parseDynamicPorts("\nProtocol tcp Dynamic Port Range\n---------------------------------\nStart Port      : 1025\nNumber of Ports : 64511\n"), { start: 1025, end: 65535 });
  assert.deepEqual(parseDynamicPorts("\n协议 tcp 动态端口范围\n---------------------------------\n启动端口        : 49152\n端口数          : 16384\n"), { start: 49152, end: 65535 });
  assert.equal(parseDynamicPorts(""), null);
});
