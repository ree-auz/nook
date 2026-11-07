#!/usr/bin/env node
/**
 * Runs nk for real on one repository of tests/corpus/repos.json, the way a
 * person would: init, hooks write, hooks test, nk -b, then checks the
 * workspace and removes it. Meant for GitHub Actions (.github/workflows/real-repos.yml),
 * since it installs the repository's dependencies and starts its services.
 *
 *   node scripts/real-run.mjs <name> [--repo <owner/name> --commit <sha>] [--dir <checkout>] [--out results/<name>.json]
 *
 * --dir uses a checkout of the pinned commit made beforehand (actions/checkout);
 * without it the script fetches the commit itself.
 *
 * Prints each step and writes a JSON result: { name, ok, failedAt, steps: [...] }.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const before = dockerSnapshot();
let workspace = null;

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
  step("nk -b try1", () => {
    const result = nk("-b", "try1", "-y");
    workspace = result.ok ? result.stdout.trim().split(/\r?\n/).pop() : null;
    return { ok: result.ok && Boolean(workspace) && existsSync(workspace), output: result.output };
  }) &&
  step("workspace is clean in git", () => {
    const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace });
    return { ok: status.ok && !status.stdout.trim(), output: status.output };
  }) &&
  step("its services answer", () => {
    const prefix = `nook-${basename(repoDir)}-try1`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    const ps = run("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Ports}}"]);
    if (!ps.ok) return { ok: true, output: "docker is not available; nothing to check" };
    const mine = ps.stdout.trim().split("\n").filter((row) => row.startsWith(prefix));
    const lines = [];
    let ok = true;
    for (const row of mine) {
      const [container, state, ports = ""] = row.split("\t");
      const published = [...ports.matchAll(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)->/g)].map((m) => Number(m[1]));
      const answering = [...new Set(published)].map((port) => ({ port, up: reachable(port) }));
      const good = state === "running" && answering.every((p) => p.up);
      ok &&= good;
      lines.push(`${good ? "ok  " : "BAD "} ${container} ${state} ${answering.map((p) => `${p.port}${p.up ? "" : " (no answer)"}`).join(", ")}`);
    }
    return { ok, output: lines.join("\n") || "no containers (the repository needs no services)" };
  });

// Removal runs whatever happened above, so the runner is checked for leftovers too.
const removed = step("nk rm try1", () => (workspace || existsSync(join(env.NOOK_HOME, "workspace")) ? nk("rm", "try1", "-y") : { ok: true, output: "no workspace was made" }));
const clean = step("nothing left behind", () => {
  const after = dockerSnapshot();
  const left = before && after ? snapshotDiff(before, after) : [];
  const folder = workspace && existsSync(workspace);
  return { ok: !left.length && !folder, output: [...left.map((item) => `Docker ${item.kind}: ${item.name}`), ...(folder ? [`folder ${workspace}`] : [])].join("\n") };
});

const ok = passed && removed && clean;
const result = { name: entry.name, repo: entry.repo, commit: entry.commit, new: listed?.repo !== entry.repo, ok, failedAt: steps.find((s) => !s.ok)?.step ?? null, steps };
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(`\n${ok ? "PASSED" : `FAILED at ${result.failedAt}`}: ${entry.name}`);
process.exit(ok ? 0 : 1);
