import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentCommand, launch } from "../agents.mjs";
import { NookError } from "../errors.mjs";
import { exists } from "../home.mjs";
import { baseRef, git, gitTry, refExists, remoteUrl } from "../git.mjs";
import { ensureTrusted, findHook, findHooks, runHook } from "../hooks.mjs";
import { nameProblem, normalizeName, toName } from "../names.mjs";
import { allocatePort } from "../ports.mjs";
import { createPrompter } from "../prompt.mjs";
import { copyShared } from "../shared.mjs";
import { resolveRepo, resolveWorkspace, workspaceEnv } from "../context.mjs";
import { setupChanges } from "./check-hooks.mjs";

/**
 * Before work starts: hooks or CI that changed since nk hooks test last passed
 * stop a new workspace (they may no longer set it up or clean it up), unless
 * `untested` is passed; an existing workspace only gets a warning.
 */
function checkSetup(ctx, repo, { stop, untested }) {
  const { tested, changes } = setupChanges(repo);
  if (!changes.length) return;
  if (!tested) {
    if (findHooks(repo.path).length) ctx.warn("The hooks have never passed nk hooks test");
    return;
  }
  const what = `${changes.join(" and ")} changed since nk hooks test last passed`;
  if (stop && !untested) throw new NookError(`${what}\nRun nk hooks test first, or pass --untested to start anyway`);
  ctx.warn(`${what} (run: nk hooks test)`);
}

/** Asks once for hooks that are new or changed; nothing when all are allowed. */
export function approveHooks(ctx, { repoName, repo }, prompter = createPrompter()) {
  return ensureTrusted({ repoName, repoConfig: repo, hooks: findHooks(repo.path), prompter, save: () => ctx.save(), ui: ctx });
}

/**
 * Runs one hook of the repository in the workspace. Hooks are read from the
 * main checkout, like worktrunk reads its project config from where the
 * command runs, so a branch made before the hooks existed still gets them.
 * Throws on a non-zero exit.
 */
export async function hook(ctx, target, event, { prompter = createPrompter() } = {}) {
  const found = findHook(target.repo.path, event);
  if (!found) return null;
  await approveHooks(ctx, target, prompter);
  const result = await runHook(found, {
    cwd: target.ws.path,
    env: workspaceEnv(ctx, target),
    logsDir: ctx.paths.logs,
    label: `${target.repoName}-${target.name}`,
    output: ctx.err,
  });
  if (result.status !== 0)
    throw new NookError(`.nook/${found.name} failed (exit ${result.status}). Log: ${result.log}`, { code: result.status || 1 });
  return result;
}

async function finish(ctx, target, { agent, prompt, extra }) {
  if (!agent) {
    if (prompt || extra.length) throw new NookError("-p and extra arguments need an agent, e.g. nk <name> <agent> -p ...");
    // On a terminal the path is a line like the others; captured (cd "$(nk …)"), it is the bare path.
    if (ctx.out.isTTY) ctx.ok(`Ready at ${target.ws.path}`);
    else ctx.print(target.ws.path);
    return 0;
  }
  const command = agentCommand(ctx.config, agent, { prompt, extra }, ctx.env);
  ctx.step(`Starting ${agent} in ${target.ws.path}`);
  return launch(command, { cwd: target.ws.path, env: workspaceEnv(ctx, target) });
}

/** An existing local or origin branch spelled exactly like `input`, or null. */
function existingBranch(repoPath, input) {
  if (!gitTry(["check-ref-format", "--branch", input], { cwd: repoPath }).ok) return null;
  return refExists(repoPath, `refs/heads/${input}`) || refExists(repoPath, `refs/remotes/origin/${input}`) ? input : null;
}

