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
 * { agent, terminal, open, closeLinearWindow, orca, wezterm, labels: { agent, model, effort, terminal },
 *   agents: { "<label name>": "<command>" }, terminals: { "<label name>": "<terminal>" },
 *   models: { "<label name>": "<id>" | { id, agent } | { "<agent>": "<id>" | { id, effort } } },
 *   agentModels: { "<agent>": ["<id>", ...] }: more models the list in Linear's window offers,
 *   efforts: { "<word>": "<effort>" | { "<agent>": "<effort>" } },
 *   agentArgs: { "<agent>": { model: [...args with {model}], effort: [...args with {effort}], prompt: [...args with {prompt}] } },
 *   presets: { "<agent>": { "<name>": [...args] } }: named argument sets the list in Linear's window offers,
 *   promptTemplate: "<text with {prompt}>" | { default: "<text>", "<agent>": "<text>" } }
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
 * (Codex, Claude, Grok, ...), with or without a group. `agents` maps other
 * label names to the agent's command: { "克劳德": "claude" }.
 */
export function agentFromLabels(prompt, group, known = KNOWN_AGENTS, agents = {}) {
  const labels = labelsFromPrompt(prompt);
  const command = (label) => lookup(agents, label.name) ?? slug(label.name);
  const inGroup = group && labels.find((label) => label.group === group);
  if (inGroup) return command(inGroup);
  const named = labels.filter((label) => lookup(agents, label.name) || known.includes(slug(label.name)));
  return named.length === 1 ? command(named[0]) : null;
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
  if (level) effort = effortValue(efforts, level);
  return { ...found, effort, label: show(label), level };
}

/**
 * What `efforts` says for a word: an effort for every agent ("high"), or
 * each agent's own ({ "codex": "xhigh", "claude": "max" }). A word not in
 * `efforts` that is a known effort stands for itself; otherwise undefined.
 */
function effortValue(efforts = {}, word) {
  return lookup(efforts, word) ?? (EFFORTS.includes(word.toLowerCase()) ? word.toLowerCase() : undefined);
}

/** One agent's effort from an effortValue: null when it has none there. */
function effortFor(value, agent) {
  if (value == null) return null;
  return typeof value === "string" ? value : (lookup(value, agent) ?? null);
}

/** The effort a label of group `group` names, mapped through `efforts`: { effort, label, name } or null. */
export function effortFromLabels(prompt, group, efforts = {}) {
  if (!group) return null;
  const label = labelsFromPrompt(prompt).find((l) => l.group === group);
  if (!label) return null;
  return { effort: effortValue(efforts, label.name), label: show(label), name: label.name };
}

/** A tier's model for one agent: { id, effort } or null. */
function tierModel(tier, agent) {
  const value = lookup(tier, agent);
  if (!value) return null;
  return typeof value === "string" ? { id: value, effort: null } : { id: value.id, effort: value.effort ?? null };
}

/** How Codex takes a model and effort; other agents are described in "agentArgs" in the config. */
const BUILT_IN_ARGS = { codex: { model: ["-m", "{model}"], effort: ["-c", "model_reasoning_effort={effort}"] } };

/** An agent's arguments for its model and effort, as "agentArgs" in the config describes them. */
function argsOf(agent, agentArgs = {}) {
  return lookup(agentArgs, agent) ?? BUILT_IN_ARGS[agent] ?? { model: ["--model", "{model}"] };
}

/**
 * How an agent takes the issue's prompt, from "prompt" in its "agentArgs"
 * entry: null when it has none, so the prompt goes last on the command line;
 * otherwise the template with "{prompt}" replaced. An empty template means
 * the agent gets no prompt.
 */
export function promptArgs(agent, prompt, agentArgs = {}) {
  const template = argsOf(agent, agentArgs).prompt;
  if (!Array.isArray(template)) return null;
  return template.map((arg) => arg.replaceAll("{prompt}", prompt));
}

/**
 * The prompt the agent gets: Linear's prompt inside "promptTemplate", with
 * {prompt}, {id} (REE-302), {branch} and {agent} filled in. The template is
 * one text for every agent, or { "default": ..., "<agent>": ... }. No
 * template, or none for this agent, leaves the prompt as it is. The values
 * are filled in one pass, so a "{id}" inside Linear's prompt stays as written.
 */
export function wrapPrompt(prompt, template, values = {}) {
  const text = typeof template === "string" ? template : template && typeof template === "object" ? (lookup(template, values.agent ?? "") ?? template.default) : null;
  if (typeof text !== "string") return prompt;
  const all = { ...values, prompt };
  return text.replace(/\{(prompt|id|branch|agent)\}/g, (whole, key) => all[key] ?? whole);
}

/** One agent's named argument sets from "presets": { "<name>": [...args] }. */
export function presetsOf(config = {}, agent) {
  return lookup(config.presets, agent) ?? {};
}

