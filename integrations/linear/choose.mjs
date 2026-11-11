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
 * <effort>". `<model>` is looked up in `models`, whose entries are:
 *   "gpt-6-luna"                              the id, for any agent
 *   { "id": "gpt-6-luna", "agent": "codex" }  the id of one agent's model
 *   { "codex": "gpt-6-astra", "claude": "claude-opus-5-5" }
 *                                             a tier: each agent's model for it
 * A tier's model can be { "id", "effort" }; an effort in the label wins.
 * A name not in `models` is taken as the model's id.
 * Returns { id, agent, tier, effort, label, level } or null; for a tier,
 * `tier` holds the agents' models and `id` is chosen later, by agent.
 */
export function modelFromLabels(prompt, group, { models = {}, efforts = {} } = {}) {
  if (!group) return null;
  const label = labelsFromPrompt(prompt).find((l) => l.group === group);
  if (!label) return null;
  const [name, level] = label.name.split("·").map((part) => part.trim());
  const entry = lookup(models, name);
  let found;
  if (typeof entry === "string") found = { id: entry, agent: null, tier: null };
  else if (entry && "id" in entry) found = { id: entry.id, agent: entry.agent ?? null, tier: null };
  else if (entry) found = { id: null, agent: null, tier: entry };
  else found = { id: name, agent: null, tier: null };
  let effort = null;
  if (level) effort = lookup(efforts, level) ?? (EFFORTS.includes(level.toLowerCase()) ? level.toLowerCase() : undefined);
  return { ...found, effort, label: show(label), level };
}

/** The effort a label of group `group` names, mapped through `efforts`: { effort, label, name } or null. */
export function effortFromLabels(prompt, group, efforts = {}) {
  if (!group) return null;
  const label = labelsFromPrompt(prompt).find((l) => l.group === group);
  if (!label) return null;
  const effort = lookup(efforts, label.name) ?? (EFFORTS.includes(label.name.toLowerCase()) ? label.name.toLowerCase() : undefined);
  return { effort, label: show(label), name: label.name };
}

/** A tier's model for one agent: { id, effort } or null. */
function tierModel(tier, agent) {
  const value = lookup(tier, agent);
  if (!value) return null;
  return typeof value === "string" ? { id: value, effort: null } : { id: value.id, effort: value.effort ?? null };
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
  const effortLabel = effortFromLabels(prompt, labels.effort, config.efforts);
  if (effortLabel?.effort === undefined && effortLabel) notes.push(`${effortLabel.label}: "${effortLabel.name}" is not an effort; add it to "efforts" in the config (say "${effortLabel.name}": "high")`);
  const fromLabel = agentFromLabels(prompt, labels.agent);
  // An issue with only a model label gets the agent that model belongs to.
  const agent = fromLabel ?? found?.agent ?? flags.agent ?? config.agent ?? "codex";
  let model = null;
  if (found) {
    const fromTier = found.tier && tierModel(found.tier, agent);
    if (found.level && !found.effort) notes.push(`${found.label}: "${found.level}" is not an effort; add it to "efforts" in the config (say "${found.level}": "high")`);
    if (found.agent && found.agent !== agent) notes.push(`${found.label} is a ${found.agent} model; ${agent} starts with its own default`);
    else if (found.tier && !fromTier) notes.push(`${found.label}: the config gives no ${agent} model for it; ${agent} starts with its own default`);
    else if (fromTier) model = { id: fromTier.id, effort: found.effort ?? fromTier.effort };
    else model = { id: found.id, effort: found.effort ?? null };
  }
  // A label of the effort group wins over the model label's and the tier's effort.
  if (model && effortLabel?.effort) model = { ...model, effort: effortLabel.effort };
  else if (!model && effortLabel?.effort && !found) notes.push(`${effortLabel.label} needs a model label too: the effort is passed with a model`);
  const terminalLabel = terminalFromLabels(prompt, labels.terminal);
  const terminal = terminalLabel === undefined ? (flags.terminal ?? config.terminal ?? null) : terminalLabel;
  if (model?.effort && agent !== "codex" && terminal !== "orca") notes.push(`effort ${model.effort} is passed only to codex, or to any agent through Orca; ${agent} starts with its default effort`);
  return { agent, model, terminal, orca: flags.orca ?? config.orca ?? "orca", notes };
}
