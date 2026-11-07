#!/usr/bin/env node
/**
 * Runs nk for real on one repository of tests/corpus/repos.json, the way a
 * person would: init, hooks write, hooks test, then two workspaces side by
 * side while the main checkout's usual service ports are taken, checks that
 * each has its own services, ports and .env, and removes them. Meant for GitHub Actions (.github/workflows/real-repos.yml),
 * since it installs the repository's dependencies and starts its services.
 *
 *   node scripts/real-run.mjs <name> [--repo <owner/name> --commit <sha>] [--dir <checkout>] [--out results/<name>.json]
 *
 * --dir uses a checkout of the pinned commit made beforehand (actions/checkout);
 * without it the script fetches the commit itself.
 *
 * Prints each step and writes a JSON result: { name, ok, failedAt, steps: [...] }.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerSnapshot, snapshotDiff } from "../src/compose.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [name] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const listed = JSON.parse(readFileSync(join(root, "tests", "corpus", "repos.json"), "utf8")).find((repo) => repo.name === name);
// A repository picked this week (scripts/real-explore.mjs) is not in the list; --repo and --commit name it.
const entry = process.argv.includes("--repo") ? { name, repo: process.argv[process.argv.indexOf("--repo") + 1], commit: process.argv[process.argv.indexOf("--commit") + 1] } : listed;
if (!entry) {
  console.error(`Unknown repository ${name}; see tests/corpus/repos.json`);
  process.exit(2);
}

const option = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const work = mkdtempSync(join(tmpdir(), "nook-real-"));
const given = option("--dir");
const out = option("--out");
const repoDir = given ? resolve(given) : join(work, entry.name);
const env = { ...process.env, NOOK_HOME: join(work, "nook-home"), NO_COLOR: "1" };
const steps = [];
const tail = (text, lines = 40) => text.trim().split(/\r?\n/).slice(-lines).join("\n");

/** Runs one step; a failed step ends the run (remove still runs). */
function step(label, fn) {
  const started = Date.now();
  let ok = false;
  let output = "";
  try {
    const result = fn();
    ok = result.ok;
    output = result.output ?? "";
  } catch (error) {
    output = error.stack ?? String(error);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  steps.push({ step: label, ok, seconds, output: tail(output) });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${label} (${seconds}s)`);
  if (output.trim()) console.log(tail(output, ok ? 15 : 80));
  return ok;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoDir, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}`, stdout: result.stdout ?? "" };
}
const nk = (...args) => run(process.execPath, [join(root, "bin", "nk.mjs"), ...args], { input: "" });

/** True when something accepts connections on 127.0.0.1:port. */
function reachable(port) {
  const script = `const s=require("net").createConnection({host:"127.0.0.1",port:${port}});s.setTimeout(3000);s.on("connect",()=>process.exit(0));s.on("timeout",()=>process.exit(1));s.on("error",()=>process.exit(1));`;
  return spawnSync(process.execPath, ["-e", script]).status === 0;
}

/**
 * The ports a main checkout's services usually take. They are held for the whole run, as if the main
 * checkout's database and friends were running: a workspace that reaches for them fails.
 */
const MAIN_PORTS = [1025, 3306, 5432, 5672, 6379, 7700, 8025, 9200, 11211, 27017];
function holdMainPorts() {
  const script = `const net=require("net");for(const p of ${JSON.stringify(MAIN_PORTS)}){const s=net.createServer(c=>c.destroy());s.on("error",()=>{});s.listen(p,"0.0.0.0")}setInterval(()=>{},1e6)`;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
  return child;
}

/** This workspace's containers and the host ports they publish. */
function containersOf(ws) {
  const prefix = `nook-${basename(repoDir)}-${ws}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  const ps = run("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Ports}}"]);
  if (!ps.ok) return null;
  return ps.stdout
    .trim()
    .split("\n")
    .filter((row) => row.startsWith(prefix + "-") || row.startsWith(prefix + "_") || row === prefix || row.startsWith(prefix + "\t"))
    .map((row) => {
      const [name, state, ports = ""] = row.split("\t");
      return { name, state, ports: [...new Set([...ports.matchAll(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)->/g)].map((m) => Number(m[1])))] };
    });
}

/** Every container of the workspace runs and answers on each port it publishes. */
function servicesAnswer(ws) {
  const mine = containersOf(ws);
  if (!mine) return { ok: true, output: "docker is not available; nothing to check" };
  let ok = true;
  const lines = mine.map(({ name, state, ports }) => {
    const answering = ports.map((port) => ({ port, up: reachable(port) }));
    const good = state === "running" && answering.every((p) => p.up);
    ok &&= good;
    return `${good ? "ok  " : "BAD "} ${name} ${state} ${answering.map((p) => `${p.port}${p.up ? "" : " (no answer)"}`).join(", ")}`;
  });
  return { ok, output: lines.join("\n") || "no containers (the repository needs no services)" };
}

/** .env and .env.* in the workspace: no address or *_PORT may name a port the main checkout's services hold. */
function envOwnPorts(dir) {
  const bad = [];
  for (const file of readdirSync(dir).filter((name) => /^\.env(\..+)?$/.test(name) && !/example|sample|template|dist/i.test(name))) {
    for (const line of readFileSync(join(dir, file), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?(.*?)["']?\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      const ports = [...value.matchAll(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\b/g)].map((m) => Number(m[1]));
      if (/PORT$/i.test(key) && /^\d+$/.test(value)) ports.push(Number(value));
      for (const port of ports) if (MAIN_PORTS.includes(port)) bad.push(`${file}: ${key} uses ${port}, the main checkout's port`);
    }
  }
  return { ok: !bad.length, output: bad.join("\n") || "every service address uses this workspace's own ports" };
}

