import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import spawn from "cross-spawn";
import { NookError } from "./errors.mjs";

export const PORT_BLOCK = 10;
export const DEFAULT_PORT_BASE = 20000;
const MAX_PORT = 65535;

/** First ports of every workspace that already has a block. */
export function usedPorts(config) {
  const used = [];
  for (const repo of Object.values(config.repos ?? {}))
    for (const ws of Object.values(repo.workspaces ?? {}))
      if (Number.isInteger(ws.port)) used.push(ws.port);
  return used;
}

function overlaps(start, used) {
  return used.some((other) => start < other + PORT_BLOCK && other < start + PORT_BLOCK);
}

export function portFree(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
  });
}

export async function blockFree(start, isFree = portFree) {
  for (let port = start; port < start + PORT_BLOCK; port++) if (!(await isFree(port))) return false;
  return true;
}

/** Reads the start and size of Windows' dynamic port range from netsh, in any language: the last two numbers. */
export function parseDynamicPorts(text) {
  const numbers = String(text).match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length < 2) return null;
  const [start, count] = numbers.slice(-2);
  return start > 0 && count > 0 ? { start, end: Math.min(start + count - 1, MAX_PORT) } : null;
}

let cachedRange;
/**
 * The ports the system hands out to outgoing connections (ephemeral ports), or null when unknown.
 * Any program's connection can take one of them at any time, so a workspace's ports should lie outside.
 */
export function ephemeralRange() {
  if (cachedRange !== undefined) return cachedRange;
  cachedRange = null;
  try {
    if (process.platform === "win32") {
      const result = spawn.sync("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      if (result.status === 0) cachedRange = parseDynamicPorts(result.stdout);
    } else if (process.platform === "linux") {
      const [start, end] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
      if (start > 0 && end >= start) cachedRange = { start, end };
    } else if (process.platform === "darwin") {
      const result = spawn.sync("sysctl", ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"], { encoding: "utf8", timeout: 5000 });
      const [start, end] = (result.stdout ?? "").trim().split(/\s+/).map(Number);
      if (result.status === 0 && start > 0 && end >= start) cachedRange = { start, end };
    }
  } catch {
    /* Unknown; nothing is avoided. */
  }
  return cachedRange;
}

/** Whether a workspace's block of ports starting at `start` lies inside the ephemeral range. */
export function inEphemeral(start, range) {
  return Boolean(range) && start <= range.end && range.start < start + PORT_BLOCK;
}

/**
 * Gives a workspace PORT_BLOCK ports in a row. Skips blocks other workspaces
 * own, blocks where something is already listening, and blocks the system may
 * hand to outgoing connections, unless nothing else is left.
 */
export async function allocatePort(config, { base = config.port_base ?? DEFAULT_PORT_BASE, isFree = portFree, ephemeral = ephemeralRange() } = {}) {
  const used = usedPorts(config);
  for (const avoid of [ephemeral, null]) {
    for (let start = base; start + PORT_BLOCK - 1 <= MAX_PORT; start += PORT_BLOCK) {
      if (overlaps(start, used) || inEphemeral(start, avoid)) continue;
      if (await blockFree(start, isFree)) return start;
    }
  }
  throw new NookError(`No free block of ${PORT_BLOCK} ports from ${base}`);
}
