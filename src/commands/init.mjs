import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import spawn from "cross-spawn";
import { detectAgents, which } from "../agents.mjs";
import { NookError } from "../errors.mjs";
import { exists, isInside, samePath } from "../home.mjs";
import { defaultBranch, listWorktrees, mainWorktree, remoteUrl } from "../git.mjs";
import { HOOK_EVENTS, ensureTrusted, findHook } from "../hooks.mjs";
import { assertName, nameProblem, suggestRepoName } from "../names.mjs";
import { allocatePort } from "../ports.mjs";
import { createPrompter, joinArgs, splitArgs } from "../prompt.mjs";
import { copyFile, includePatterns, knownSecretFiles, listFiles, sharedCandidates, templateFiles } from "../shared.mjs";
import { toolStatus } from "../tools.mjs";

function openEditor(ctx, file, prompter) {
  if (!prompter.interactive || prompter.yes) return false;
  const editor = ctx.env.VISUAL || ctx.env.EDITOR;
  let command;
  if (editor) command = [...splitArgs(editor), file];
  else if (process.platform === "win32") command = ["notepad", file];
  else if (process.platform === "darwin") command = ["open", "-W", "-t", file];
  else if (which("xdg-open", ctx.env)) command = ["xdg-open", file];
  else return false;
  spawn.sync(command[0], command.slice(1), { stdio: "inherit" });
  return true;
}

/** The .env file a person points at with --env or by typing its path. */
function envSource(ctx, file) {
  const path = resolve(ctx.cwd, file.replace(/^~(?=$|[\\/])/, homedir()));
  if (!exists(path) || !statSync(path).isFile()) throw new NookError(`No file at ${path}`);
  return path;
}