const before = dockerSnapshot();
const workspaces = {};
let holder = null;

/** nk -b <ws>, then its checks: clean in git, its own .env ports, its services answer. */
const makeWorkspace = (ws) =>
  step(`nk -b ${ws}`, () => {
    const result = nk("-b", ws, "-y");
    const path = result.ok ? result.stdout.trim().split(/\r?\n/).pop() : null;
    if (path && existsSync(path)) workspaces[ws] = path;
    return { ok: result.ok && Boolean(workspaces[ws]), output: result.output };
  }) &&
  step(`${ws} is clean in git`, () => {
    const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspaces[ws] });
    return { ok: status.ok && !status.stdout.trim(), output: status.output };
  }) &&
  step(`${ws} .env uses its own ports`, () => envOwnPorts(workspaces[ws])) &&
  step(`${ws} services answer`, () => servicesAnswer(ws));

const passed =
  step("clone", () => {
    const git = (...args) => run("git", args);
    const fetched = given
      ? [git("cat-file", "-e", `${entry.commit}^{commit}`)]
      : (mkdirSync(repoDir, { recursive: true }),
        [git("init", "-q", "-b", "main"), git("remote", "add", "origin", `https://github.com/${entry.repo}.git`), git("fetch", "-q", "--depth", "1", "origin", entry.commit)]);
    const results = [
      ...fetched,
      git("-c", "advice.detachedHead=false", "checkout", "-q", "-B", "main", entry.commit),
      // nk starts workspaces from origin/<default branch>; point it at the pinned commit.
      git("update-ref", "refs/remotes/origin/main", entry.commit),
      git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"),
    ];
    return { ok: results.every((r) => r.ok), output: results.map((r) => r.output).join("") };
  }) &&
  step("nk init", () => nk("init", "--yes")) &&
  step("nk hooks write", () => nk("hooks", "write")) &&
  step("nk hooks test", () => nk("hooks", "test")) &&
  // A second init allows the hooks, as a person answering yes would.
  step("allow hooks", () => nk("init", "--yes")) &&
  step("hold the main checkout's ports", () => {
    holder = holdMainPorts();
    const held = MAIN_PORTS.filter((port) => reachable(port));
    return { ok: true, output: `held ${held.join(", ")}` };
  }) &&
  makeWorkspace("try1") &&
  makeWorkspace("try2") &&
  step("try1 and try2 share nothing", () => {
    const one = containersOf("try1") ?? [];
    const two = containersOf("try2") ?? [];
    const shared = one.flatMap((c) => c.ports).filter((port) => two.some((d) => d.ports.includes(port)));
    const sameName = one.filter((c) => two.some((d) => d.name === c.name)).map((c) => c.name);
    const lines = [...shared.map((port) => `both publish port ${port}`), ...sameName.map((name) => `both use container ${name}`)];
    // try1 still answers now that try2 runs beside it.
    const still = servicesAnswer("try1");
    if (!still.ok) lines.push(`try1 stopped answering after try2 started:\n${still.output}`);
    return { ok: !lines.length, output: lines.join("\n") || `${one.length} and ${two.length} containers, no port or name in common` };
  });

// Removal runs whatever happened above, so the runner is checked for leftovers too.
holder?.kill();
let removed = true;
for (const ws of ["try1", "try2"])
  removed =
    step(`nk rm ${ws}`, () => {
      const result = nk("rm", ws, "-y");
      // nk -b failing before it made the workspace leaves nothing to remove.
      return !workspaces[ws] && /No workspace named/.test(result.output) ? { ok: true, output: "no workspace was made" } : result;
    }) && removed;
const clean = step("nothing left behind", () => {
  const after = dockerSnapshot();
  const left = before && after ? snapshotDiff(before, after) : [];
  const folders = Object.values(workspaces).filter((path) => existsSync(path));
  return { ok: !left.length && !folders.length, output: [...left.map((item) => `Docker ${item.kind}: ${item.name}`), ...folders.map((path) => `folder ${path}`)].join("\n") };
});

const ok = passed && removed && clean;
const result = { name: entry.name, repo: entry.repo, commit: entry.commit, new: listed?.repo !== entry.repo, ok, failedAt: steps.find((s) => !s.ok)?.step ?? null, steps };
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(`\n${ok ? "PASSED" : `FAILED at ${result.failedAt}`}: ${entry.name}`);
process.exit(ok ? 0 : 1);
