import { rmSync } from "node:fs";
import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { exists, isInside } from "../home.mjs";
import { baseRef, gitTry } from "../git.mjs";
import { findHook } from "../hooks.mjs";
import { backupDir, createBackup, inspectWorkspace, needsBackup } from "../backup.mjs";
import { describeOccupants, findOccupants, stopProcesses } from "../occupancy.mjs";
import { createPrompter } from "../prompt.mjs";
import { resolveWorkspace } from "../context.mjs";
import { toName } from "../names.mjs";
import { hook } from "./workspace.mjs";

function occupants(ctx, path, scan) {
  ctx.note("Checking for programs running in the folder...");
  const result = scan(path);
  if (result.unsupported) ctx.note(`Could not check for running programs: ${result.unsupported}`);
  return result.processes;
}

/** nk rm <name> [-n] [-y] */
export async function removeWorkspace(ctx, { name: input, repo: repoFlag, dryRun = false, yes = false, scan = findOccupants, stop = stopProcesses, prompter = createPrompter() }) {
  const name = toName(input);
  const target = resolveWorkspace(ctx, name, repoFlag);
  const { repo, ws } = target;
  if (exists(ws.path) && isInside(ctx.cwd, ws.path))
    throw new NookError(`You are inside ${ws.path}. Change to another folder first, e.g. cd ${repo.path}`);

  const base = baseRef(repo.path, repo.default_branch);
  const state = inspectWorkspace({ repo: repo.path, path: ws.path, branch: name, base });
  const backupRoot = join(ctx.paths.backup, target.repoName);
  const removeHook = state.present ? findHook(ws.path, "remove") : null;

  ctx.note(`nk rm ${name} will:`);
  if (needsBackup(state)) ctx.note(`  back up changes to ${backupRoot}`);
  if (removeHook) ctx.note(`  run .nook/${removeHook.name}`);
  ctx.note(`  delete ${state.present ? ws.path : `${ws.path} (already missing)`}`);
  ctx.note(`  delete branch ${name}`);
  if (state.changes.length) {
    ctx.note(`  ! ${state.changes.length} uncommitted change(s):`);
    for (const line of state.changes.slice(0, 10)) ctx.note(`      ${line}`);
    if (state.changes.length > 10) ctx.note(`      ... ${state.changes.length - 10} more`);
  }
  if (state.unpushed.length) ctx.note(`  ! ${state.unpushed.length} commit(s) not pushed`);
  if (!state.merged) ctx.note(`  ! branch ${name} is not merged into ${base}`);
  if (dryRun) return 0;

  const running = state.present ? occupants(ctx, ws.path, scan) : [];
  if (running.length) ctx.note(`Programs running in ${ws.path}:\n${describeOccupants(running)}`);
  if (!yes) {
    const question = running.length ? `Stop ${running.length === 1 ? "it" : "them"} and remove ${name}?` : `Remove ${name}?`;
    let ok;
    try {
      ok = await prompter.confirm(question, false);
    } catch {
      throw new NookError("Confirmation needs a terminal; pass -y to remove without asking");
    }
    if (!ok) throw new NookError("Nothing was removed");
  }
  if (running.length) {
    await stop(running);
    const left = occupants(ctx, ws.path, scan);
    if (left.length) throw new NookError(`Could not stop:\n${describeOccupants(left)}\nNothing was removed`);
  }

  if (needsBackup(state)) {
    const dir = createBackup({ repo: repo.path, path: ws.path, branch: name, base, state, dir: backupDir(backupRoot, name) });
    ctx.note(`Backed up to ${dir}`);
  }
  if (state.present) {
    try {
      await hook(ctx, target, "remove", { prompter });
    } catch (error) {
      if (error instanceof NookError) error.message += "\nStopped; nothing was deleted";
      throw error;
    }
    const after = occupants(ctx, ws.path, scan);
    if (after.length) throw new NookError(`Programs started running in ${ws.path}:\n${describeOccupants(after)}\nNothing was deleted`);
    const removed = gitTry(["worktree", "remove", "--force", ws.path], { cwd: repo.path });
    if (!removed.ok && exists(ws.path)) {
      try {
        rmSync(ws.path, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        throw new NookError(`Could not delete ${ws.path}: ${error.message}`);
      }
    }
  }
  gitTry(["worktree", "prune"], { cwd: repo.path });
  const branch = gitTry(["branch", "-D", name], { cwd: repo.path });
  if (!branch.ok && !/not found/i.test(branch.err)) ctx.note(`Branch ${name} was kept: ${branch.err}`);
  delete repo.workspaces[name];
  ctx.save();
  ctx.note(`Removed ${name}`);
  return 0;
}
