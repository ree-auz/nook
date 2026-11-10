// @ts-check
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { exists } from "../home.mjs";
import { git, gitTry } from "../git.mjs";
import { findHooks, hookHash, runHook } from "../hooks.mjs";
import { allocatePort } from "../ports.mjs";
import { copyShared } from "../shared.mjs";
import { resolveRepo, workspaceEnv } from "../context.mjs";
import { describeOccupants, findOccupants, stopProcesses } from "../occupancy.mjs";
import { ciHash } from "../ci.mjs";
import { dockerCli, dockerSnapshot, findComposeProjects, removeComposeProject, snapshotDiff } from "../compose.mjs";
import { deleteFolder } from "./rm.mjs";

const CHECK_NAME = "nook-hooks-test";

/** Hooks of the main checkout that changed since they last passed a check. */
export function uncheckedHooks(repo) {
  return findHooks(repo.path).filter((hook) => repo.checked?.[hook.name] !== hookHash(hook.file));
}

/** CI changed since the hooks last passed a test (only known once a test has passed). */
export function ciChanged(repo) {
  return Boolean(repo.checked_ci) && ciHash(repo.path) !== repo.checked_ci;
}

/**
 * What changed since nk hooks test last passed, as short phrases; empty when
 * nothing did. `tested` says whether a test ever passed for this repository.
 */
export function setupChanges(repo) {
  const changes = uncheckedHooks(repo).map((hook) => `.nook/${hook.name}`);
  if (ciChanged(repo)) changes.push("the CI configuration");
  return { tested: Boolean(repo.checked), changes };
}

/**
 * nk hooks test: runs the hooks of the folder you are in (an agent's
 * branch, say) in a throwaway workspace: create, open twice, then remove.
 * Passes when the hooks succeed, open can repeat, git sees no changed files,
 * and Docker is back to what it was. Hooks that pass are recorded, so doctor and rm can tell when a hook
 * changed without being checked again.
 */
export async function testHooks(ctx, { repo: repoFlag, docker = dockerCli, scan = findOccupants, stop = stopProcesses }) {
  const { name: repoName, repo } = resolveRepo(ctx, repoFlag);
  const top = gitTry(["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
  const source = top.ok ? top.out : repo.path;
  const hooks = findHooks(source);
  if (!hooks.length) throw new NookError(`No hooks in ${join(source, ".nook")}. Write them first: nk hooks write <agent>`);
  const byEvent = Object.fromEntries(hooks.map((hook) => [hook.event, hook]));

  const path = join(ctx.paths.workspaces, repoName, CHECK_NAME);
  if (exists(path)) throw new NookError(`${path} is left from an earlier check. Delete it, then run the check again`);
  ctx.info(`Checking ${hooks.map((hook) => `.nook/${hook.name}`).join(", ")} from ${source} in a temporary workspace`);
  const before = dockerSnapshot(docker);
  if (!before) ctx.info("Docker is not available; only the hooks' exit codes are checked");

  mkdirSync(join(ctx.paths.workspaces, repoName), { recursive: true });
  // Recorded while the check runs, so an nk -b at the same time does not take the same ports.
  const port = await ctx.update(async (config) => {
    const taken = await allocatePort(config);
    config.repos[repoName].workspaces[CHECK_NAME] = { path, port: taken, created: new Date().toISOString() };
    return taken;
  });
  try {
    git(["worktree", "add", "--detach", path, git(["rev-parse", "HEAD"], { cwd: source })], { cwd: repo.path });
  } catch (error) {
    delete repo.workspaces[CHECK_NAME];
    ctx.save();
    throw error;
  }
  const target = { repoName, repo, name: CHECK_NAME, ws: { path, port } };
  copyShared(join(ctx.paths.shared, repoName), path);

  // A file git already shows as changed in a fresh checkout (line endings the repository's .gitattributes
  // would change, as awesome-kotlin's gradlew.bat) is the repository's, not the hooks'.
  const status = () => {
    const result = gitTry(["status", "--porcelain", "--untracked-files=all"], { cwd: path });
    return result.ok ? result.out.split(/\r?\n/).filter((line) => line.trim()) : [];
  };
  const fresh = new Set(status());
  const problems = [];
  const run = async (event, label = event) => {
    const hook = byEvent[event];
    if (!hook) return true;
    const result = await runHook(hook, { cwd: path, env: workspaceEnv(ctx, target), logsDir: ctx.paths.logs, label: `${repoName}-${CHECK_NAME}`, output: ctx.err });
    if (result.status === 0) return true;
    problems.push(`${label} failed (exit ${result.status}). Log: ${result.log}`);
    return false;
  };
  try {
    if (await run("create")) if (await run("open")) await run("open", "open, run a second time,");
    // Hooks set up the workspace; they must not change what git tracks, or every commit would carry it.
    const changed = status().filter((line) => !fresh.has(line));
    if (changed.length)
      problems.push(`The hooks changed files in the workspace that git would commit (ignore them in .gitignore, or do not write them):\n${changed.slice(0, 10).map((line) => `  ${line.trim()}`).join("\n")}`);
  } finally {
    await run("remove");
    const running = scan(path).processes ?? [];
    if (running.length) {
      problems.push(`Programs were still running in the workspace after remove:\n${describeOccupants(running)}`);
      await stop(running);
    }
    const after = before && dockerSnapshot(docker);
    if (after)
      for (const item of snapshotDiff(before, after)) problems.push(`remove left a Docker ${item.kind}: ${item.name}`);
    // Clean up whatever is left, so the check itself leaves nothing behind.
    for (const project of findComposeProjects(path, docker).projects) removeComposeProject(project, docker);
    gitTry(["worktree", "remove", "--force", path], { cwd: repo.path });
    delete repo.workspaces[CHECK_NAME];
    ctx.save();
    try {
      deleteFolder(path);
    } catch (error) {
      problems.push(error.message);
    }
    gitTry(["worktree", "prune"], { cwd: repo.path });
  }

  if (problems.length) throw new NookError(`The hooks did not pass:\n${problems.map((text) => `  ${text}`).join("\n")}`);
  repo.checked = Object.fromEntries(hooks.map((hook) => [hook.name, hookHash(hook.file)]));
  const ci = ciHash(source);
  if (ci) repo.checked_ci = ci;
  else delete repo.checked_ci;
  ctx.save();
  ctx.ok(`The hooks passed: create, open twice and remove ran, and ${before ? "Docker is as it was" : "all exited with 0"}`);
  return 0;
}
