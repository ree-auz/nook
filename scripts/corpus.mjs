#!/usr/bin/env node
/**
 * What `nk hooks write` makes of real repositories, compared with the last
 * reviewed result in tests/corpus/expected/. Each repository is fetched at a
 * pinned commit, only its CI, Compose and env template files, and nothing in
 * it is run. A difference fails; after reviewing it, accept it with --update.
 *
 *   npm run corpus              compare
 *   npm run corpus -- --update  write the new results
 *   npm run corpus -- outline   only some repositories
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateHooks } from "../src/commands/write-hooks.mjs";
import { hostAddresses } from "../src/compose-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedDir = join(root, "tests", "corpus", "expected");
const cache = process.env.NOOK_CORPUS_DIR ?? join(tmpdir(), "nook-corpus");
const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.filter((arg) => !arg.startsWith("-"));
const repos = JSON.parse(readFileSync(join(root, "tests", "corpus", "repos.json"), "utf8")).filter((r) => !only.length || only.includes(r.name));

function git(cwd, ...gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The repository at its pinned commit, with only the files hooks write reads. */
function fetchRepo({ name, repo, commit }) {
  const dir = join(cache, name);
  if (existsSync(join(dir, ".git")) && spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim() === commit) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", `https://github.com/${repo}.git`);
  git(dir, "sparse-checkout", "set", "--no-cone", "/.github/", "/compose*.y*ml", "/docker-compose*.y*ml", "/.env*", "/.worktreeinclude");
  git(dir, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", commit);
  git(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
  return dir;
}

/** A plain-text summary of the plan, stable across machines. */
function summarize(dir) {
  rmSync(join(dir, ".nook"), { recursive: true, force: true });
  const result = generateHooks(dir);
  rmSync(join(dir, ".nook"), { recursive: true, force: true });
  if (!result.written) return `none: ${result.reason}\n`;
  const p = result.plan;
  const lines = [`source: ${p.job ? `${p.source} › ${p.job}` : "(no CI)"}${p.compose ? ` + ${p.compose.file}` : ""}`];
  lines.push(`tools: ${p.tools.map((t) => t.name + (t.version ? `@${t.version}` : "")).join(", ") || "-"}`);
  lines.push(`create: ${p.create.map((s) => s.run.split("\n")[0]).join(" ; ") || "-"}`);
  if (p.remove.length) lines.push(`remove: ${p.remove.map((s) => s.run.split("\n")[0]).join(" ; ")}`);
  for (const s of p.services) lines.push(`ci service: ${s.name} ${s.image.split("@")[0]} ${s.ports.map((x) => `${x.host}:${x.container}`).join(" ") || "(no ports)"}`);
  for (const [key, value] of Object.entries(p.env)) lines.push(`env: ${key}=${value}`);
  if (p.compose) {
    lines.push(`compose start: ${p.compose.start.join(", ") || "-"}`);
    if (Object.keys(p.compose.ports).length) lines.push(`compose port vars: ${Object.keys(p.compose.ports).join(", ")}`);
    for (const [name, entries] of Object.entries(p.compose.remap)) lines.push(`compose moves: ${name} ${entries.map((e) => e.host).join(" ")}`);
    if (p.compose.required.length) lines.push(`compose needs: ${p.compose.required.join(", ")}`);
    for (const s of p.compose.notStarted) lines.push(`compose not started: ${s.name} (${s.why.replace(/@sha256:\w+/, "")})`);
  }
  const addresses = hostAddresses(dir, { start: !p.services.length });
  if (Object.keys(addresses).length) lines.push(`template addresses: ${Object.entries(addresses).map(([a, b]) => `${a} -> ${b}`).join(", ")}`);
  for (const u of p.untranslated) lines.push(`left out: ${u.step}: ${u.why}`);
  return `${lines.join("\n")}\n`;
}

mkdirSync(expectedDir, { recursive: true });
let changed = 0;
for (const entry of repos) {
  let text;
  try {
    text = summarize(fetchRepo(entry));
  } catch (error) {
    text = `error: ${error.message.split("\n")[0]}\n`;
  }
  const file = join(expectedDir, `${entry.name}.txt`);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before === text) {
    console.log(`  same     ${entry.name}`);
    continue;
  }
  changed++;
  if (update) {
    writeFileSync(file, text);
    console.log(`  updated  ${entry.name}`);
    continue;
  }
  console.log(`✗ changed  ${entry.name}`);
  const old = new Set((before ?? "").split("\n"));
  const now = new Set(text.split("\n"));
  for (const line of old) if (line && !now.has(line)) console.log(`    - ${line}`);
  for (const line of now) if (line && !old.has(line)) console.log(`    + ${line}`);
}
if (changed && !update) {
  console.log(`\n${changed} of ${repos.length} changed. Review the lines above; if they are right: npm run corpus -- --update`);
  process.exit(1);
}
console.log(`\n${repos.length - changed} of ${repos.length} unchanged${update && changed ? `, ${changed} updated` : ""}`);
