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

/** Runs one hook if the workspace has it. Throws on a non-zero exit. */
export async function hook(ctx, target, event, { prompter = createPrompter() } = {}) {
  const found = findHook(target.ws.path, event);
  if (!found) return null;
  await ensureTrusted({
    repoName: target.repoName,
    repoConfig: target.repo,
    hooks: findHooks(target.ws.path),
    prompter,
    save: () => ctx.save(),
    ui: ctx,
  });
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
    ctx.print(target.ws.path);
    return 0;
  }
  const command = agentCommand(ctx.config, agent, { prompt, extra }, ctx.env);
  ctx.step(`Starting ${agent} in ${target.ws.path}`);
  return launch(command, { cwd: target.ws.path, env: workspaceEnv(ctx, target) });
}

function addWorktree(repoPath, name, path, defaultBranch) {
  if (remoteUrl(repoPath)) {
    const fetched = gitTry(["fetch", "--quiet", "origin", defaultBranch], { cwd: repoPath });
    if (!fetched.ok) process.stderr.write(`Could not fetch origin/${defaultBranch}; using what is local\n`);
  }
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
export async function createWorkspace(ctx, { name: input, repo: repoFlag, agent, prompt, extra = [], prompter = createPrompter() }) {
  const name = await pickName(ctx, input, prompter);
  const { name: repoName, repo } = resolveRepo(ctx, repoFlag);
  if (repo.workspaces[name]) throw new NookError(`Workspace "${name}" already exists. Open it with: nk ${name}`);
  const dir = join(ctx.paths.workspaces, repoName);
  const path = join(dir, name);
  if (exists(path)) throw new NookError(`${path} already exists`);
  mkdirSync(dir, { recursive: true });

  const port = await allocatePort(ctx.config);
  addWorktree(repo.path, name, path, repo.default_branch);
  const ws = { path, port, created: new Date().toISOString() };
  repo.workspaces[name] = ws;
  ctx.save();
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
  await hook(ctx, target, "open");
  return finish(ctx, target, { agent, prompt, extra });
}
