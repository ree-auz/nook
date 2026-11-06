import spawn from "cross-spawn";
import { which } from "./agents.mjs";

const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** One word for a PR's checks: passed, failed, running or no-ci. */
export function ciState(checks = []) {
  if (!checks.length) return "no-ci";
  let running = false;
  for (const check of checks) {
    const result = check.conclusion || check.state || "";
    if (FAILED.has(result)) return "failed";
    if ((check.status && check.status !== "COMPLETED") || PENDING.has(result)) running = true;
  }
  return running ? "running" : "passed";
}

/** Newest PR per head branch, from `gh pr list --json` output (newest first). */
export function parsePrList(text) {
  const prs = new Map();
  for (const pr of JSON.parse(text)) {
    if (prs.has(pr.headRefName)) continue;
    prs.set(pr.headRefName, {
      number: pr.number,
      state: pr.state.toLowerCase(),
      head: pr.headRefOid,
      url: pr.url,
      ci: pr.state === "OPEN" ? ciState(pr.statusCheckRollup) : null,
    });
  }
  return prs;
}

function explain(output) {
  if (/auth login|not logged|authentication/i.test(output)) return "gh is not logged in (run gh auth login)";
  if (/none of the git remotes|not a git repository|no git remotes/i.test(output)) return null;
  return `gh failed: ${output.split(/\r?\n/)[0] || "no output"}`;
}

/**
 * PRs of a repository from GitHub, keyed by branch, through the gh CLI.
 * Resolves to { prs } or { error } (null error: the repository is not on GitHub).
 */
export function githubPrs(repoPath, env = process.env) {
  const gh = which("gh", env);
  if (!gh) return Promise.resolve({ error: "gh is not installed" });
  const fields = "number,state,headRefName,headRefOid,url,statusCheckRollup";
  return new Promise((done) => {
    const child = spawn(gh, ["pr", "list", "--state", "all", "--limit", "200", "--json", fields], {
      cwd: repoPath,
      env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ error: `gh failed: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return done({ error: "gh timed out" });
      if (code !== 0) return done({ error: explain(err.trim()) });
      try {
        done({ prs: parsePrList(out) });
      } catch {
        done({ error: "gh returned output nk could not read" });
      }
    });
  });
}
