import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";
import { resolveRepo } from "../context.mjs";
import { exists } from "../home.mjs";
import { gitTry } from "../git.mjs";
import { HOOK_EVENTS, findHooks } from "../hooks.mjs";
import { NookError } from "../errors.mjs";
import { planFromCi } from "../ci.mjs";
import { GENERATED_MARK, hookFiles } from "../generate-hooks.mjs";
import { listFiles } from "../shared.mjs";
import { agentCommand, launch } from "../agents.mjs";

/** Files that say how a project is installed, run or served. */
const MARKERS = new Set([
  "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "pnpm-workspace.yaml",
  "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt", "Pipfile.lock",
  "Gemfile.lock", "go.mod", "Cargo.toml", "composer.lock", "mix.lock",
  "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", "Dockerfile", "devcontainer.json",
  "Makefile", "justfile", "Taskfile.yml", "Procfile", "mise.toml", ".tool-versions", ".nvmrc", ".python-version",
]);
const DOC = "https://github.com/ree-auz/nook/blob/main/docs/setup-hooks.md";

/** CI configuration: it already lists, step by step, how a clean machine gets the project running. */
const CI_FILE = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml|\.buildkite\/pipeline\.ya?ml|\.woodpecker\.ya?ml|\.woodpecker\/[^/]+\.ya?ml)$/;

function ciFiles(repoPath) {
  const listed = gitTry(["ls-files"], { cwd: repoPath });
  return listed.ok ? listed.out.split(/\r?\n/).filter((file) => CI_FILE.test(file)) : [];
}