/**
 * Each agent's own arguments for a model and effort, when it starts in a
 * terminal: "{model}" and "{effort}" in the templates are replaced. An agent
 * with no effort template gets no effort.
 */
export function agentModelArgs(agent, { id, effort }, agentArgs = {}) {
  const spec = argsOf(agent, agentArgs);
  const fill = (template, key, value) => (template ?? []).map((arg) => arg.replaceAll(`{${key}}`, value));
  return [...(id ? fill(spec.model, "model", id) : []), ...(effort ? fill(spec.effort, "effort", effort) : [])];
}

/** Terminal names a label can use, and what --terminal calls them. */
export const TERMINAL_NAMES = { wt: "wt", "windows-terminal": "wt", warp: "warp", wezterm: "wezterm", orca: "orca", here: null, linear: null };

/**
 * Where the agent runs, from a label: the label in group `group`, else the one
 * label named like a terminal (Orca, Warp, WezTerm, Windows Terminal). "Here" or
 * "Linear" keeps the window Linear opened. `terminals` maps other label names
 * to one of those: { "终端窗口": "wt" }. Returns undefined when no label says.
 */
export function terminalFromLabels(prompt, group, terminals = {}) {
  const labels = labelsFromPrompt(prompt);
  const known = (label) => {
    const name = slug(lookup(terminals, label.name) ?? label.name);
    return name in TERMINAL_NAMES ? { found: true, terminal: TERMINAL_NAMES[name] } : { found: false };
  };
  const inGroup = group && labels.find((label) => label.group === group);
  if (inGroup) {
    const result = known(inGroup);
    if (!result.found) {
      const mapped = lookup(terminals, inGroup.name);
      throw new Error(
        mapped
          ? `"terminals" maps ${show(inGroup)} to "${mapped}", which is not a terminal; use orca, warp, wezterm, wt or here`
          : `Label ${show(inGroup)} is not a terminal; use Orca, Warp, WezTerm, Windows Terminal or Here, or map it in "terminals" in the config`,
      );
    }
    return result.terminal;
  }
  const named = labels.filter((label) => known(label).found && known(label).terminal);
  return named.length === 1 ? known(named[0]).terminal : undefined;
}

/** The default terminal, written like a label ("Windows Terminal", "Here") or as --terminal takes it. */
function defaultTerminal(name, terminals = {}) {
  if (!name) return null;
  const key = slug(lookup(terminals, name) ?? name);
  return key in TERMINAL_NAMES ? TERMINAL_NAMES[key] : name;
}

/**
 * The agent, model and terminal for an issue. Arguments in coding-tools.json
 * (`flags`) win over the config file; labels win over both defaults.
 * notes: why a label was not used, for the first lines in Linear's window.
 */
