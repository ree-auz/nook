import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { gitTry } from "./git.mjs";
import { composeFile, overrideFile } from "./compose-plan.mjs";
import { splitArgs } from "./prompt.mjs";

/** docker run flags from a CI service's options, keeping quoted values whole (--health-cmd "mysqladmin ping"). */
function dockerOptions(text) {
  try {
    return splitArgs(text.trim());
  } catch {
    return [];
  }
}

/**
 * Reads a repository's GitHub Actions workflows and turns the setup part of
 * one job into a plan for workspace hooks, without AI: CI already says how a
 * clean machine gets the project running. What cannot be translated is
 * listed, never guessed.
 */

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** A step that checks the code rather than sets it up: setup ends here. */
const CHECK_STEP = /\b(test|tests|unittest|pytest|vitest|jest|e2e|lint|eslint|ruff|typecheck|tsc|mypy|format|prettier|check|knip|build|coverage|deploy|publish|release|audit)\b/i;
/** Actions that only matter on a CI machine. */
const CI_ONLY = /^(actions\/(checkout|cache|upload-artifact|download-artifact|github-script|labeler|stale)|codecov\/|docker\/(login|setup-buildx|setup-qemu|build-push|metadata)-action)/;
/** Actions that install a tool: on a developer machine they become a check. */
const TOOL_ACTIONS = [
  { match: /^actions\/setup-node@/, tool: "node", version: (w) => w["node-version"] },
  { match: /^actions\/setup-python@/, tool: "python", version: (w) => w["python-version"] },
  { match: /^actions\/setup-go@/, tool: "go", version: (w) => w["go-version"] },
  { match: /^actions\/setup-java@/, tool: "java", version: (w) => w["java-version"] },
  { match: /^pnpm\/action-setup@/, tool: "pnpm", version: (w) => w.version },
  { match: /^oven-sh\/setup-bun@/, tool: "bun", version: (w) => w["bun-version"] },
  { match: /^astral-sh\/setup-uv@/, tool: "uv", version: (w) => w.version, also: (w) => (w["python-version"] ? [{ name: "python", version: String(w["python-version"]) }] : []) },
  { match: /^denoland\/setup-deno@/, tool: "deno", version: (w) => w["deno-version"] },
  { match: /^dtolnay\/rust-toolchain@|^actions-rs\/toolchain@/, tool: "cargo" },
  { match: /^ruby\/setup-ruby@/, tool: "ruby", version: (w) => w["ruby-version"] },
  { match: /^erlef\/setup-beam@/, tool: "elixir", version: (w) => w["elixir-version"] },
  { match: /^shivammathur\/setup-php@/, tool: "php", version: (w) => w["php-version"] },
];

const EXPRESSION = /\$\{\{/;

/**
 * CI runs in a throwaway machine, so its steps may assume nothing else is
 * there. On a developer machine the real database may be. Only commands that
 * install dependencies into the workspace folder are copied; any other step
 * (a script, docker, a migration) is listed for a person or agent to review.
 */
const INSTALL = /^(yarn( install)?(\s+--?[\w-]+(=\S+)?)*$|npm (ci|install|i)|pnpm (install|i|fetch)|bun (install|ci)|corepack enable|uv sync|uv pip install|pip install|python3? -m pip install|poetry install|pipenv (install|sync)|bundle install|go mod download|cargo fetch|composer install|deno (cache|install)|(npx|pnpm exec|yarn) playwright install)(\s+[\w@./:=,+-]+)*$/;
const SHELL_SYNTAX = /[;|&`$<>()\\]|\n/;

export function isInstallCommand(command) {
  const text = String(command).trim();
  return !SHELL_SYNTAX.test(text) && INSTALL.test(text);
}

/** A database or queue address that is not one of CI's services: on this machine it may be a real one. */
const SERVICE_URL = /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|amqp|nats|kafka):\/\//i;
const LOCAL_PORT = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\b/g;
const label = (step, index) => step.name || step.run?.split("\n")[0] || step.uses || `step ${index + 1}`;

export function workflowFiles(repoPath) {
  const listed = gitTry(["ls-files"], { cwd: repoPath });
  return listed.ok ? listed.out.split(/\r?\n/).filter((file) => WORKFLOW.test(file)) : [];
}

/** A fingerprint of the CI files (workflows and local actions) and the Compose files, so nk can tell when they changed after the hooks were tested. */
export function ciHash(repoPath) {
  const compose = composeFile(repoPath);
  const listed = gitTry(["ls-files", ".github/actions"], { cwd: repoPath });
  const actions = listed.ok ? listed.out.split(/\r?\n/).filter((file) => /\/action\.ya?ml$/.test(file)) : [];
  const files = [...workflowFiles(repoPath), ...actions, ...[compose, overrideFile(repoPath, compose)].filter(Boolean)];
  if (!files.length) return null;
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\n`).update(readFileSync(join(repoPath, file), "utf8").replace(/\r\n/g, "\n"));
  return hash.digest("hex");
}

/** "5433:5432" → { host: 5433, container: 5432 }; "5432" or 5432 → both 5432. */
function servicePort(spec) {
  const parts = String(spec).split(":");
  const container = Number(parts.at(-1).split("/")[0]);
  const host = parts.length > 1 ? Number(parts.at(-2)) : container;
  return Number.isInteger(container) && Number.isInteger(host) ? { host, container } : null;
}

function plainEnv(env, untranslated, where) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (EXPRESSION.test(String(value))) untranslated.push({ step: where, why: `${key} comes from a CI expression (${String(value).trim()})` });
    else out[key] = String(value);
  }
  return out;
}

