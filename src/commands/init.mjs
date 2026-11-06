import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
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

async function prepareShared(ctx, { repoPath, sharedDir, prompter }) {
  mkdirSync(sharedDir, { recursive: true });
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
  const fill = [];
  for (const template of templates) {
    // A committed template is the safe start: the same file in the main checkout may be production.
    copies.push({ from: join(repoPath, template.from), to: template.to });
    fill.push(join(sharedDir, template.to));
    ctx.note(`Starting shared ${template.to} from ${template.from}`);
  }
  const fromTemplate = new Set(templates.map((template) => template.to));
  const others = candidates.filter((file) => !fromTemplate.has(file));
  if (others.length && (await prompter.confirm(`Copy ${others.join(", ")} from the repository into the shared folder? (only development files, not production)`, false)))
    for (const file of others) copies.push({ from: join(repoPath, file), to: file });

  for (const file of knownSecretFiles(repoPath, [...candidates, ...fromTemplate]))
    if (await prompter.confirm(`Found ignored ${file}. Share it with new workspaces too?`, false))
      copies.push({ from: join(repoPath, file), to: file });

  for (const copy of copies) copyFile(copy.from, join(sharedDir, copy.to));
  if (copies.length) ctx.note(`Shared files: ${copies.map((c) => c.to).join(", ")}`);
  for (const file of fill) {
    if (openEditor(ctx, file, prompter)) ctx.note(`Saved ${file}`);
    else ctx.note(`Fill in ${file} once; every new workspace copies it`);
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
export async function init(ctx, { yes = false, name: nameFlag } = {}) {
  const prompter = createPrompter({ yes });
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
  await prepareShared(ctx, { repoPath, sharedDir: join(ctx.paths.shared, name), prompter });
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
