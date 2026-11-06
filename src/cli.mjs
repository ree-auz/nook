import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createContext } from "./context.mjs";
import { NookError } from "./errors.mjs";
import { doctor } from "./commands/doctor.mjs";
import { init } from "./commands/init.mjs";
import { line, useColor } from "./ui.mjs";
import { listWorkspaces } from "./commands/ls.mjs";
import { removeWorkspace } from "./commands/rm.mjs";
import { createWorkspace, openWorkspace } from "./commands/workspace.mjs";

const HELP = `nk - one home for your git worktrees

Usage:
  nk init [--yes] [--name <short-name>]   register this repository (once per repository)
  nk -b <name> [agent] [-p <prompt>]      create a workspace; start the agent if given
  nk <name> [agent] [-p <prompt>]         open a workspace; start the agent if given
  nk ls                                   list workspaces and whether they have changes
  nk rm <name> [-n] [-y]                  back up and remove a workspace
  nk doctor                               check the setup, change nothing

Options:
  --repo <short-name>   pick the repository when it is not clear from the folder
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
      const { values } = parse(args.slice(1), { repo: { type: "string" } });
      return listWorkspaces(ctx, values);
    }
    case "rm": {
      const { values, positionals } = parse(args.slice(1), {
        "dry-run": { type: "boolean", short: "n" },
        yes: { type: "boolean", short: "y" },
        repo: { type: "string" },
      });
      if (positionals.length !== 1) throw new NookError("Usage: nk rm <name> [-n] [-y]");
      return removeWorkspace(ctx, { name: positionals[0], repo: values.repo, dryRun: values["dry-run"], yes: values.yes });
    }
    case "doctor":
      parse(args.slice(1), {});
      return doctor(ctx);
    case "clean":
      throw new NookError("nk clean is not available yet");
    default: {
      const { values, positionals } = parse(args, {
        b: { type: "string", short: "b" },
        prompt: { type: "string", short: "p" },
        repo: { type: "string" },
      });
      const create = values.b !== undefined;
      const name = create ? values.b : positionals.shift();
      if (!name || positionals.length > 1) throw new NookError("Usage: nk [-b] <name> [agent] [-p <prompt>]");
      const options = { name, repo: values.repo, agent: positionals[0], prompt: values.prompt, extra };
      return create ? createWorkspace(ctx, options) : openWorkspace(ctx, options);
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