export function choose(issuePrompt, flags = {}, issueConfig = {}) {
  // Choices made in Linear's window win over the issue's labels.
  const { prompt, config, picked } = withPicks(issuePrompt, issueConfig, flags.picks);
  const labels = { ...config.labels, ...(flags.agentLabel && !picked.agent ? { agent: flags.agentLabel } : {}), ...(flags.terminalLabel && !picked.terminal ? { terminal: flags.terminalLabel } : {}) };
  const notes = [];
  const found = modelFromLabels(prompt, labels.model, config);
  const effortLabel = effortFromLabels(prompt, labels.effort, config.efforts);
  if (effortLabel?.effort === undefined && effortLabel) notes.push(`${effortLabel.label}: "${effortLabel.name}" is not an effort; add it to "efforts" in the config (say "${effortLabel.name}": "high")`);
  const fromLabel = agentFromLabels(prompt, labels.agent, KNOWN_AGENTS, config.agents);
  // An issue with only a model label gets the agent that model belongs to.
  const agent = fromLabel ?? found?.agent ?? flags.agent ?? config.agent ?? "codex";
  let model = null;
  let effortSource = null;
  if (found) {
    const fromTier = found.tier && tierModel(found.tier, agent);
    if (found.level && found.effort === undefined) notes.push(`${found.label}: "${found.level}" is not an effort; add it to "efforts" in the config (say "${found.level}": "high")`);
    if (found.agent && found.agent !== agent) notes.push(`${found.label} is a ${found.agent} model; ${agent} starts with its own default`);
    else if (found.tier && !fromTier) notes.push(`${found.label}: the config gives no ${agent} model for it; ${agent} starts with its own default`);
    else if (fromTier) model = { id: fromTier.id, effort: effortFor(found.effort, agent) ?? fromTier.effort };
    else model = { id: found.id, effort: effortFor(found.effort, agent) };
    if (found.effort != null) effortSource = { value: found.effort, label: found.label };
  }
  // A label of the effort group wins over the model label's and the tier's effort.
  if (effortLabel?.effort != null) {
    effortSource = { value: effortLabel.effort, label: effortLabel.label };
    const effort = effortFor(effortLabel.effort, agent);
    if (effort) model = { id: model?.id ?? null, effort };
  }
  if (effortSource && typeof effortSource.value === "object" && !effortFor(effortSource.value, agent))
    notes.push(`${effortSource.label}: "efforts" gives no ${agent} value for it; ${agent} starts with its default effort`);
  const terminalLabel = terminalFromLabels(prompt, labels.terminal, config.terminals);
  const terminal = terminalLabel === undefined ? defaultTerminal(flags.terminal ?? config.terminal ?? null, config.terminals) : terminalLabel;
  if (model?.effort && terminal === "orca" && !model.id) notes.push(`Orca takes an effort only with a model; add a model label`);
  if (model?.effort && terminal !== "orca" && !argsOf(agent, config.agentArgs).effort)
    notes.push(`"agentArgs" in the config says no effort argument for ${agent}; it starts with its default effort`);
  // The agent's own arguments, for when it starts in a terminal rather than in Orca.
  const modelArgs = model ? agentModelArgs(agent, model, config.agentArgs) : [];
  // A preset chosen in Linear's window: a named set of the agent's own arguments.
  const presetName = flags.picks?.preset ?? null;
  let preset = null;
  if (presetName) {
    const found = lookup(presetsOf(config, agent), presetName);
    if (Array.isArray(found)) preset = { name: presetName, args: found };
    else notes.push(`"presets" has no ${agent} entry "${presetName}"; ${agent} starts without it`);
  }
  if (preset && terminal === "orca") notes.push(`Orca takes no agent arguments; options "${preset.name}" are not used`);
  const args = [...(preset?.args ?? []), ...modelArgs];
  const open = flags.open ?? config.open ?? "tab";
  if (open !== "tab" && open !== "window") throw new Error(`"open" is "${open}"; use "tab" or "window"`);
  // Linear's window closes once the agent runs elsewhere, unless the config keeps it.
  const closeLinearWindow = config.closeLinearWindow !== false;
  return { agent, model, args, preset, terminal, orca: flags.orca ?? config.orca ?? "orca", wezterm: flags.wezterm ?? config.wezterm ?? "wezterm", open, closeLinearWindow, notes };
}


/** Label groups for choices made in Linear's window; no real label has them. */
const PICKED = { agent: "nook:agent", model: "nook:model", effort: "nook:effort", terminal: "nook:terminal" };

/**
 * The prompt and config with choices from Linear's window in place of the
 * issue's labels: each one becomes the only label of its own group. A model
 * or effort of null is the agent's default.
 * picks: { agent: "grok", model: "Strong" | null, effort: "High" | null, terminal: "WezTerm" }.
 */
export function withPicks(prompt, config = {}, picks = {}) {
  const labels = { ...config.labels };
  const picked = {};
  let text = prompt;
  for (const [key, value] of Object.entries(picks ?? {})) {
    if (value === undefined || !(key in PICKED)) continue;
    labels[key] = PICKED[key];
    picked[key] = true;
    if (value !== null) text += `\n<label>${PICKED[key]} › ${value}</label>`;
  }
  return { prompt: text, config: { ...config, labels }, picked };
}

/**
 * What Linear's window offers for each choice, from the config and the
 * built-in names. With `agent`, only the models and efforts that agent has:
 * the `models` entries that name a model for it, then its ids from
 * `agentModels`.
 */
export function pickOptions(config = {}, agent = null, terminal = null) {
  const models = Object.entries(config.models ?? {})
    .filter(([, entry]) => !agent || typeof entry === "string" || ("id" in entry ? !entry.agent || entry.agent === agent : Boolean(tierModel(entry, agent))))
    .map(([name]) => name);
  const ids = agent ? (lookup(config.agentModels, agent) ?? []) : [];
  // An agent with no effort arguments in "agentArgs" cannot take one, so its list has only its default.
  // Orca passes the effort itself, with --effort.
  const takesEffort = !agent || terminal === "orca" || Boolean(argsOf(agent, config.agentArgs).effort);
  const efforts = !takesEffort
    ? []
    : config.efforts
    ? Object.entries(config.efforts)
        .filter(([, value]) => !agent || effortFor(value, agent) !== null)
        .map(([name]) => name)
    : EFFORTS;
  return {
    agent: [...new Set([...Object.keys(config.agentArgs ?? {}), ...KNOWN_AGENTS])],
    model: [null, ...new Set([...models, ...ids])],
    effort: [null, ...efforts],
    terminal: ["Here", "Windows Terminal", "Warp", "WezTerm", "Orca"],
    preset: agent ? [null, ...Object.keys(presetsOf(config, agent))] : [null],
  };
}
