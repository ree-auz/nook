import { createServer } from "node:net";
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

/**
 * Gives a workspace PORT_BLOCK ports in a row. Skips blocks other workspaces
 * own and blocks where something is already listening.
 */
export async function allocatePort(config, { base = config.port_base ?? DEFAULT_PORT_BASE, isFree = portFree } = {}) {
  const used = usedPorts(config);
  for (let start = base; start + PORT_BLOCK - 1 <= MAX_PORT; start += PORT_BLOCK) {
    if (overlaps(start, used)) continue;
    if (await blockFree(start, isFree)) return start;
  }
  throw new NookError(`No free block of ${PORT_BLOCK} ports from ${base}`);
}
