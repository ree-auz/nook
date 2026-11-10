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
 * Prints each step and writes a JSON result: { name, ok, failedAt, cause, why, steps: [...] }.
 * `cause` says whose failure it is (scripts/real-cause.mjs). The exit code is 1 for every
 * failure but one: a repository nk has not seen before whose own setup command failed is
 * reported and does not fail the run, since nothing says nk is at fault.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerSnapshot, snapshotDiff } from "../src/compose.mjs";
import { failureCause } from "./real-cause.mjs";

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
  // The whole output decides whose failure it is; the result keeps its last lines.
  steps.push({ step: label, ok, seconds, output: tail(output), ...(ok ? {} : { blame: failureCause(label, output) }) });
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
      const published = [...ports.matchAll(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)->(\d+)/g)];
      return { name, state, ports: [...new Set(published.map((m) => Number(m[1])))], targets: [...new Set(published.map((m) => Number(m[2])))] };
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

/**
 * .env and the .env.* files development and tests read: no address or *_PORT may still name the usual port of
 * a service the workspace runs itself (5432 when it has its own postgres), which is the main checkout's.
 * Services nk does not start for the workspace are not its to move.
 */
function envOwnPorts(dir, ws) {
  const own = new Set((containersOf(ws) ?? []).flatMap((c) => c.targets));
  const bad = [];
  for (const file of readdirSync(dir).filter((name) => /^\.env(\..+)?$/.test(name) && !/example|sample|template|dist|prod/i.test(name))) {
    for (const line of readFileSync(join(dir, file), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?(.*?)["']?\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      const ports = [...value.matchAll(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\b/g)].map((m) => Number(m[1]));
      if (/PORT$/i.test(key) && /^\d+$/.test(value)) ports.push(Number(value));
      for (const port of ports) if (own.has(port)) bad.push(`${file}: ${key} uses ${port}, the main checkout's port, though the workspace runs that service on its own`);
    }
  }
  return { ok: !bad.length, output: bad.join("\n") || "every service address uses this workspace's own ports" };
}

/** Named volumes a container mounts: { destination, name }. */
function volumesOf(container) {
  const inspect = run("docker", ["inspect", "--format", "{{json .Mounts}}", container]);
  if (!inspect.ok) return [];
  try {
    return JSON.parse(inspect.stdout).filter((m) => m.Type === "volume").map((m) => ({ destination: m.Destination, name: m.Name }));
  } catch {
    return [];
  }
}
const MARK = ".nook-isolation-check";
/** Runs sh in a container as root; null when the image has no shell. */
const inContainer = (container, script) => {
  const result = run("docker", ["exec", "-u", "0", container, "sh", "-c", script]);
  return /executable file not found|no such file or directory: unknown/i.test(result.output) ? null : result;
};
/** Writes "<ws>" into each volume the workspace's containers mount; returns what was marked. */
function markData(ws) {
  const marked = [];
  for (const { name: container } of containersOf(ws) ?? [])
    for (const { destination } of volumesOf(container)) {
      const result = inContainer(container, `echo ${ws} > '${destination}/${MARK}'`);
      if (result?.ok) marked.push({ container, destination });
    }
  return marked;
}
/** What each marked volume holds now: the workspace name, or "" when the mark is gone. */
const readMark = (container, destination) => inContainer(container, `cat '${destination}/${MARK}' 2>/dev/null || true`)?.stdout.trim() ?? null;

// Stands in for the main checkout's own database: a container and a volume nk must never touch.
const MAIN = "nook-real-main-checkout";
const mainUp = run("docker", ["run", "-d", "--name", MAIN, "-v", `${MAIN}-data:/data`, "busybox:1.37", "sh", "-c", "echo main > /data/mark; sleep 86400"]).ok;
const mainIntact = () => {
  if (!mainUp) return { ok: true, output: "docker is not available; nothing to check" };
  const state = run("docker", ["inspect", "--format", "{{.State.Running}}", MAIN]).stdout.trim();
  const mark = run("docker", ["exec", MAIN, "cat", "/data/mark"]).stdout.trim();
  return { ok: state === "true" && mark === "main", output: `main checkout's container running: ${state || "gone"}, its data: ${mark || "gone"}` };
};

const before = dockerSnapshot();
const workspaces = {};
let holder = null;
const marks = {};
const gone = new Set();

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
    // Files the main checkout itself shows as changed (line endings .gitattributes would change) are the repository's.
    const main = new Set(run("git", ["status", "--porcelain"], { cwd: repoDir }).stdout.split(/\r?\n/));
    const changed = status.stdout.split(/\r?\n/).filter((line) => line.trim() && !main.has(line));
    return { ok: status.ok && !changed.length, output: changed.join("\n") || status.output };
  }) &&
  step(`${ws} .env uses its own ports`, () => envOwnPorts(workspaces[ws], ws)) &&
  step(`${ws} services answer`, () => servicesAnswer(ws));

