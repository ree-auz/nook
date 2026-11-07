#!/usr/bin/env node
/**
 * The Node and Python versions a repository asks for, as GitHub Actions
 * outputs (node=..., python=...), so the full run installs what a person
 * working on it would. Reads .nvmrc, .node-version, .tool-versions,
 * package.json engines and .python-version; falls back to current releases.
 * Also says which other toolchains it needs (go, ruby, java, php, elixir,
 * dotnet), so the workflow installs only those, and the uv version a
 * pyproject.toml or uv.toml requires (required-version), here or in a subfolder.
 *
 *   node scripts/real-versions.mjs <checkout> >> "$GITHUB_OUTPUT"
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planFromCi } from "../src/ci.mjs";

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
// The versions the CI job nk picks installs: a person setting up the project follows CI.
let ciTools = [];
try {
  ciTools = planFromCi(dir).best?.tools ?? [];
} catch {}
const ciVersion = (name) => {
  const version = ciTools.find((tool) => tool.name === name)?.version ?? "";
  return /^v?\d+(\.[\dx]+)*$/.test(version) ? version.replace(/^v/, "").replace(/\.x$/, "") : "";
};
const node = pinned || ciVersion("node") || fromRange(engines) || "22";
const python = (read(".python-version") || toolVersion("python") || "3.13").split(/\s+/)[0];
const has = (...files) => files.some((file) => existsSync(join(dir, file)));
const first = (...values) => values.find(Boolean) ?? "";
let php = "";
try {
  php = JSON.parse(read("composer.json") || "{}").require?.php ?? "";
} catch {}
/** uv's required-version, from the first pyproject.toml or uv.toml within three folders of the root. */
function uvVersion(folder = "", depth = 0) {
  for (const file of ["uv.toml", "pyproject.toml"]) {
    const spec = read(join(folder, file)).match(/^\s*required-version\s*=\s*["']([^"']+)["']/m)?.[1];
    if (spec) return spec.replace(/^\s*==\s*/, "").trim();
  }
  if (depth >= 3) return "";
  let entries = [];
  try {
    entries = readdirSync(join(dir, folder), { withFileTypes: true });
  } catch {}
  for (const entry of entries.filter((e) => e.isDirectory() && !/^(\.|node_modules$|vendor$)/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const found = uvVersion(join(folder, entry.name), depth + 1);
    if (found) return found;
  }
  return "";
}
const out = {
  node,
  python,
  go: has("go.mod") ? "go.mod" : "",
  // Major.minor: newer runner images only have the latest patch of each Ruby series.
  ruby: has("Gemfile") ? first(read(".ruby-version").replace(/^ruby-/, ""), toolVersion("ruby"), "3.4").split(".").slice(0, 2).join(".") : "",
  java: has("pom.xml", "build.gradle", "build.gradle.kts") ? first(read(".java-version"), toolVersion("java")?.replace(/^\D*/, "").split(".")[0], "21") : "",
  // "^8.1" or ">=8.1" allows a current 8.x; otherwise the newest version it names.
  php: has("composer.json") ? first(/(\^|>=\s*)8/.test(php) && "8.3", php.match(/(\d+\.\d+)/g)?.sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]) || Number(b.split(".")[1]) - Number(a.split(".")[1]))[0], "8.3") : "",
  elixir: has("mix.exs") ? first(toolVersion("elixir")?.split("-")[0], "1.18") : "",
  otp: has("mix.exs") ? first(toolVersion("erlang")?.split(".")[0], "27") : "",
  dotnet: has("global.json") ? "global.json" : "",
  uv: uvVersion(),
  // A pnpm CI installs by itself, as a person would with npm i -g pnpm@<version>.
  pnpm: ciVersion("pnpm"),
};
for (const [key, value] of Object.entries(out)) console.log(`${key}=${value}`);
