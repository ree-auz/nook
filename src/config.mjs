// @ts-check
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { NookError } from "./errors.mjs";

export function emptyConfig() {
  return { agents: {}, repos: {} };
}

export function loadConfig(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyConfig();
    throw error;
  }
  let data;
  try {
    data = parse(text);
  } catch (error) {
    throw new NookError(`Cannot read ${file}: ${error.message}`);
  }
  data.agents ??= {};
  data.repos ??= {};
  for (const repo of Object.values(data.repos)) {
    repo.workspaces ??= {};
    repo.hooks ??= {};
  }
  return data;
}

export function saveConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, stringify(config) + "\n");
  renameSync(temp, file);
}

// Several nk may run at once (an agent per Linear issue): config.toml changes under a lock, so no
// two get the same ports and none writes over what another just recorded.
const STALE_MS = 30_000;
const WAIT_MS = 15_000;

function tryLock(lock) {
  try {
    mkdirSync(lock);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      // A lock left by an nk that was killed: no update takes this long.
      if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

const busy = (lock) => new NookError(`Another nk is updating its config and did not finish. If no nk is running, delete ${lock}`);

/** Runs fn while holding the lock on `file`. */
export function withLockSync(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const until = Date.now() + WAIT_MS;
  while (!tryLock(lock)) {
    if (Date.now() > until) throw busy(lock);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Async form, for updates that wait on something (checking that ports are free). */
export async function withLock(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const until = Date.now() + WAIT_MS;
  while (!tryLock(lock)) {
    if (Date.now() > until) throw busy(lock);
    await new Promise((done) => setTimeout(done, 50));
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Applies to `target` what changed from `base` to `current`: keys added, removed or changed, at any depth. */
export function applyChanges(base, current, target) {
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (!(key in current)) delete target[key];
    else if (!(key in base)) target[key] = structuredClone(current[key]);
    else if (isObject(base[key]) && isObject(current[key]) && isObject(target[key])) applyChanges(base[key], current[key], target[key]);
    else if (!same(base[key], current[key])) target[key] = structuredClone(current[key]);
  }
  return target;
}

/** Makes `target` equal to `source`, keeping the objects `target` already has, so references to them stay live. */
export function syncInPlace(target, source) {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    if (isObject(target[key]) && isObject(value)) syncInPlace(target[key], value);
    else target[key] = structuredClone(value);
  }
  return target;
}
