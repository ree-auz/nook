import { resolveRepo } from "../context.mjs";
import { useColor, line } from "../ui.mjs";
import { HOOK_EVENTS, findHook, hookHash, trustState } from "../hooks.mjs";

/** nk hooks: each hook of the repository, whether it is allowed, and whether it passed nk hooks test. */
export function listHooks(ctx, { repo: repoFlag }) {
  const { name: repoName, repo } = resolveRepo(ctx, repoFlag);
  const color = useColor(ctx.out, ctx.env);
  const hooks = HOOK_EVENTS.map((event) => findHook(repo.path, event)).filter(Boolean);
  ctx.print(`Hooks of ${repoName} (${repo.path}/.nook)`);
  if (!hooks.length) {
    ctx.print(`  ${line("info", "none yet; to have an agent write them: nk hooks write <agent>", color)}`);
    return 0;
  }
  let untested = 0;
  for (const hook of hooks) {
    const trust = trustState(repo, hook);
    const tested = repo.checked?.[hook.name] === hookHash(hook.file);
    if (!tested) untested++;
    const notes = [trust === "trusted" ? "allowed" : trust === "new" ? "not allowed yet" : "changed, will ask again", tested ? "tested" : "not tested since it changed"];
    ctx.print(`  ${line(tested && trust === "trusted" ? "ok" : "warn", `${hook.event.padEnd(6)} .nook/${hook.name}  ${notes.join(", ")}`, color)}`);
  }
  if (untested) ctx.print(`  ${line("info", "Test them: nk hooks test", color)}`);
  return 0;
}
