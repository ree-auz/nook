import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import spawn from "cross-spawn";
import { detectAgents, which } from "../agents.mjs";
import { NookError } from "../errors.mjs";
import { isInside, samePath } from "../home.mjs";
import { defaultBranch, listWorktrees, mainWorktree, remoteUrl } from "../git.mjs";
import { ensureTrusted, findHooks } from "../hooks.mjs";
import { assertName, suggestRepoName } from "../names.mjs";
import { createPrompter, splitArgs } from "../prompt.mjs";
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

/**
 * Fills the shared folder. A file already there is never replaced, so running
 * init again only adds what is new (a template added since, for example).
 */
async function prepareShared(ctx, { repoPath, sharedDir, prompter }) {
  mkdirSync(sharedDir, { recursive: true });
  const present = new Set(listFiles(sharedDir));
  const { patterns, source } = includePatterns(repoPath);
  ctx.info(`Shared files follow ${source === "default" ? "the default pattern .env*" : ".worktreeinclude"}; only files git ignores are used`);
  const candidates = sharedCandidates(repoPath, patterns);
  const templates = templateFiles(repoPath);
  const copies = [];
  const fill = [];
  for (const template of templates) {
    if (present.has(template.to)) continue;
    // A committed template is the safe start: the same file in the main checkout may be production.
    copies.push({ from: join(repoPath, template.from), to: template.to });
    fill.push(join(sharedDir, template.to));
    ctx.info(`Starting shared ${template.to} from ${template.from}`);
  }
  const covered = new Set([...templates.map((template) => template.to), ...present]);
  const others = candidates.filter((file) => !covered.has(file));
  if (others.length && (await prompter.confirm(`Copy ${others.join(", ")} from the repository into the shared folder? (only development files, not production)`, false)))
    for (const file of others) copies.push({ from: join(repoPath, file), to: file });

  for (const file of knownSecretFiles(repoPath, [...candidates, ...covered]))
    if (!present.has(file) && (await prompter.confirm(`Found ignored ${file}. Share it with new workspaces too?`, false)))
      copies.push({ from: join(repoPath, file), to: file });

  for (const copy of copies) copyFile(copy.from, join(sharedDir, copy.to));
  if (present.size) ctx.info(`Kept shared files: ${[...present].join(", ")} (edit them in ${sharedDir})`);
  if (copies.length) ctx.ok(`Shared files in ${sharedDir}: ${copies.map((c) => c.to).join(", ")}`);
  for (const file of fill) {
    if (openEditor(ctx, file, prompter)) ctx.ok(`Saved ${file}`);
    else ctx.warn(`Fill in ${file} once; every new workspace copies it`);
  }
}

/**
 * Records the agents on PATH. Nothing is asked: each starts with its own
 * default command, and `args` in config.toml can be edited later if wanted.
 */
function recordAgents(ctx) {
  const found = detectAgents(ctx.env);
  ctx.info(found.length ? "Agents found (start one with nk <name> <agent>):" : "No known agents found on PATH");
  for (const agent of found) {
    ctx.item(`${agent.name}  ${agent.version || "?"}  ${agent.path}`);
    const args = ctx.config.agents[agent.name]?.args ?? [];
    ctx.config.agents[agent.name] = { path: agent.path, version: agent.version, args };
  }
}

/** Worktrees other tools made need no adopting: nk ls, rm and clean read them from git. */
function listOtherWorktrees(ctx, { repoPath, repo }) {
  const known = Object.values(repo.workspaces).map((ws) => ws.path);
  const others = listWorktrees(repoPath)
    .slice(1)
    .filter((w) => !known.some((path) => samePath(path, w.path)));
  if (!others.length) return;
  ctx.info(`Other worktrees of this repository (nk ls, nk rm and nk clean include them):`);
  for (const w of others) ctx.item(`${w.branch ?? "(detached)"}  ${w.path}`);
}

const SETUP_DOC = "https://github.com/ree-auz/nook/blob/main/docs/setup-hooks.md";

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
  ctx.ok(`Registered ${name} @ ${repoPath}`);
  ctx.info(`Remote ${repo.remote || "(none)"}, default branch ${repo.default_branch}`);
  mkdirSync(join(ctx.paths.workspaces, name), { recursive: true });

  listOtherWorktrees(ctx, { repoPath, repo });
  recordAgents(ctx);
  const tools = toolStatus(ctx.env);
  ctx.info(`gh: ${tools.gh}; docker: ${tools.docker}`);
  await prepareShared(ctx, { repoPath, sharedDir: join(ctx.paths.shared, name), prompter });
  ctx.save();

  const hookPrompter = yes ? { confirm: async () => true } : prompter;
  const hooks = findHooks(repoPath);
  await ensureTrusted({ repoName: name, repoConfig: repo, hooks, prompter: hookPrompter, save: () => ctx.save(), ui: ctx });
  if (yes && hooks.length) ctx.info(`Allowed ${hooks.map((h) => `.nook/${h.name}`).join(", ")} (--yes)`);
  if (!hooks.length) ctx.info(`No .nook/ hooks yet. To have your agent write them, give it the prompt in ${SETUP_DOC}`);
  ctx.save();
  ctx.ok(`Done. Config: ${ctx.paths.config}`);
  ctx.info("Next: nk -b <name> [agent]");
  return 0;
}
