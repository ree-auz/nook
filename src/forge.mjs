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

/**
 * Newest PR per head branch, from `gh pr list --json` output. Takes several
 * outputs: when two list the same PR, the one with its checks is kept.
 */
export function parsePrList(...texts) {
  const prs = new Map();
  for (const pr of texts.flatMap((text) => JSON.parse(text))) {
    const known = prs.get(pr.headRefName);
    if (known && (known.number > pr.number || (known.number === pr.number && !pr.statusCheckRollup))) continue;
    prs.set(pr.headRefName, {
      number: pr.number,
      state: pr.state.toLowerCase(),
      head: pr.headRefOid,
      url: pr.url,
      // Without the field the checks were not asked for, which is not the same as having none.
      ci: pr.state === "OPEN" && "statusCheckRollup" in pr ? ciState(pr.statusCheckRollup ?? []) : null,
    });
  }
  return prs;
}

function explain(output) {
  if (/auth login|not logged|authentication/i.test(output)) return "gh is not logged in (run gh auth login)";
  if (/none of the git remotes|not a git repository|no git remotes/i.test(output)) return null;
  return `gh failed: ${output.split(/\r?\n/)[0] || "no output"}`;
}

/** One gh call. Resolves to { out } or { error }. */
function gh(bin, args, repoPath, env) {
  return new Promise((done) => {
    const child = spawn(bin, args, {
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
      done({ out });
    });
  });
}

/**
 * PRs of a repository from GitHub, keyed by branch, through the gh CLI.
 * Resolves to { prs } or { error } (null error: the repository is not on GitHub).
 *
 * Two requests at the same time: the checks of the open PRs, and the last 200
 * PRs of any state without checks. Checks are what makes GitHub slow to
 * answer, and only an open PR shows them, so they are not asked for the
 * merged and closed ones.
 */
export async function githubPrs(repoPath, env = process.env) {
  const bin = which("gh", env);
  if (!bin) return { error: "gh is not installed" };
  const fields = "number,state,headRefName,headRefOid,url";
  const [open, all] = await Promise.all([
    gh(bin, ["pr", "list", "--state", "open", "--limit", "100", "--json", `${fields},statusCheckRollup`], repoPath, env),
    gh(bin, ["pr", "list", "--state", "all", "--limit", "200", "--json", fields], repoPath, env),
  ]);
  const failed = [open, all].find((result) => "error" in result);
  if (failed) return { error: failed.error };
  try {
    return { prs: parsePrList(open.out, all.out) };
  } catch {
    return { error: "gh returned output nk could not read" };
  }
}