/** A condition that reads only earlier steps' outputs (cache hits, changed files), not the OS or the event. */
function onlyStepOutputs(condition) {
  const rest = condition
    .replace(/\$\{\{|\}\}/g, " ")
    .replace(/steps\.[\w-]+\.outputs\.[\w-]+/g, " ")
    .replace(/'[^']*'/g, " ")
    .replace(/==|!=|&&|\|\||!|\(|\)|\btrue\b|\bfalse\b/g, " ");
  return /steps\./.test(condition) && !rest.trim();
}

/** The plan for one job: tools, environment, services, setup commands, cleanup commands. */
export function planJob(file, jobName, job, workflowEnv = {}, knownPorts = []) {
  const untranslated = [];
  const skipped = [];
  const tools = [];
  const create = [];
  const remove = [];
  const rawEnv = { ...plainEnv(workflowEnv, untranslated, "workflow env"), ...plainEnv(job.env, untranslated, `job ${jobName} env`) };

  const services = [];
  for (const [name, service] of Object.entries(job.services ?? {})) {
    if (!service?.image || EXPRESSION.test(service.image)) {
      untranslated.push({ step: `service ${name}`, why: "no plain image name" });
      continue;
    }
    services.push({
      name,
      image: service.image,
      env: plainEnv(service.env, untranslated, `service ${name}`),
      ports: (service.ports ?? []).map(servicePort).filter(Boolean),
      options: service.options && !EXPRESSION.test(service.options) ? dockerOptions(String(service.options)) : [],
    });
  }

  if (job.container && services.some((service) => !service.ports.length))
    untranslated.push({ step: "job container", why: "CI runs this job inside a container and reaches its services by name; here they need host ports, which the CI file does not list" });

  // Ports the workspace has its own of: CI's services, and the Compose services nk starts.
  const servicePorts = new Set([...services.flatMap((service) => service.ports.map((port) => port.host)), ...knownPorts.map(Number)]);
  /** Drops values that could reach something outside the workspace's own services. */
  const safeEnv = (values, where) => {
    const kept = {};
    for (const [key, value] of Object.entries(values)) {
      const ports = [...value.matchAll(LOCAL_PORT)].map((match) => Number(match[2]));
      const strayPort = ports.find((port) => !servicePorts.has(port));
      if (strayPort !== undefined)
        untranslated.push({
          step: where,
          // An http address is usually the app itself; anything else could be a real database on this machine.
          why: /^https?:\/\//i.test(value.trim())
            ? `${key} points at local port ${strayPort}, which is not a service nk starts; likely the app's own address, so the shared .env keeps its value`
            : `${key} points at local port ${strayPort}, which is not a service nk starts; on this machine it may be a real database`,
        });
      else if (SERVICE_URL.test(value) && !ports.length)
        untranslated.push({ step: where, why: `${key} is a service address outside the workspace` });
      else kept[key] = value;
    }
    return kept;
  };
  const env = safeEnv(rawEnv, "env");

  let checking = false;
  let checks = 0;
  let tests = 0;
  (job.steps ?? []).forEach((step, index) => {
    const name = label(step, index);
    const condition = step.if === undefined ? "" : String(step.if);
    const cleanup = /\balways\(\)/.test(condition);
    if (step.uses) {
      const tool = TOOL_ACTIONS.find((entry) => entry.match.test(step.uses));
      if (tool) {
        const version = tool.version?.(step.with ?? {});
        tools.push({ name: tool.tool, ...(version !== undefined && !EXPRESSION.test(String(version)) && { version: String(version) }) });
        for (const extra of tool.also?.(step.with ?? {}) ?? []) tools.push(extra);
      } else if (CI_ONLY.test(step.uses)) skipped.push({ step: name, why: "only needed on a CI machine" });
      else untranslated.push({ step: name, why: `uses the action ${step.uses}` });
      return;
    }
    if (!step.run) return;
    if (/\$\{?GITHUB_(OUTPUT|ENV|PATH|STEP_SUMMARY)\b/.test(step.run)) {
      skipped.push({ step: name, why: "only passes values between CI steps" });
      return;
    }
    const target = cleanup ? remove : create;
    // Flags such as --no-audit say nothing about what a step is for.
    if (!cleanup && (checking || CHECK_STEP.test(`${step.name ?? ""} ${step.run}`.replace(/(^|\s)--?[\w-]+(=\S*)?/g, " ")))) {
      checking = true;
      checks++;
      if (TEST_STEP.test(`${step.name ?? ""} ${step.run}`)) tests++;
      skipped.push({ step: name, why: "checks the code (tests, lint, build); not setup" });
      return;
    }
    if (EXPRESSION.test(step.run) || EXPRESSION.test(JSON.stringify(step.env ?? {}))) {
      untranslated.push({ step: name, why: "uses a CI expression (${{ … }})" });
      return;
    }
    // An install that CI skips on a cache hit or when no files changed: a new workspace has neither.
    if (condition && !cleanup && onlyStepOutputs(condition) && isInstallCommand(step.run)) {
      create.push({ name, run: String(step.run).trim(), ...(step["working-directory"] && { cwd: step["working-directory"] }) });
      return;
    }
    if (condition && !cleanup) {
      untranslated.push({ step: name, why: `runs only when ${condition}` });
      return;
    }
    if (!isInstallCommand(step.run)) {
      untranslated.push({ step: name, why: "not a dependency install; CI runs it on a throwaway machine, so check what it touches before adding it" });
      return;
    }
    target.push({ name, run: String(step.run).trim(), ...(step["working-directory"] && { cwd: step["working-directory"] }), ...(step.env && { env: safeEnv(plainEnv(step.env, untranslated, name), name) }) });
  });

  // CI machines have corepack; Node 25 and later no longer include it, so check for it before anything starts.
  if (create.some((step) => /^corepack\b/.test(step.run)) && !tools.some((tool) => tool.name === "corepack")) tools.push({ name: "corepack" });

  return { source: file, job: jobName, tools, env, services, create, remove, skipped, untranslated, checks, tests };
}

/** Jobs that publish, release or maintain rather than set up and test the project. */
const NOT_SETUP = /release|publish|deploy|bump|\bdocs?\b|nightly|cron|mutation|bench|label|stale|codeql|security|dependabot|backport|sync|cleanup|lighthouse|breaking|changelog|translation|i18n|token|artifact|cache|schema|lint|format|\btypes?\b|audit|triage|preview|licen[sc]e|deprecation|docker|smoke|helm|mobile|\bios\b|android|windows|macos|submit|detect|merge|report|size|openapi|shellcheck|hlint|link|depsreview|dependency|guard|semantic|goreleaser|configuration|validat|devcontainer|image|enterprise|\bwin\b|feature-branch/i;
/** A check step that runs the tests, which is what a workspace is set up for. */
const TEST_STEP = /\b(test|tests|unittest|pytest|vitest|jest|e2e|rspec|phpunit|tox|nox)\b/i;

/**
 * Steps of a local composite action (uses: ./.github/actions/setup) put in
 * place of the step that uses it, so its installs are read like any other.
 * Its inputs are filled from the step's with: or the input's default.
 */
function expandLocalActions(repoPath, steps, depth = 0) {
  return steps.flatMap((step) => {
    if (depth > 3 || typeof step?.uses !== "string" || !step.uses.startsWith("./")) return [step];
    const dir = join(repoPath, step.uses);
    let action;
    try {
      const file = ["action.yml", "action.yaml"].map((name) => join(dir, name)).find((path) => existsSync(path));
      action = file && parse(readFileSync(file, "utf8"));
    } catch {
      return [step];
    }
    if (action?.runs?.using !== "composite" || !Array.isArray(action.runs.steps)) return [step];
    const inputs = {};
    for (const [name, input] of Object.entries(action.inputs ?? {})) if (input?.default !== undefined) inputs[name] = String(input.default);
    for (const [name, value] of Object.entries(step.with ?? {})) inputs[name] = String(value);
    const fill = (value) =>
      typeof value === "string"
        ? value.replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (whole, name) => (inputs[name] !== undefined && !EXPRESSION.test(inputs[name]) ? inputs[name] : whole))
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]))
          : value;
    const inner = action.runs.steps.map((child) => {
      const filled = fill(child);
      // A step's condition holds for every step of the action.
      return step.if !== undefined && filled.if === undefined ? { ...filled, if: step.if } : filled;
    });
    return expandLocalActions(repoPath, inner, depth + 1);
  });
}

