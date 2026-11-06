import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createContext } from "./context.mjs";
import { NookError } from "./errors.mjs";
import { doctor } from "./commands/doctor.mjs";
import { init } from "./commands/init.mjs";
import { createPrompter } from "./prompt.mjs";
import { line, useColor } from "./ui.mjs";
import { cleanWorkspaces } from "./commands/clean.mjs";
import { listWorkspaces } from "./commands/ls.mjs";
import { removeWorkspace } from "./commands/rm.mjs";
import { createWorkspace, openWorkspace } from "./commands/workspace.mjs";
import { writeHooks } from "./commands/write-hooks.mjs";
import { listHooks } from "./commands/hooks.mjs";
import { testHooks } from "./commands/check-hooks.mjs";

const HELP = `nk - one home for your git worktrees

Usage:
  nk init [--yes] [--name <short-name>]   register this repository (once per repository)
  nk -b <name> [agent] [-p <prompt>] [-y] create a workspace; start the agent if given
                                         (-y: keep the converted name without asking)
  nk <name> [agent] [-p <prompt>]         open a workspace; start the agent if given
  nk ls [--json]                          list workspaces: changes, commits, PR and CI
  nk rm <name>... [-n] [-y]               back up and remove workspaces
  nk clean [-n] [-y]                      remove workspaces whose work is merged
  nk hooks                                the repository's .nook hooks: allowed? tested?
  nk hooks write [agent]                  an agent writes the hooks in a workspace of its own
                                         (no agent: print the prompt to give one yourself)
  nk hooks test                           run this folder's hooks in a temporary workspace;
                                         fails if remove leaves anything behind
  nk doctor                               check nk's tools: node, git, gh, docker, agents

Options:
  --repo <short-name>   act on another registered repository (otherwise: the one you are in)
  -- <args...>          extra arguments for the agent
Home folder: ~/nook (set NOOK_HOME to move it)`;

function version() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

/** Splits argv at "--": everything after it goes to the agent untouched. */
function splitExtra(argv) {
  const index = argv.indexOf("--");
  return index === -1 ? [argv, []] : [argv.slice(0, index), argv.slice(index + 1)];
}

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new NookError(`${error.message}\nRun nk --help for usage`);
  }
}

export async function run(argv, io = {}) {
  const [args, extra] = splitExtra(argv);
  const [first] = args;
  if (!args.length || first === "help" || first === "--help" || first === "-h") {
    (io.out ?? process.stdout).write(`${HELP}\n`);
    return 0;
  }
  if (first === "version" || first === "--version" || first === "-v") {
    (io.out ?? process.stdout).write(`${version()}\n`);
    return 0;
  }
  const ctx = createContext(io);

  switch (first) {
    case "init": {
      const { values } = parse(args.slice(1), { yes: { type: "boolean", short: "y" }, name: { type: "string" } });
      return init(ctx, values);
    }
    case "ls": {
      const { values } = parse(args.slice(1), { repo: { type: "string" }, json: { type: "boolean" } });
      return listWorkspaces(ctx, values);
    }
    case "rm": {
      const { values, positionals } = parse(args.slice(1), {
        "dry-run": { type: "boolean", short: "n" },
        yes: { type: "boolean", short: "y" },
        repo: { type: "string" },
      });
      if (!positionals.length) throw new NookError("Usage: nk rm <name>... [-n] [-y]");
      return removeWorkspace(ctx, { names: positionals, repo: values.repo, dryRun: values["dry-run"], yes: values.yes });
    }
    case "hooks": {
      const { values, positionals } = parse(args.slice(1), { repo: { type: "string" }, yes: { type: "boolean", short: "y" } });
      const [action, agent, ...rest] = positionals;
      if (!action && !agent) return listHooks(ctx, values);
      if (action === "write" && !rest.length) return writeHooks(ctx, { repo: values.repo, agent, extra, prompter: createPrompter({ yes: values.yes }) });
      if (action === "test" && !agent) return testHooks(ctx, { repo: values.repo });
      throw new NookError("Usage: nk hooks | nk hooks write [agent] | nk hooks test");
    }
    case "doctor":
      parse(args.slice(1), {});
      return doctor(ctx);
    case "clean": {
      const { values } = parse(args.slice(1), {
        "dry-run": { type: "boolean", short: "n" },
        yes: { type: "boolean", short: "y" },
        repo: { type: "string" },
      });
      return cleanWorkspaces(ctx, { repo: values.repo, dryRun: values["dry-run"], yes: values.yes });
    }
    default: {
      const { values, positionals } = parse(args, {
        b: { type: "string", short: "b" },
        prompt: { type: "string", short: "p" },
        repo: { type: "string" },
        yes: { type: "boolean", short: "y" },
      });
      const create = values.b !== undefined;
      const name = create ? values.b : positionals.shift();
      if (!name || positionals.length > 1) throw new NookError("Usage: nk [-b] <name> [agent] [-p <prompt>]");
      const options = { name, repo: values.repo, agent: positionals[0], prompt: values.prompt, extra };
      return create ? createWorkspace(ctx, { ...options, prompter: createPrompter({ yes: values.yes }) }) : openWorkspace(ctx, options);
    }
  }
}

export async function main(argv, io = {}) {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof NookError) {
      const err = io.err ?? process.stderr;
      const color = useColor(err, io.env ?? process.env);
      // First line says what failed; later lines say why and what to do next.
      const [first, ...rest] = error.message.split("\n");
      const lines = [line("fail", first, color)];
      for (const text of rest) lines.push(/^\s/.test(text) ? line("item", text.trim(), color) : line("info", text, color));
      err.write(`${lines.join("\n")}\n`);
      return error.code;
    }
    throw error;
  }
}
