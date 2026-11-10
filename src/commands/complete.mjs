// @ts-check
import { SUBCOMMANDS } from "../names.mjs";
import { repoFromCwd, repoWorkspaces } from "../context.mjs";
import { SHELL_NAMES } from "./shell-init.mjs";

/** The options of each command, for completion. "" is nk <name> and nk -b <name>. */
const OPTIONS = {
  "": ["-b", "--prompt", "--repo", "--yes", "--untested", "--help", "--version"],
  init: ["--yes", "--allow-hooks", "--name"],
  ls: ["--json", "--no-pr", "--timing", "--repo"],
  switch: ["--repo"],
  "shell-init": ["--install"],
  rm: ["--dry-run", "--yes", "--repo"],
  clean: ["--dry-run", "--yes", "--repo"],
  hooks: ["--repo"],
  forget: ["--yes"],
  doctor: ["--workspace", "--repo"],
};

/** Names of the workspaces of the repository you are in (or --repo); of every repository outside one. */
function workspaceNames(ctx, repoFlag, { main = true } = {}) {
  const only = repoFlag ?? repoFromCwd(ctx);
  return Object.entries(ctx.config.repos)
    .filter(([name]) => !only || name === only)
    .flatMap(([name, repo]) => repoWorkspaces(name, repo))
    .filter((item) => main || !item.main)
    .map((item) => item.name);
}

/**
 * What can come next on an nk command line. `before` are the words already
 * typed after "nk", `current` the word being typed (may be empty). Only what
 * starts with `current` is returned.
 */
export function candidates(ctx, before, current) {
  const previous = before.at(-1);
  const flagAt = before.indexOf("--repo");
  const repoFlag = flagAt !== -1 && flagAt < before.length - 1 ? before[flagAt + 1] : undefined;
  const repos = () => Object.keys(ctx.config.repos);
  // The words that are neither options nor an option's value: the command and its arguments.
  // The name behind -b counts: it stands where the workspace does in nk <name> <agent>.
  const takesValue = new Set(["--repo", "--name", "--prompt", "-p", "--workspace"]);
  const positionals = before.filter((word, i) => !word.startsWith("-") && !takesValue.has(before[i - 1]));
  const [command] = positionals;
  const known = SUBCOMMANDS.includes(command);

  let found;
  if (previous === "--repo") found = repos();
  else if (previous === "--workspace") found = workspaceNames(ctx, repoFlag);
  else if (previous === "--name" || previous === "--prompt" || previous === "-p" || previous === "-b") found = [];
  else if (current.startsWith("-")) found = OPTIONS[known ? command : ""] ?? [];
  else if (!positionals.length) found = [...workspaceNames(ctx, repoFlag), ...SUBCOMMANDS.filter((name) => name !== "help" && name !== "version")];
  else if (command === "switch") found = positionals.length === 1 ? workspaceNames(ctx, repoFlag) : [];
  else if (command === "rm") found = workspaceNames(ctx, repoFlag, { main: false }).filter((name) => !positionals.includes(name));
  else if (command === "forget") found = positionals.length === 1 ? repos() : [];
  else if (command === "hooks") found = positionals.length === 1 ? ["write", "test"] : positionals[1] === "write" && positionals.length === 2 ? Object.keys(ctx.config.agents ?? {}) : [];
  else if (command === "shell-init") found = positionals.length === 1 ? SHELL_NAMES : [];
  else if (known) found = [];
  // nk <name> <agent>, and nk -b <name> <agent>.
  else found = positionals.length === 1 ? Object.keys(ctx.config.agents ?? {}) : [];
  return [...new Set(found)].filter((word) => word.startsWith(current));
}

/**
 * nk __complete =<current> <before...>: one candidate per line, for the shell
 * functions of nk shell-init. The current word comes first behind "=", since
 * some shells drop an empty argument. Never fails: a Tab must not print errors.
 */
export function complete(ctx, [current = "=", ...before]) {
  try {
    const words = candidates(ctx, before, current.replace(/^=/, ""));
    if (words.length) ctx.print(words.join("\n"));
  } catch {
    /* Nothing to offer. */
  }
  return 0;
}
