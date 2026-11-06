import { readdirSync } from "node:fs";
import { join } from "node:path";
import { which } from "../agents.mjs";
import { exists, samePath } from "../home.mjs";
import { gitTry, listWorktrees } from "../git.mjs";
import { line, useColor } from "../ui.mjs";
import { HOOK_EVENTS, findHook, trustState } from "../hooks.mjs";
import { gitVersion, toolStatus } from "../tools.mjs";

/** nk doctor: checks only, changes nothing. Exit 1 when something is broken. */
export function doctor(ctx) {
  let broken = 0;
  const color = useColor(ctx.out, ctx.env);
  const ok = (text) => ctx.print(`  ${line("ok", text, color)}`);
  const warn = (text) => ctx.print(`  ${line("warn", text, color)}`);
  const bad = (text) => {
    broken++;
    ctx.print(`  ${line("fail", text, color)}`);
  };

  ctx.print("Basics");
  const major = Number(process.versions.node.split(".")[0]);
  (major >= 20 ? ok : bad)(`node ${process.versions.node}${major >= 20 ? "" : " (need 20 or newer)"}`);
  const gv = gitVersion();
  if (!gv) bad("git not found");
  else (gv.major > 2 || (gv.major === 2 && gv.minor >= 20) ? ok : bad)(gv.text);
  ok(`home ${ctx.paths.home}${ctx.env.NOOK_HOME ? " (from NOOK_HOME)" : ""}`);
  (exists(ctx.paths.config) ? ok : warn)(`config ${ctx.paths.config}${exists(ctx.paths.config) ? "" : " (missing; run nk init)"}`);
  const tools = toolStatus(ctx.env);
  (tools.gh === "logged in" ? ok : warn)(`gh ${tools.gh}`);
  (tools.docker === "running" ? ok : warn)(`docker ${tools.docker}`);

  ctx.print("Agents");
  const agents = Object.entries(ctx.config.agents);
  if (!agents.length) warn("none recorded (nk init records them)");
  for (const [name, agent] of agents) {
    const found = agent.path && exists(agent.path) ? agent.path : which(name, ctx.env);
    (found ? ok : warn)(`${name} ${found ?? "not found"}`);
  }

  for (const [repoName, repo] of Object.entries(ctx.config.repos)) {
    ctx.print(`Repository ${repoName}`);
    if (!exists(repo.path) || !gitTry(["rev-parse", "--git-dir"], { cwd: repo.path }).ok) {
      bad(`${repo.path} is not a git repository`);
      continue;
    }
    ok(repo.path);
    const shared = join(ctx.paths.shared, repoName);
    (exists(shared) ? ok : warn)(`shared folder ${shared}${exists(shared) ? "" : " (missing)"}`);
    for (const event of HOOK_EVENTS) {
      const hook = findHook(repo.path, event);
      if (!hook) continue;
      const state = trustState(repo, hook);
      (state === "trusted" ? ok : warn)(`hook .nook/${hook.name} ${state === "trusted" ? "allowed" : `${state}, will ask before running`}`);
    }
    const worktrees = listWorktrees(repo.path);
    for (const [name, ws] of Object.entries(repo.workspaces)) {
      const known = worktrees.find((w) => samePath(w.path, ws.path));
      if (!exists(ws.path)) bad(`workspace ${name}: ${ws.path} is missing (nk rm ${name} cleans up)`);
      else if (!known) bad(`workspace ${name}: ${ws.path} is not a git worktree`);
      else if (known.branch !== (ws.branch ?? name)) warn(`workspace ${name}: checked out ${known.branch ?? "detached HEAD"}`);
      else ok(`workspace ${name}`);
    }
    const dir = join(ctx.paths.workspaces, repoName);
    if (exists(dir))
      for (const entry of readdirSync(dir)) if (!repo.workspaces[entry]) warn(`${join(dir, entry)} is not a known workspace`);
  }

  ctx.print(broken ? `${broken} problem(s) found` : "No problems found");
  return broken ? 1 : 0;
}
