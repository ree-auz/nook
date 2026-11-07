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

const node = (read(".nvmrc") || read(".node-version") || toolVersion("nodejs") || engines || "22").replace(/^v/, "").split(/\s+/)[0];
const python = (read(".python-version") || toolVersion("python") || "3.13").split(/\s+/)[0];
console.log(`node=${node}`);
console.log(`python=${python}`);