/** Whether a workflow runs on pull requests or pushes, as the main CI does. */
function onChanges(on) {
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  return events.some((event) => event === "pull_request" || event === "push" || event === "pull_request_target" || event === "merge_group" || event === "workflow_call");
}

/** Workflows that only answer repository events (issues, releases, comments) and never touch the code. */
function onlyRepositoryEvents(on) {
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  return events.length > 0 && events.every((event) => /^(issues|issue_comment|discussion|discussion_comment|release|label|milestone|project|project_card|project_column|fork|watch|create|delete|status|check_run|check_suite|registry_package|page_build|deployment|deployment_status|gollum|public|pull_request_review|pull_request_review_comment)$/.test(event));
}

/**
 * A job that needs others often starts from what they installed, such as a
 * downloaded artifact; when it downloads one, their installs and tools are its own.
 */
function planWithNeeds(repoPath, file, workflow, jobName, job, knownPorts) {
  const plan = planJob(file, jobName, job, workflow.env, knownPorts);
  if (!job.steps.some((step) => /^actions\/download-artifact@/.test(step.uses ?? ""))) return plan;
  const seen = new Set([jobName]);
  const queue = [job.needs ?? []].flat();
  const before = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || !workflow.jobs[name]?.steps) continue;
    seen.add(name);
    const needed = workflow.jobs[name];
    before.unshift(planJob(file, name, { ...needed, steps: expandLocalActions(repoPath, needed.steps) }, workflow.env, knownPorts));
    queue.push(...[needed.needs ?? []].flat());
  }
  for (const other of before.reverse()) {
    const runs = new Set(plan.create.map((step) => step.run));
    plan.create.unshift(...other.create.filter((step) => !runs.has(step.run)));
    const tools = new Set(plan.tools.map((tool) => tool.name));
    plan.tools.push(...other.tools.filter((tool) => !tools.has(tool.name)));
  }
  return plan;
}

