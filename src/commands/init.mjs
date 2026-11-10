import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import spawn from "cross-spawn";
import { detectAgents, which } from "../agents.mjs";
import { NookError } from "../errors.mjs";
import { isInside, samePath } from "../home.mjs";
import { defaultBranch, listWorktrees, mainWorktree, remoteUrl } from "../git.mjs";
import { ensureTrusted, findHooks, trustState } from "../hooks.mjs";
import { assertName, suggestRepoName } from "../names.mjs";
import { createPrompter, splitArgs } from "../prompt.mjs";
import { copyFile, includePatterns, knownSecretFiles, listFiles, sharedCandidates, templateFiles } from "../shared.mjs";
import { toolStatus } from "../tools.mjs";
import { hostAddresses, pointAtHost } from "../compose-plan.mjs";
import { planFromCi } from "../ci.mjs";
import { installInto, profileState, profiles } from "./shell-init.mjs";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
  // A template for running the app inside Docker names Compose services (postgres:5432); here the app runs on
  // this machine, so point those values at where the services are published.
  // When the CI job has services, those are started instead of Compose's (see nk hooks write).
  const addresses = fill.length ? hostAddresses(repoPath, { start: !planFromCi(repoPath).best?.services.length }) : {};
  if (Object.keys(addresses).length)
    for (const file of fill) {
      const { text, keys } = pointAtHost(readFileSync(file, "utf8"), addresses);
      if (!keys.length) continue;
      writeFileSync(file, text);
      ctx.info(`Pointed ${keys.join(", ")} in ${basename(file)} at the Compose services on this machine (each workspace then uses its own ports)`);
    }
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

/**
 * nks, the shell function that goes to a workspace, has to be in the shell's
 * profile. In a terminal, init offers to put it there once; it is not asked
 * again once it is in. With --yes or without a terminal nothing is written to
 * a profile: an agent or a script running init has no say over the user's shell.
 */
async function offerNks(ctx, prompter, find) {
  if (!prompter.interactive || prompter.yes) {
    ctx.info("To go to a workspace from your shell (nks): nk shell-init --install");
    return;
  }
  const targets = find({ env: ctx.env }).filter((target) => profileState(target.file, target.shell) !== "current");
  if (!targets.length) return;
  const files = targets.map((target) => target.file).join(" and ");
  if (await prompter.confirm(`Add nks to ${files}? (nks shows your workspaces and goes to the one you choose)`, true)) installInto(ctx, targets);
  else ctx.info("Later, if you want it: nk shell-init --install");
}

/** nk init: run once per repository; safe to run again. */
export async function init(ctx, { yes = false, allowHooks = false, name: nameFlag, prompter = createPrompter({ yes }), shellProfiles = profiles } = {}) {
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

  // Allowing hooks lets this repository's scripts run on this machine: --yes skips questions, but
  // only --allow-hooks (or a person answering in a terminal) gives that.
  const hooks = findHooks(repoPath);
  const pending = hooks.filter((hook) => trustState(repo, hook) !== "trusted");
  if (pending.length && !allowHooks && (yes || !prompter.interactive)) {
    ctx.warn(`${plural(pending.length, "hook")} not allowed yet: ${pending.map((h) => `.nook/${h.name}`).join(", ")}`);
    ctx.info(`Read them in ${join(repoPath, ".nook")}, then run nk init --allow-hooks, or nk init in a terminal`);
  } else {
    const hookPrompter = allowHooks ? { confirm: async () => true } : prompter;
    await ensureTrusted({ repoName: name, repoConfig: repo, hooks, prompter: hookPrompter, save: () => ctx.save(), ui: ctx });
    if (allowHooks && pending.length) ctx.info(`Allowed ${pending.map((h) => `.nook/${h.name}`).join(", ")} (--allow-hooks)`);
  }
  if (!hooks.length) ctx.info("No .nook/ hooks yet. To have an agent write them: nk hooks write <agent>");
  ctx.save();
  await offerNks(ctx, prompter, shellProfiles);
  ctx.ok(`Done. Config: ${ctx.paths.config}`);
  ctx.info("Next: nk -b <name> [agent]");
  return 0;
}