/** Tracked marker files up to two folders deep, skipping vendored code. */
function markerFiles(repoPath) {
  const listed = gitTry(["ls-files"], { cwd: repoPath });
  if (!listed.ok) return [];
  return listed.out
    .split(/\r?\n/)
    .filter((file) => file.split("/").length <= 3 && !/(^|\/)(node_modules|vendor)\//.test(file) && MARKERS.has(basename(file)));
}

/** Names of the shared files, and keys in them left empty. Values are never read out. */
function sharedSummary(sharedDir) {
  if (!exists(sharedDir)) return [];
  return listFiles(sharedDir).map((file) => {
    if (!/(^|\/)\.env[^/]*$/.test(file)) return file;
    try {
      const values = parseEnv(readFileSync(join(sharedDir, file), "utf8"));
      const empty = Object.keys(values).filter((key) => values[key] === "");
      return empty.length ? `${file} (empty: ${empty.join(", ")})` : file;
    } catch {
      return file;
    }
  });
}

/** Hook files in `<dir>/.nook`, with whether nk generated them. */
function existingHooks(dir) {
  const folder = join(dir, ".nook");
  if (!exists(folder)) return [];
  return readdirSync(folder)
    .filter((file) => HOOK_EVENTS.some((event) => file.startsWith(`${event}.`)))
    .map((file) => ({ file, generated: readFileSync(join(folder, file), "utf8").startsWith(GENERATED_MARK) }));
}

/**
 * Writes hooks into `<dir>/.nook` from the repository's CI. Never replaces a
 * hook someone wrote by hand. Returns { plan, written } or { reason }.
 */
export function generateHooks(dir) {
  const ci = planFromCi(dir);
  if (!ci.files.length) return { reason: "no GitHub Actions workflow (.github/workflows/*.yml)" };
  if (!ci.best) return { reason: `could not read ${ci.errors.map((e) => e.source).join(", ")}` };
  const handWritten = existingHooks(dir).filter((hook) => !hook.generated);
  if (handWritten.length) return { reason: `.nook already has hooks written by hand: ${handWritten.map((h) => h.file).join(", ")}`, plan: ci.best };
  const files = hookFiles(ci.best);
  const folder = join(dir, ".nook");
  mkdirSync(folder, { recursive: true });
  for (const hook of existingHooks(dir)) if (!files[hook.file]) rmSync(join(folder, hook.file));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
  return { plan: ci.best, written: Object.keys(files), others: ci.others };
}

function report(ctx, result) {
  const { plan } = result;
  ctx.ok(`Wrote ${result.written.map((file) => `.nook/${file}`).join(", ")} from ${plan.source} (job ${plan.job})`);
  if (result.others.length) ctx.info(`Other CI jobs not used: ${result.others.join(", ")}`);
  if (plan.tools.length) ctx.info(`Checks the tools CI installs: ${plan.tools.map((t) => (t.version ? `${t.name} ${t.version}` : t.name)).join(", ")}`);
  if (plan.services.length) ctx.info(`Starts for each workspace, on its own ports: ${plan.services.map((s) => `${s.name} (${s.image})`).join(", ")}`);
  if (Object.keys(plan.env).length) ctx.info(`Adds to .env: ${Object.keys(plan.env).join(", ")}`);
  if (plan.create.length) {
    ctx.info("Setup steps (create):");
    for (const step of plan.create) ctx.item(step.run.split("\n")[0]);
  }
  if (plan.remove.length) {
    ctx.info("Cleanup steps (remove):");
    for (const step of plan.remove) ctx.item(step.run.split("\n")[0]);
  }
  if (plan.skipped.length) ctx.info(`Left out ${plan.skipped.length} CI-only steps (checkout, tests, lint, build, uploads)`);
  if (plan.untranslated.length) {
    ctx.warn("Not added; review these and add what is safe by hand (or nk hooks write <agent>):");
    for (const item of plan.untranslated) ctx.item(`${item.step}: ${item.why}`);
  }
}

/** The prompt for an agent that writes or finishes this repository's hooks, filled with what nk knows. */
export function setupPrompt(ctx, { repoName, repo, dir = repo.path, generated = null }) {
  const markers = markerFiles(dir);
  const ci = ciFiles(dir);
  const shared = sharedSummary(join(ctx.paths.shared, repoName));
  const hooks = findHooks(dir).map((hook) => `.nook/${hook.name}`);
  const list = (items, none) => (items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${none}`);
  const start = generated?.written
    ? `nk already wrote ${generated.written.map((f) => `.nook/${f}`).join(", ")} from ${generated.plan.source} (job ${generated.plan.job}), without AI. What it could not translate:
${list(generated.plan.untranslated.map((i) => `${i.step}: ${i.why}`), "nothing")}

Your task, in this folder:
1. Read the generated hooks and the CI file. Add what was not translated, adapted to a workspace (its own ports from NOOK_PORT, its own container and project names, started again by open, cleaned up by remove). Keep the rest as generated. Once you edit a hook, remove its first line, so nk hooks write will not replace your work.`
    : `Your task, in this folder:
1. Start from the CI configuration: take its setup steps (runtime versions, dependency install, services such as databases, environment variables, migrations or seed data) and leave out what only CI needs (tests, lint, builds, releases, caches, uploads). Then adapt it to a workspace, which differs from a CI machine in three ways: several workspaces run at once, so ports and container or Compose project names must be this workspace's own; a workspace is kept and reopened, so services must start again; and nothing is thrown away afterwards, so remove has to clean up. Without CI, use the files below and the README.
   Write .nook/create.mjs and .nook/remove.mjs as a pair, and .nook/open.mjs if services must start again when the workspace is reopened (it runs every time, so it must be safe to repeat).`;
  return `Set up Nook hooks for the repository ${repoName}. Nook (nk) gives each task its own git worktree (a workspace) and runs scripts from .nook/ in it: create once, open on every open, remove before deletion. Rules and examples: ${DOC}

${start}
2. Never use the main checkout's .env or services, never print secrets, and never run docker compose config.
3. Run nk hooks test here. It runs create, open twice and remove in a temporary workspace and lists whatever remove left behind. Fix the hooks until it passes.
4. Do not commit or push. Tell me what each hook runs and what I must fill in once in the shared files.

What nk knows about this repository:

CI configuration:
${list(ci, "none found")}

Other files that show how it is set up:
${list(markers, "none found; read the README")}

Shared files, copied into every new workspace before create runs (from ~/nook/shared/${repoName}/):
${list(shared, "none")}

Hooks there now:
${list(hooks, "none")}

What nk does itself: it copies the shared files and gives the workspace ten free ports (NOOK_PORT to NOOK_PORT + 9). On removal it stops programs running in the folder and, as a safety net, removes Docker Compose projects started in it.`;
}

/**
 * nk hooks write [agent]. nk translates the repository's CI into hooks in the
 * folder you are in (usually the main checkout). With an agent, it then starts
 * the agent in the same folder to finish what was not translated.
 */
export async function writeHooks(ctx, { repo: repoFlag, agent, extra = [] }) {
  const target = resolveRepo(ctx, repoFlag);
  const top = gitTry(["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
  const dir = top.ok ? top.out : target.repo.path;
  const result = generateHooks(dir);
  if (!agent) {
    if (!result.written)
      throw new NookError(`Cannot write hooks from CI: ${result.reason}\nTo have an agent write them instead: nk hooks write <agent>`);
    report(ctx, result);
    ctx.info(`Next: nk hooks test${result.plan.untranslated.length ? `, or nk hooks write <agent> to have an agent finish them` : ""}`);
    return 0;
  }
  if (result.written) report(ctx, result);
  else ctx.info(`The agent writes the hooks itself (${result.reason})`);
  const prompt = setupPrompt(ctx, { repoName: target.name, repo: target.repo, dir, generated: result });
  ctx.info(`Starting ${agent} in ${dir}`);
  return launch(agentCommand(ctx.config, agent, { prompt, extra }, ctx.env), { cwd: dir, env: ctx.env });
}
