/**
 * nkl: start work on Linear issues from the command line. Lists your issues,
 * shows one with its blocks and blocked-by, and starts a Nook workspace with
 * an agent for the one you choose. Only reads Linear; issue states change
 * through Linear's GitHub integration as the branch and its PR move.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPrompter } from "../../src/prompt.mjs";
import { fit, pick, width } from "../../src/select.mjs";
import { line, unicodeSupported, useColor } from "../../src/ui.mjs";
import { agentFromIssue, blockers, cells, identifierFromBranch, isClosed, next, normalizeIdentifier, promptFor, rank, searchText, showLines } from "./issues.mjs";
import { LinearError, createLinear } from "./linear-api.mjs";
import { TERMINALS, startWork, withNodeOnPath, workInOrca } from "./open-issue.mjs";

const bin = fileURLToPath(new URL("../../bin/nkl.mjs", import.meta.url));
const nk = fileURLToPath(new URL("../../bin/nk.mjs", import.meta.url));

export const HELP = `nkl - start work on Linear issues with nook

Usage:
  nkl [filters]                 choose from your unfinished issues (arrows, type to filter,
                                Tab to mark several); Enter starts a workspace and the agent
  nkl <ISSUE> [agent]           start work on one issue, e.g. nkl REE-292 (or reopen its workspace)
  nkl next [filters]            start the first ready issue: nothing blocks it, no workspace yet
  nkl show <ISSUE> [--json]     status, assignee, priority, blocked by, blocks, sub-issues
  nkl prompt <ISSUE>            print the prompt the agent would get
  nkl ls                        nk's workspaces with their issue's status in Linear

Run it in a repository you set up with nk init: the workspace is made there.

Filters:
  --all                         everyone's issues, not only yours
  --team <KEY>                  one team, e.g. --team REE
  --cycle                       only the current cycle
  --project <name>              issues of a project (part of the name is enough)
  --label <name>                issues with a label
  --view <name>                 the issues of a custom view you saved in Linear

Starting:
  --agent <agent>               the agent to start (default codex, or NKL_AGENT)
  --agent-label <group>         let a label pick the agent: group "Agent" and label
                                "Agent › Claude" start claude (or NKL_AGENT_LABEL)
  --terminal wt|warp|orca       where the agents run when you start several; orca also for one
                                (Windows: wt by default; or NKL_TERMINAL)
  --orca <path>                 Orca's command-line tool, if it is not on PATH
  -y, --yes                     do not ask, e.g. when an issue is blocked

Linear access: a personal API key in LINEAR_API_KEY (read access is enough).
`;

const OPTIONS = {
  all: { type: "boolean" },
  team: { type: "string" },
  cycle: { type: "boolean" },
  project: { type: "string" },
  label: { type: "string" },
  view: { type: "string" },
  agent: { type: "string" },
  "agent-label": { type: "string" },
  terminal: { type: "string" },
  orca: { type: "string" },
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  cleanup: { type: "string" },
};

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, linear?: any, out?: any, err?: any, input?: any, start?: Function, workspaces?: Function, open?: Function }} [deps]
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const color = useColor(err, env);
  const say = (kind, text) => err.write(`${line(kind, text, color)}\n`);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: /** @type {any} */ (OPTIONS), allowPositionals: true, strict: true });
  } catch (error) {
    say("fail", `${error.message}\nnkl --help lists the options`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  // A Warp tab config written only for this launch.
  if (opts.cleanup) rmSync(String(opts.cleanup), { force: true });
  if (opts.help || positionals[0] === "help") {
    out.write(HELP);
    return 0;
  }
  const settings = {
    agent: opts.agent ?? env.NKL_AGENT,
    agentLabel: opts["agent-label"] ?? env.NKL_AGENT_LABEL,
    terminal: opts.terminal ?? env.NKL_TERMINAL,
    orca: opts.orca ?? "orca",
    yes: Boolean(opts.yes),
  };
  const run = {
    env,
    out,
    say,
    settings,
    input: deps.input ?? process.stdin,
    err,
    start: deps.start ?? startIssue,
    workspaces: deps.workspaces ?? listWorkspaces,
    open: deps.open ?? openTabs,
  };
  try {
    run.linear = deps.linear ?? createLinear({ key: env.LINEAR_API_KEY });
    const [first, second] = positionals;
    if (first === "show") return await show(run, need(second, "show"), Boolean(opts.json));
    if (first === "prompt") return await printPrompt(run, need(second, "prompt"));
    if (first === "ls") return await ls(run);
    if (first === "next") return await startNext(run, opts);
    if (first) {
      const id = normalizeIdentifier(first);
      if (!id) throw new LinearError(`"${first}" is not an issue like REE-292 or a command\nnkl --help lists them`);
      return await startOne(run, await run.linear.issue(id), second ?? null);
    }
    return await choose(run, opts);
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    say("fail", error.message);
    return 1;
  }
}

function need(id, command) {
  const issue = normalizeIdentifier(id);
  if (!issue) throw new LinearError(`Which issue? nkl ${command} REE-292`);
  return issue;
}

/** The unfinished issues the filters ask for. */
async function fetchIssues(run, opts) {
  if (opts.view) return run.linear.viewIssues(opts.view);
  return run.linear.issues({ mine: !opts.all, team: opts.team, cycle: Boolean(opts.cycle), project: opts.project, label: opts.label });
}

/** The agent for an issue: the one given, else its label, else --agent, else codex. */
function agentFor(run, issue, given) {
  return given || agentFromIssue(issue, run.settings.agentLabel) || run.settings.agent || "codex";
}

/** Identifiers that already have a workspace, from their branch names. */
function workspaceIssues(run) {
  const ids = new Set();
  for (const ws of run.workspaces({ pr: false })) {
    const id = identifierFromBranch(ws.branch) ?? identifierFromBranch(ws.name);
    if (id && !ws.main) ids.add(id);
  }
  return ids;
}

/** nkl: the list to choose from. */
async function choose(run, opts) {
  const issues = rank(await fetchIssues(run, opts));
  if (!issues.length) {
    run.say("info", opts.all ? "No unfinished issues match" : "No unfinished issues are assigned to you. nkl --all shows everyone's");
    return 0;
  }
  if (!run.input.isTTY) {
    // Not on a terminal: print the list, so it can be read or piped.
    for (const issue of issues) run.out.write(`${cells(issue, { unicode: false }).slice(1).join("\t")}\n`);
    return 0;
  }
  const opened = workspaceIssues(run);
  const unicode = unicodeSupported(run.env);
  const { result } = pick({
    input: run.input,
    output: run.err,
    title: `Linear issues${opts.all ? "" : " assigned to you"} (${unicode ? "⛔" : "B"} blocked, ${unicode ? "●" : "*"} has a workspace)`,
    items: issues,
    cells: (issue) => cells(issue, { hasWorkspace: opened.has(issue.identifier), unicode }),
    text: searchText,
    color: useColor(run.err, run.env),
    unicode,
    multi: true,
  });
  const picked = await result;
  if ("cancelled" in picked) return picked.cancelled === "interrupt" ? 130 : 1;
  if (picked.items.length > 1) return startMany(run, picked.items);
  return startOne(run, await run.linear.issue(picked.item.identifier), null);
}

/** nkl next: the first ready issue. */
async function startNext(run, opts) {
  const opened = workspaceIssues(run);
  const issue = next(await fetchIssues(run, opts), (i) => opened.has(i.identifier));
  if (!issue) {
    run.say("info", "No ready issue: each one is blocked or has a workspace already. nkl shows them all");
    return 0;
  }
  run.say("step", `Next: ${issue.identifier} ${issue.title}`);
  return startOne(run, await run.linear.issue(issue.identifier), null);
}

/**
 * Starts one issue. When unfinished issues block it, asks first: start it
 * anyway, start the first blocker instead, or stop.
 */
async function startOne(run, issue, agent) {
  if (isClosed(issue)) run.say("warn", `${issue.identifier} is ${issue.state.name} in Linear`);
  const blocked = blockers(issue);
  if (blocked.length) {
    run.say("warn", `${issue.identifier} is blocked by ${blocked.map((b) => `${b.identifier} ${b.title} (${b.state.name})`).join(", ")}`);
    const prompter = createPrompter({ yes: run.settings.yes, input: run.input, output: run.err });
    if (prompter.interactive && !run.settings.yes) {
      const choice = await prompter.choose(
        "What now?",
        [
          { key: "start", label: `Start ${issue.identifier} anyway` },
          { key: "blocker", label: `Start ${blocked[0].identifier} instead` },
          { key: "stop", label: "Do nothing" },
        ],
        "start",
      );
      if (choice === "stop") return 1;
      if (choice === "blocker") return startOne(run, await run.linear.issue(blocked[0].identifier), agent);
    }
  }
  if (!issue.branchName) throw new LinearError(`${issue.identifier} has no branch name in Linear`);
  const chosen = agentFor(run, issue, agent);
  run.say("step", `${issue.identifier}: ${issue.title} -> ${chosen} on ${issue.branchName}`);
  return run.start({ branch: issue.branchName, agent: chosen, prompt: promptFor(issue), terminal: run.settings.terminal, orca: run.settings.orca });
}

/** Starts the issue in this terminal, or in Orca with --terminal orca. */
function startIssue({ branch, agent, prompt, terminal, orca }) {
  if (terminal === "orca") return workInOrca({ branch, agent, prompt, orca });
  return startWork({ branch, agent, prompt });
}

/** Several issues: one terminal tab each, which runs nkl <ISSUE> -y in it. */
function startMany(run, issues) {
  const terminal = run.settings.terminal ?? (process.platform === "win32" ? "wt" : undefined);
  if (!terminal || terminal === "orca" || !TERMINALS[terminal])
    throw new LinearError(`To start several issues at once, pass --terminal ${Object.keys(TERMINALS).join("|")} (Windows only so far), or start them one at a time`);
  for (const issue of issues) {
    const agent = agentFor(run, issue, null);
    run.say("step", `${issue.identifier}: new ${terminal} tab with ${agent}`);
    run.open(terminal, { dir: process.cwd(), id: issue.identifier, inner: [process.execPath, bin, issue.identifier, agent, "--yes"] });
  }
  return 0;
}

function openTabs(terminal, args) {
  TERMINALS[terminal](args);
}

/** nkl show */
async function show(run, id, json) {
  const issue = await run.linear.issue(id);
  if (json) {
    run.out.write(`${JSON.stringify(issue, null, 2)}\n`);
    return 0;
  }
  run.out.write(`${showLines(issue).join("\n")}\n`);
  return 0;
}

/** nkl prompt */
async function printPrompt(run, id) {
  run.out.write(promptFor(await run.linear.issue(id)));
  return 0;
}

/** nkl ls: each workspace with its issue's status, and the ones that look done. */
async function ls(run) {
  const workspaces = run.workspaces({ pr: true }).filter((ws) => !ws.main);
  if (!workspaces.length) {
    run.say("info", "No workspaces yet. nkl starts one for an issue");
    return 0;
  }
  const ids = workspaces.map((ws) => identifierFromBranch(ws.branch) ?? identifierFromBranch(ws.name));
  const issues = await run.linear.issuesById([...new Set(ids.filter(Boolean))]);
  const rows = [["NAME", "ISSUE", "STATUS", "PR", "TITLE"]];
  const closed = [];
  workspaces.forEach((ws, i) => {
    const issue = ids[i] ? issues.get(ids[i]) : null;
    const pr = ws.pr ? `#${ws.pr.number} ${ws.pr.state}` : "";
    rows.push([ws.name, ids[i] ?? "", issue?.state?.name ?? (ids[i] ? "not found" : ""), pr, issue?.title ?? ""]);
    // Closed in Linear without a merged PR: nk clean keeps these, so they are easy to forget.
    if (issue && isClosed(issue) && ws.pr?.state !== "merged") closed.push(`${ws.name} (${issue.identifier} ${issue.state.name})`);
  });
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => width(row[c]))));
  const columns = run.out.isTTY ? Math.max(40, (run.out.columns ?? 120) - 1) : Infinity;
  for (const row of rows) {
    const text = row.map((cell, c) => (c === row.length - 1 ? cell : cell + " ".repeat(widths[c] - width(cell)))).join("  ");
    run.out.write(`${columns === Infinity ? text : fit(text, columns)}\n`);
  }
  if (closed.length) run.say("warn", `Closed in Linear but not merged: ${closed.join(", ")}. If nothing in them is needed: nk rm <name>`);
  return 0;
}

/** nk ls --json, with or without asking GitHub for PRs. */
function listWorkspaces({ pr }) {
  const result = spawnSync(process.execPath, [nk, "ls", "--json", ...(pr ? [] : ["--no-pr"])], { encoding: "utf8", env: withNodeOnPath() });
  if (result.status !== 0) throw new LinearError(`nk ls failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

