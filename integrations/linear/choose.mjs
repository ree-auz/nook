/**
 * What the Linear launcher starts for an issue: the agent, its model and
 * effort, and the terminal, from the issue's labels and a config file.
 * Reads nothing but the config file and runs nothing, so it is easy to test.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KNOWN_AGENTS } from "../../src/agents.mjs";

/** Where the config lives unless --config names another file. */
export const CONFIG_PATH = join(homedir(), ".linear", "nook.json");

/**
 * The config file, or {} when there is none. Shape:
 * { agent, terminal, orca, labels: { agent, model, terminal },
 *   models: { "<label name>": "<id>" | { id, agent } }, efforts: { "<word>": "<effort>" } }
 */
export function loadConfig(path = CONFIG_PATH, { required = false } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!required && error.code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

/** The issue's labels from Linear's prompt, which lists them as <label>Group › Name</label> or <label>Name</label>. */
export function labelsFromPrompt(prompt) {
  return [...prompt.matchAll(/<label>([^<]*)<\/label>/g)].map(([, text]) => {
    const parts = text.split("›").map((part) => part.trim());
    return parts.length > 1 ? { group: parts[0], name: parts.slice(1).join(" › ") } : { group: null, name: parts[0] };
  });
}

const slug = (name) => name.trim().toLowerCase().replace(/\s+/g, "-");
const show = (label) => (label.group ? `${label.group} › ${label.name}` : label.name);

/**
 * The agent an issue's labels name: the label in group `group` ("Agent ›
 * Claude" gets `claude`), else the one label named like a known agent
 * (Codex, Claude, Grok, ...), with or without a group.
 */
export function agentFromLabels(prompt, group, known = KNOWN_AGENTS) {
  const labels = labelsFromPrompt(prompt);
  const inGroup = group && labels.find((label) => label.group === group);
  if (inGroup) return slug(inGroup.name);
  const named = labels.filter((label) => known.includes(slug(label.name)));
  return named.length === 1 ? slug(named[0].name) : null;
}

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** A config entry by name, ignoring case. */
function lookup(map = {}, name) {
  return map[name] ?? Object.entries(map).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * The model a label of group `group` names, as "<model>" or "<model> ·
 * <effort>". The model is an alias from `models` (Luna -> gpt-6-luna, maybe
 * with its agent) or, when it has none, the label's text as the model id.
 * Returns { id, agent, effort, label } or null.
 */
export function modelFromLabels(prompt, group, { models = {}, efforts = {} } = {}) {
  if (!group) return null;
  const label = labelsFromPrompt(prompt).find((l) => l.group === group);
  if (!label) return null;
  const [name, level] = label.name.split("·").map((part) => part.trim());
  const entry = lookup(models, name);
  const { id, agent = null } = typeof entry === "string" ? { id: entry } : (entry ?? { id: name });
  let effort = null;
  if (level) effort = lookup(efforts, level) ?? (EFFORTS.includes(level.toLowerCase()) ? level.toLowerCase() : undefined);
  return { id, agent, effort, label: show(label), level };
}

/** Each agent's own flags for a model and effort, when it starts in a terminal. */
export function agentModelArgs(agent, { id, effort }) {
  if (!id) return [];
  if (agent === "codex") return ["-m", id, ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : [])];
  // Other agents take --model; the effort reaches them only through Orca.
  return ["--model", id];
}

/** Terminal names a label can use, and what --terminal calls them. */
const TERMINAL_NAMES = { wt: "wt", "windows-terminal": "wt", warp: "warp", orca: "orca", here: null, linear: null };

/**
 * Where the agent runs, from a label: the label in group `group`, else the one
 * label named like a terminal (Orca, Warp, Windows Terminal). "Here" or
 * "Linear" keeps the window Linear opened. Returns undefined when no label says.
 */
export function terminalFromLabels(prompt, group) {
  const labels = labelsFromPrompt(prompt);
  const inGroup = group && labels.find((label) => label.group === group);
  if (inGroup) {
    const name = slug(inGroup.name);
    if (!(name in TERMINAL_NAMES)) throw new Error(`Label ${show(inGroup)} is not a terminal; use Orca, Warp, Windows Terminal or Here`);
    return TERMINAL_NAMES[name];
  }
  const named = labels.filter((label) => TERMINAL_NAMES[slug(label.name)]);
  return named.length === 1 ? TERMINAL_NAMES[slug(named[0].name)] : undefined;
}

/**
 * The agent, model and terminal for an issue. Arguments in coding-tools.json
 * (`flags`) win over the config file; labels win over both defaults.
 * notes: why a label was not used, for the first lines in Linear's window.
 */
export function choose(prompt, flags = {}, config = {}) {
  const labels = { ...config.labels, ...(flags.agentLabel ? { agent: flags.agentLabel } : {}), ...(flags.terminalLabel ? { terminal: flags.terminalLabel } : {}) };
  const notes = [];
  const found = modelFromLabels(prompt, labels.model, config);
  const fromLabel = agentFromLabels(prompt, labels.agent);
  // An issue with only a model label gets the agent that model belongs to.
  const agent = fromLabel ?? found?.agent ?? flags.agent ?? config.agent ?? "codex";
  let model = null;
  if (found) {
    if (found.agent && found.agent !== agent) notes.push(`${found.label} is a ${found.agent} model; ${agent} starts with its own default`);
    else {
      if (found.level && !found.effort) notes.push(`${found.label}: "${found.level}" is not an effort; add it to "efforts" in the config (say "${found.level}": "high")`);
      model = { id: found.id, effort: found.effort ?? null };
    }
  }
  const terminalLabel = terminalFromLabels(prompt, labels.terminal);
  const terminal = terminalLabel === undefined ? (flags.terminal ?? config.terminal ?? null) : terminalLabel;
  if (model?.effort && agent !== "codex" && terminal !== "orca") notes.push(`effort ${model.effort} is passed only to codex, or to any agent through Orca; ${agent} starts with its default effort`);
  return { agent, model, terminal, orca: flags.orca ?? config.orca ?? "orca", notes };
}