function addWorktree(repoPath, name, path, defaultBranch) {
  if (refExists(repoPath, `refs/heads/${name}`)) git(["worktree", "add", path, name], { cwd: repoPath });
  else if (refExists(repoPath, `refs/remotes/origin/${name}`))
    git(["worktree", "add", "--track", "-b", name, path, `origin/${name}`], { cwd: repoPath });
  else git(["worktree", "add", "--no-track", "-b", name, path, baseRef(repoPath, defaultBranch)], { cwd: repoPath });
}

/**
 * The name for a new workspace. When nk had to change what was passed in and
 * there is a terminal, the converted name is shown ready to edit.
 */
async function pickName(ctx, input, prompter) {
  let name = toName(input);
  if (name === input) return name;
  if (!prompter.interactive) {
    ctx.info(`Using the name ${name}`);
    return name;
  }
  for (;;) {
    const edited = normalizeName(await prompter.edit("Workspace name (edit or press Enter)", name));
    const problem = nameProblem(edited);
    if (!problem) return edited;
    ctx.warn(problem);
  }
}

/** nk -b <name> [agent] */
export async function createWorkspace(ctx, { name: input, repo: repoFlag, agent, prompt, extra = [], prompter = createPrompter(), untested = false }) {
  const { name: repoName, repo } = resolveRepo(ctx, repoFlag);
  checkSetup(ctx, repo, { stop: true, untested });
  if (remoteUrl(repo.path)) {
    const fetched = gitTry(["fetch", "--quiet", "origin", repo.default_branch], { cwd: repo.path });
    if (!fetched.ok) ctx.warn(`Could not fetch origin/${repo.default_branch}; using what is local`);
  }
  // A branch that already exists keeps its own name, "/" and all; the folder uses the converted name.
  const existing = existingBranch(repo.path, String(input));
  const name = existing ? toName(existing) : await pickName(ctx, input, prompter);
  if (existing && existing !== name) ctx.info(`Using the name ${name} for branch ${existing}`);
  const branch = existing ?? name;
  const dir = join(ctx.paths.workspaces, repoName);
  const path = join(dir, name);
  // The name and ports are taken under the lock, so two nk -b at once never get the same ones.
  const ws = await ctx.update(async (config) => {
    const fresh = config.repos[repoName];
    if (fresh.workspaces[name]) throw new NookError(`Workspace "${name}" already exists. Open it with: nk ${name}`);
    if (exists(path)) throw new NookError(`${path} already exists`);
    const port = await allocatePort(config);
    fresh.workspaces[name] = { path, port, created: new Date().toISOString(), ...(branch !== name && { branch }) };
    return fresh.workspaces[name];
  });
  const { port } = ws;
  mkdirSync(dir, { recursive: true });
  try {
    addWorktree(repo.path, branch, path, repo.default_branch);
  } catch (error) {
    delete repo.workspaces[name];
    ctx.save();
    throw error;
  }
  const target = { repoName, repo, name, ws };
  ctx.ok(`Created workspace ${name} @ ${path} (ports ${port}–${port + 9})`);

  const shared = copyShared(join(ctx.paths.shared, repoName), path);
  if (shared.copied.length) ctx.info(`Copied shared files: ${shared.copied.join(", ")}`);
  if (shared.skipped.length) ctx.warn(`Not copied (git does not ignore them here): ${shared.skipped.join(", ")}`);

  try {
    await hook(ctx, target, "create");
    await hook(ctx, target, "open");
  } catch (error) {
    if (error instanceof NookError) error.message += `\nThe workspace is kept at ${path}; remove it with: nk rm ${name}`;
    throw error;
  }
  return finish(ctx, target, { agent, prompt, extra });
}

/** nk <name> [agent] */
export async function openWorkspace(ctx, { name, repo: repoFlag, agent, prompt, extra = [] }) {
  const target = resolveWorkspace(ctx, toName(name), repoFlag);
  if (!exists(target.ws.path)) throw new NookError(`${target.ws.path} is missing. Run nk doctor`);
  if (!target.main) checkSetup(ctx, target.repo, { stop: false });
  await hook(ctx, target, "open");
  return finish(ctx, target, { agent, prompt, extra });
}