/** Every mark the workspace wrote is still there. */
const marksKept = (ws) => {
  const lost = (marks[ws] ?? []).filter(({ container, destination }) => readMark(container, destination) !== ws);
  return { ok: !lost.length, output: lost.map((m) => `${m.container}:${m.destination} lost its data`).join("\n") || `${(marks[ws] ?? []).length} volumes keep their data` };
};

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
  step("nk init", () => nk("init", "--yes", "--allow-hooks")) &&
  step("nk hooks write", () => nk("hooks", "write")) &&
  step("nk hooks test", () => nk("hooks", "test")) &&
  // A second init allows the hooks, as a person answering yes would.
  step("allow hooks", () => nk("init", "--yes", "--allow-hooks")) &&
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
    const volumes = (list) => list.flatMap((c) => volumesOf(c.name).map((v) => v.name));
    const lines = [
      ...one.flatMap((c) => c.ports).filter((port) => two.some((d) => d.ports.includes(port))).map((port) => `both publish port ${port}`),
      ...one.filter((c) => two.some((d) => d.name === c.name)).map((c) => `both use container ${c.name}`),
      ...volumes(one).filter((name) => volumes(two).includes(name)).map((name) => `both use volume ${name}`),
      ...[...volumes(one), ...volumes(two)].filter((name) => name === `${MAIN}-data`).map(() => "a workspace uses the main checkout's volume"),
    ];
    // try1 still answers now that try2 runs beside it.
    const still = servicesAnswer("try1");
    if (!still.ok) lines.push(`try1 stopped answering after try2 started:\n${still.output}`);
    return { ok: !lines.length, output: lines.join("\n") || `${one.length} and ${two.length} containers, no port, name or volume in common` };
  }) &&
  step("data written in try1 stays in try1", () => {
    marks.try1 = markData("try1");
    marks.try2 = markData("try2");
    const leaks = (marks.try2 ?? []).filter(({ container, destination }) => readMark(container, destination) !== "try2");
    const kept = marksKept("try1");
    const ok = !leaks.length && kept.ok;
    return { ok, output: [...leaks.map((m) => `${m.container}:${m.destination} shows try1's data`), kept.output, `${marks.try1.length + marks.try2.length} volumes marked`].join("\n") };
  }) &&
  step("try1 comes back after its services stop", () => {
    const portsBefore = (containersOf("try1") ?? []).flatMap((c) => c.ports).sort().join(",");
    for (const { name } of containersOf("try1") ?? []) run("docker", ["stop", name]);
    const opened = nk("try1", "-y");
    const portsAfter = (containersOf("try1") ?? []).flatMap((c) => c.ports).sort().join(",");
    const answer = servicesAnswer("try1");
    const kept = marksKept("try1");
    const same = portsBefore === portsAfter;
    return {
      ok: opened.ok && answer.ok && kept.ok && same,
      output: [opened.ok ? "nk try1 reopened it" : opened.output, answer.output, kept.output, same ? `same ports: ${portsAfter || "none"}` : `ports moved: ${portsBefore} -> ${portsAfter}`].join("\n"),
    };
  }) &&
  step("removing try1 leaves try2 and the main checkout alone", () => {
    const result = nk("rm", "try1", "-y");
    if (result.ok) gone.add("try1");
    const answer = servicesAnswer("try2");
    const kept = marksKept("try2");
    const main = mainIntact();
    return { ok: result.ok && answer.ok && kept.ok && main.ok, output: [result.ok ? "removed try1" : result.output, answer.output, kept.output, main.output].join("\n") };
  });

// Removal runs whatever happened above, so the runner is checked for leftovers too.
holder?.kill();
let removed = true;
for (const ws of ["try1", "try2"].filter((name) => !gone.has(name)))
  removed =
    step(`nk rm ${ws}`, () => {
      const result = nk("rm", ws, "-y");
      // nk -b failing before it made the workspace leaves nothing to remove.
      return !workspaces[ws] && /No workspace named/.test(result.output) ? { ok: true, output: "no workspace was made" } : result;
    }) && removed;
const clean = step("nothing left behind, main checkout intact", () => {
  const after = dockerSnapshot();
  const left = before && after ? snapshotDiff(before, after) : [];
  const folders = Object.values(workspaces).filter((path) => existsSync(path));
  const main = mainIntact();
  return {
    ok: !left.length && !folders.length && main.ok,
    output: [...left.map((item) => `Docker ${item.kind}: ${item.name}`), ...folders.map((path) => `folder ${path}`), main.output].join("\n"),
  };
});
if (mainUp) {
  run("docker", ["rm", "-f", MAIN]);
  run("docker", ["volume", "rm", `${MAIN}-data`]);
}

const ok = passed && removed && clean;
const failed = steps.find((s) => !s.ok);
// A later step that breaks one of nk's promises (something left behind, say) outweighs an earlier setup failure.
const blame = steps.find((s) => s.blame?.cause === "nk")?.blame ?? failed?.blame ?? null;
const fresh = listed?.repo !== entry.repo;
const result = { name: entry.name, repo: entry.repo, commit: entry.commit, new: fresh, ok, failedAt: failed?.step ?? null, cause: blame?.cause ?? null, why: blame?.why ?? null, steps: steps.map(({ blame: _, ...rest }) => rest) };
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(`\n${ok ? "PASSED" : `FAILED at ${result.failedAt} (${result.cause}: ${result.why})`}: ${entry.name}`);
process.exit(ok || (fresh && result.cause === "repository") ? 0 : 1);
