import { readdirSync } from "node:fs";
import { join } from "node:path";
import { which } from "../agents.mjs";
import { exists, samePath } from "../home.mjs";
import { gitTry, listWorktrees } from "../git.mjs";
import { line, useColor } from "../ui.mjs";
import { dockerCli, leftoverComposeProjects } from "../compose.mjs";
import { ciChanged, uncheckedHooks } from "./check-hooks.mjs";
import { HOOK_EVENTS, findHook, trustState } from "../hooks.mjs";
import { gitVersion, toolStatus } from "../tools.mjs";

/** nk doctor: checks only, changes nothing. Exit 1 when something is broken. */
export function doctor(ctx, { docker = dockerCli } = {}) {
  let broken = 0;
  let warnings = 0;
  const color = useColor(ctx.out, ctx.env);
  const ok = (text) => ctx.print(`  ${line("ok", text, color)}`);
  const warn = (text) => {
    warnings++;
    ctx.print(`  ${line("warn", text, color)}`);
  };
  const bad = (text) => {
    broken++;
    ctx.print(`  ${line("fail", text, color)}`);
  };

  ctx.print("Basics");
  const [major, minor] = process.versions.node.split(".").map(Number);
  const recent = major > 20 || (major === 20 && minor >= 12);
  (recent ? ok : bad)(`node ${process.versions.node}${recent ? "" : " (need 20.12 or newer)"}`);
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
    const hooks = HOOK_EVENTS.map((event) => findHook(repo.path, event)).filter(Boolean);
    const notAllowed = hooks.filter((hook) => trustState(repo, hook) !== "trusted").length;
    const untested = uncheckedHooks(repo).length;
    const issues = [notAllowed && `${notAllowed} not allowed yet`, untested && `${untested} not tested since changed`, ciChanged(repo) && "CI changed since they were tested"].filter(Boolean);
    if (!hooks.length) ok("no hooks (nk hooks write <agent> has an agent write them)");
    else (issues.length ? warn : ok)(`hooks ${hooks.map((hook) => hook.event).join(", ")}${issues.length ? `: ${issues.join(", ")} (see nk hooks)` : ""}`);
    const worktrees = listWorktrees(repo.path);
    for (const [name, ws] of Object.entries(repo.workspaces)) {
      const known = worktrees.find((w) => samePath(w.path, ws.path));
      if (!exists(ws.path)) bad(`workspace ${name}: ${ws.path} is missing (nk rm ${name} cleans up)`);
      else if (!known) bad(`workspace ${name}: ${ws.path} is not a git worktree`);
      else if (known.branch !== (ws.branch ?? name)) warn(`workspace ${name}: checked out ${known.branch ?? "detached HEAD"}`);
      else ok(`workspace ${name}`);
    }
    const dir = join(ctx.paths.workspaces, repoName);
    if (tools.docker === "running")
      for (const project of leftoverComposeProjects(dir, worktrees.map((w) => w.path), docker))
        warn(`Compose project ${project.name} was started in ${project.dir}, which is no longer a workspace (remove it with: docker compose -p ${project.name} down --volumes)`);
    if (exists(dir))
      for (const entry of readdirSync(dir)) {
        if (repo.workspaces[entry]) continue;
        const path = join(dir, entry);
        // A git worktree nk did not create, or a folder left behind when a removal failed halfway.
        warn(
          worktrees.some((w) => samePath(w.path, path))
            ? `${path} is a git worktree nk did not create (remove it with: git worktree remove)`
            : `${path} is not a workspace, only a leftover folder (nk clean deletes it)`,
        );
      }
  }

  const notes = warnings ? `, ${warnings} warning(s)` : "";
  ctx.print(broken ? `${broken} problem(s) found${notes}` : `No problems found${notes}`);
  return broken ? 1 : 0;
}
