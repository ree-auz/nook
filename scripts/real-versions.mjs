#!/usr/bin/env node
/**
 * The Node and Python versions a repository asks for, as GitHub Actions
 * outputs (node=..., python=...), so the full run installs what a person
 * working on it would. Reads .nvmrc, .node-version, .tool-versions,
 * package.json engines and .python-version; falls back to current releases.
 *
 *   node scripts/real-versions.mjs <checkout> >> "$GITHUB_OUTPUT"
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const read = (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim() : "");
const toolVersion = (tool) => read(".tool-versions").match(new RegExp(`^${tool}\\s+(\\S+)`, "m"))?.[1];
let engines = "";
try {
  engines = JSON.parse(read("package.json") || "{}").engines?.node ?? "";
} catch {}

/** A version setup-node can install from an engines range: the newest LTS for ">=X", else the highest major it names. */
function fromRange(range) {
  if (!range) return "";
  if (/^\s*>=?\s*v?\d+(\.\d+)*\s*$/.test(range)) return "lts/*";
  // "<23" allows 22 at most.
  const majors = [...range.matchAll(/(<=?|>=?|[\^~=]|^|\s|\|)\s*v?(\d+)(?=[.\sx*|]|$)/g)].map((m) => (m[1] === "<" ? Number(m[2]) - 1 : Number(m[2])));
  return majors.length ? String(Math.max(...majors)) : "";
}
const pinned = (read(".nvmrc") || read(".node-version") || toolVersion("nodejs") || "").replace(/^v/, "").split(/\s+/)[0];
const node = pinned || fromRange(engines) || "22";
const python = (read(".python-version") || toolVersion("python") || "3.13").split(/\s+/)[0];
console.log(`node=${node}`);
console.log(`python=${python}`);