/**
 * The job most like "set up and test the project": it runs on pull requests,
 * runs tests, and has the most setup steps and services. knownPorts are the
 * host ports of Compose services nk starts, for when the job has none of its own.
 */
export function planFromCi(repoPath, knownPorts = []) {
  const files = workflowFiles(repoPath);
  const plans = [];
  const sources = new Map();
  for (const file of files) {
    let workflow;
    try {
      workflow = parse(readFileSync(join(repoPath, file), "utf8"));
    } catch (error) {
      plans.push({ source: file, error: error.message });
      continue;
    }
    for (let [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      if (!job?.steps) continue;
      job = { ...job, steps: expandLocalActions(repoPath, job.steps) };
      const plan = planWithNeeds(repoPath, file, workflow, jobName, job);
      sources.set(plan, { file, jobName, job, workflow, onChanges: onChanges(workflow.on) });
      plans.push(plan);
    }
  }
  const score = (plan) => {
    const { onChanges: main } = sources.get(plan);
    return plan.create.length + plan.tools.length + 3 * plan.services.length + (plan.checks ? 4 : 0) + (plan.tests ? 3 : 0) + (main ? 3 : -5) - (NOT_SETUP.test(`${plan.source} ${plan.job}`) ? 10 : 0);
  };
  const ranked = plans.filter((plan) => !plan.error).sort((a, b) => score(b) - score(a));
  // A job that scores below zero, or neither runs on code changes nor tests the code, only maintains the repository (issues, releases, licences).
  const useful = (plan) => score(plan) >= 0 && (sources.get(plan).onChanges || (plan.tests > 0 && !onlyRepositoryEvents(sources.get(plan).workflow.on)));
  let best = ranked[0] && useful(ranked[0]) ? ranked[0] : null;
  // Without services of its own, the job's addresses may point at the Compose services nk starts.
  if (best && !best.services.length && knownPorts.length) {
    const { file, jobName, job, workflow } = sources.get(best);
    best = planWithNeeds(repoPath, file, workflow, jobName, job, knownPorts);
  }
  return { files, best, others: ranked.slice(1).map((plan) => `${plan.source} › ${plan.job}`), errors: plans.filter((plan) => plan.error) };
}
