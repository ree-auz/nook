import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { gitTry } from "./git.mjs";
import { composeFile } from "./compose-plan.mjs";

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
];

const EXPRESSION = /\$\{\{/;

/**
 * CI runs in a throwaway machine, so its steps may assume nothing else is
 * there. On a developer machine the real database may be. Only commands that
 * install dependencies into the workspace folder are copied; any other step
 * (a script, docker, a migration) is listed for a person or agent to review.
 */
const INSTALL = /^(npm (ci|install|i)|pnpm (install|i|fetch)|yarn( install)?|bun install|corepack enable|uv sync|uv pip install|pip install|python3? -m pip install|poetry install|pipenv (install|sync)|bundle install|go mod download|cargo fetch|composer install|deno (cache|install)|(npx|pnpm exec|yarn) playwright install)(\s+[\w@./:=,+-]+)*$/;
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

/** A fingerprint of the CI files and the Compose file, so nk can tell when they changed after the hooks were tested. */
export function ciHash(repoPath) {
  const compose = composeFile(repoPath);
  const files = [...workflowFiles(repoPath), ...(compose ? [compose] : [])];
  if (!files.length) return null;
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\n`).update(readFileSync(join(repoPath, file), "utf8").replace(/\r\n/g, "\n"));
  return hash.digest("hex");
}

/** "5432:5432", "5432", 5432 → the port inside the container. */
function containerPort(spec) {
  const parts = String(spec).split(":");
  return Number(parts.at(-1).split("/")[0]);
}

function plainEnv(env, untranslated, where) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (EXPRESSION.test(String(value))) untranslated.push({ step: where, why: `${key} comes from a CI expression (${String(value).trim()})` });
    else out[key] = String(value);
  }
  return out;
}

/** The plan for one job: tools, environment, services, setup commands, cleanup commands. */
export function planJob(file, jobName, job, workflowEnv = {}) {
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
      ports: (service.ports ?? []).map(containerPort).filter(Number.isInteger),
      options: service.options && !EXPRESSION.test(service.options) ? String(service.options).trim().replace(/\s+/g, " ") : "",
    });
  }

  const servicePorts = new Set(services.flatMap((service) => service.ports));
  /** Drops values that could reach something outside the workspace's own services. */
  const safeEnv = (values, where) => {
    const kept = {};
    for (const [key, value] of Object.entries(values)) {
      const ports = [...value.matchAll(LOCAL_PORT)].map((match) => Number(match[2]));
      const strayPort = ports.find((port) => !servicePorts.has(port));
      if (strayPort !== undefined)
        untranslated.push({ step: where, why: `${key} points at local port ${strayPort}, which is not a CI service; on this machine it may be a real database` });
      else if (SERVICE_URL.test(value) && !ports.length)
        untranslated.push({ step: where, why: `${key} is a service address outside the workspace` });
      else kept[key] = value;
    }
    return kept;
  };
  const env = safeEnv(rawEnv, "env");

  let checking = false;
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
      skipped.push({ step: name, why: "checks the code (tests, lint, build); not setup" });
      return;
    }
    if (EXPRESSION.test(step.run) || EXPRESSION.test(JSON.stringify(step.env ?? {}))) {
      untranslated.push({ step: name, why: "uses a CI expression (${{ … }})" });
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

  return { source: file, job: jobName, tools, env, services, create, remove, skipped, untranslated };
}

/** The job most like "set up and test the project": the most setup steps and services. */
export function planFromCi(repoPath) {
  const files = workflowFiles(repoPath);
  const plans = [];
  for (const file of files) {
    let workflow;
    try {
      workflow = parse(readFileSync(join(repoPath, file), "utf8"));
    } catch (error) {
      plans.push({ source: file, error: error.message });
      continue;
    }
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      if (!job?.steps) continue;
      plans.push(planJob(file, jobName, job, workflow.env));
    }
  }
  const score = (plan) => (plan.error ? -1 : plan.create.length + plan.tools.length + 3 * plan.services.length);
  const ranked = plans.filter((plan) => !plan.error).sort((a, b) => score(b) - score(a));
  return { files, best: ranked[0] ?? null, others: ranked.slice(1).map((plan) => `${plan.source} › ${plan.job}`), errors: plans.filter((plan) => plan.error) };
}