async function prepareShared(ctx, { repoPath, sharedDir, prompter, envFile }) {
  mkdirSync(sharedDir, { recursive: true });
  if (envFile) {
    copyFile(envSource(ctx, envFile), join(sharedDir, ".env"));
    ctx.note(`Shared .env copied from ${envFile} to ${sharedDir}`);
    return;
  }
  const current = listFiles(sharedDir);
  if (current.length) {
    ctx.note(`Shared files already in ${sharedDir}: ${current.join(", ")}`);
    if (!(await prompter.confirm("Prepare the shared files again?", false))) return;
  }
  const { patterns, source } = includePatterns(repoPath);
  ctx.note(`Shared files follow ${source === "default" ? "the default pattern .env*" : ".worktreeinclude"}; only files git ignores are used`);
  const candidates = sharedCandidates(repoPath, patterns);
  const templates = templateFiles(repoPath);
  const copies = [];
  let fill = null;

  const others = candidates.filter((file) => file !== ".env");
  if (others.length && (await prompter.confirm(`Copy ${others.join(", ")} from the repository into the shared folder?`, true)))
    for (const file of others) copies.push({ from: join(repoPath, file), to: file });

  const choices = templates.map((file) => ({ key: `template:${file}`, label: `Start .env from ${file} and fill it in` }));
  if (candidates.includes(".env"))
    choices.push({ key: "copy", label: "Copy the repository's .env (only if it is a development file, not production)" });
  if (prompter.interactive && !prompter.yes) choices.push({ key: "file", label: "Copy another file on this computer (type its path)" });
  if (choices.length) {
    choices.push({ key: "skip", label: "No .env for now" });
    const pick = await prompter.choose("Where should new workspaces get .env from?", choices, choices[0].key === "copy" ? "skip" : choices[0].key);
    if (pick === "copy") copies.push({ from: join(repoPath, ".env"), to: ".env" });
    else if (pick === "file") {
      for (;;) {
        const typed = (await prompter.ask("Path of the .env file to copy")).replace(/^["']|["']$/g, "");
        if (!typed) break;
        try {
          copies.push({ from: envSource(ctx, typed), to: ".env" });
          break;
        } catch (error) {
          if (!(error instanceof NookError)) throw error;
          ctx.note(error.message);
        }
      }
    }
    else if (pick.startsWith("template:")) {
      copies.push({ from: join(repoPath, pick.slice(9)), to: ".env" });
      fill = join(sharedDir, ".env");
    }
  }

  for (const file of knownSecretFiles(repoPath, candidates))
    if (await prompter.confirm(`Found ignored ${file}. Share it with new workspaces too?`, false))
      copies.push({ from: join(repoPath, file), to: file });

  for (const copy of copies) copyFile(copy.from, join(sharedDir, copy.to));
  if (copies.length) ctx.note(`Shared files: ${copies.map((c) => c.to).join(", ")}`);
  if (fill) {
    if (openEditor(ctx, fill, prompter)) ctx.note(`Saved ${fill}`);
    else ctx.note(`Fill in ${fill} once; every new workspace copies it`);
  }
}

async function setupAgents(ctx, prompter) {
  const found = detectAgents(ctx.env);
  ctx.note(found.length ? "Agents found:" : "No known agents found on PATH");
  for (const agent of found) ctx.note(`  ${agent.name}  ${agent.version || "?"}  ${agent.path}`);
  for (const agent of found) {
    const before = ctx.config.agents[agent.name]?.args ?? [];
    const args = splitArgs(await prompter.ask(`Start arguments for ${agent.name} (empty for none)`, joinArgs(before)));
    ctx.config.agents[agent.name] = { path: agent.path, version: agent.version, args };
  }
  const names = Object.keys(ctx.config.agents);
  if (!names.length) return;
  const fallback = names.includes(ctx.config.default_agent) ? ctx.config.default_agent : names[0];
  ctx.config.default_agent = await prompter.choose(
    "Default agent",
    names.map((name) => ({ key: name, label: name })),
    fallback,
  );
}

async function adoptWorktrees(ctx, { repoPath, repo, prompter }) {
  const known = Object.values(repo.workspaces).map((ws) => ws.path);
  const others = listWorktrees(repoPath)
    .slice(1)
    .filter((w) => !known.some((path) => samePath(path, w.path)));
  if (!others.length) return;
  ctx.note("Other worktrees of this repository:");
  for (const w of others) ctx.note(`  ${w.branch ?? "(detached)"}  ${w.path}`);
  for (const w of others) {
    if (!w.branch || nameProblem(w.branch) || repo.workspaces[w.branch]) {
      ctx.note(`  leaving ${w.path} alone (branch name cannot be a workspace name)`);
      continue;
    }
    if (await prompter.confirm(`Let Nook manage ${w.branch}? (No keeps it as it is)`, false))
      repo.workspaces[w.branch] = { path: w.path, port: await allocatePort(ctx.config), created: new Date().toISOString() };
  }
}

/** nk init: run once per repository; safe to run again. */
export async function init(ctx, { yes = false, name: nameFlag, env: envFile } = {}) {
  const prompter = createPrompter({ yes });
  if (envFile) envSource(ctx, envFile);
  const repoPath = mainWorktree(ctx.cwd);
  if (isInside(repoPath, ctx.paths.home)) throw new NookError("Run nk init in the main repository, not in a workspace");
  const registered = Object.entries(ctx.config.repos).find(([, repo]) => samePath(repo.path, repoPath));
  let name;
  if (registered) {
    name = registered[0];
    if (nameFlag && nameFlag !== name) throw new NookError(`This repository is already registered as "${name}"`);
  } else {
    name = assertName(nameFlag ?? (await prompter.ask("Short name for this repository", suggestRepoName(basename(repoPath)))), "repository");
    if (ctx.config.repos[name]) throw new NookError(`"${name}" is already used for ${ctx.config.repos[name].path}`);
  }

  const repo = (ctx.config.repos[name] ??= { workspaces: {}, hooks: {} });
  repo.path = repoPath;
  repo.remote = remoteUrl(repoPath);
  repo.default_branch = defaultBranch(repoPath);
  repo.workspaces ??= {};
  repo.hooks ??= {};
  ctx.note(`Repository ${name}: ${repoPath}`);
  ctx.note(`  remote ${repo.remote || "(none)"}, default branch ${repo.default_branch}`);
  mkdirSync(join(ctx.paths.workspaces, name), { recursive: true });

  await adoptWorktrees(ctx, { repoPath, repo, prompter });
  await setupAgents(ctx, prompter);
  const tools = toolStatus(ctx.env);
  ctx.note(`gh: ${tools.gh}; docker: ${tools.docker}`);
  await prepareShared(ctx, { repoPath, sharedDir: join(ctx.paths.shared, name), prompter, envFile });
  ctx.save();

  const hookPrompter = yes ? { confirm: async () => true } : prompter;
  for (const event of HOOK_EVENTS) {
    const hook = findHook(repoPath, event);
    if (!hook) continue;
    await ensureTrusted({ repoConfig: repo, hook, prompter: hookPrompter, save: () => ctx.save(), output: ctx.err });
    if (yes) ctx.note(`Allowed .nook/${hook.name} (--yes)`);
  }
  if (!exists(join(repoPath, ".nook"))) ctx.note("No .nook/ hooks in this repository");
  ctx.save();
  ctx.note(`Done. Config: ${ctx.paths.config}`);
  ctx.note(`Next: nk -b <name>${ctx.config.default_agent ? ` [${ctx.config.default_agent}]` : ""}`);
  return 0;
}
