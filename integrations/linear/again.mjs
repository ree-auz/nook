/**
 * What to do when an issue that already has a workspace is started again:
 * keep working there, start over in it, run it once more next to it (another
 * agent, model or effort), replace it, or only open it. "again" in the config
 * picks one; "ask" (the default) shows the list in Linear's window.
 */
import { normalizeName } from "../../src/names.mjs";

export const AGAIN = {
  continue: "Continue: start the agent in the workspace, without Linear's prompt",
  prompt: "Start over in the workspace: the agent gets Linear's prompt again; the changes stay",
  new: "Run again next to it: a new workspace and branch, for another agent, model or effort",
  over: "Replace it: remove the workspace (nk rm backs up its changes first), then start fresh",
  shell: "Only open the workspace: no agent",
};

/** The "again" setting: one of AGAIN's keys, or "ask". */
export function againSetting(flags = {}, config = {}) {
  const value = flags.again ?? config.again ?? "ask";
  if (value !== "ask" && !(value in AGAIN)) throw new Error(`"again" is "${value}"; use ask, ${Object.keys(AGAIN).join(", ")}`);
  return value;
}

/** The choices for a terminal: Orca starts agents only, so it has no "shell". */
export function againChoices(terminal) {
  return Object.keys(AGAIN).filter((key) => !(terminal === "orca" && key === "shell"));
}

/** The first free branch next to `branch`: <branch>-2, -3, ... */
export function nextBranch(branch, workspaces) {
  const taken = new Set(workspaces.flatMap((ws) => [ws.branch, ws.name]));
  for (let n = 2; ; n++) {
    const candidate = `${branch}-${n}`;
    if (!taken.has(candidate) && !taken.has(normalizeName(candidate))) return candidate;
  }
}
