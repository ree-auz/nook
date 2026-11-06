import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";
import { resolveRepo } from "../context.mjs";
import { exists } from "../home.mjs";
import { gitTry } from "../git.mjs";
import { findHooks } from "../hooks.mjs";
import { listFiles } from "../shared.mjs";
import { createWorkspace } from "./workspace.mjs";

/** Files that say how a project is installed, run or served. */
const MARKERS = new Set([
  "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "pnpm-workspace.yaml",
  "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt", "Pipfile.lock",
  "Gemfile.lock", "go.mod", "Cargo.toml", "composer.lock", "mix.lock",
  "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", "Dockerfile", "devcontainer.json",
  "Makefile", "justfile", "Taskfile.yml", "Procfile", "mise.toml", ".tool-versions", ".nvmrc", ".python-version",
]);
const SETUP_NAME = "nook-hooks";
const DOC = "https://github.com/ree-auz/nook/blob/main/docs/setup-hooks.md";

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

/** The prompt for an agent that writes this repository's hooks, filled with what nk knows. */
export function setupPrompt(ctx, { repoName, repo }) {
  const markers = markerFiles(repo.path);
  const shared = sharedSummary(join(ctx.paths.shared, repoName));
  const hooks = findHooks(repo.path).map((hook) => `.nook/${hook.name}`);
  const list = (items, none) => (items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${none}`);
  return `Set up Nook hooks for the repository ${repoName}. Nook (nk) gives each task its own git worktree (a workspace) and runs scripts from .nook/ in it. Rules and examples: ${DOC}

What nk already knows about this repository:

Files that show how it is set up:
${list(markers, "none found; read the README")}

Shared files, copied into every new workspace before the create hook runs (from ~/nook/shared/${repoName}/):
${list(shared, "none")}

Hooks already there:
${list(hooks, "none")}

What nk does itself: it copies the shared files and gives the workspace ten free ports (NOOK_PORT to NOOK_PORT + 9). On removal it stops programs running in the folder and, as a safety net, removes Docker Compose projects started in it.

Your task, in this workspace:
1. Read the files above and the README to see how a developer installs dependencies and starts local services.
2. Write .nook/create.mjs and .nook/remove.mjs as a pair: create installs dependencies, gives services this workspace's ports and its own Compose project, and starts what the project needs; remove deletes everything create started or created outside the folder (containers, volumes, networks, built images, databases in shared servers). Add .nook/open.mjs if services must start again when the workspace is reopened; it runs every time, so it must be safe to repeat.
3. Never use the main checkout's .env or services, never print secrets, and never run docker compose config.
4. Run nk hooks test in this workspace. It runs create, open twice and remove in a temporary workspace and lists whatever remove left behind. Fix the hooks until it passes.
5. Commit the hooks on this branch and tell me what each one runs and what I must fill in once in the shared files. Do not push.`;
}

/** nk hooks write [agent]: an agent writes the hooks in a workspace of its own, for review like any change. Without an agent, prints the prompt. */
export async function writeHooks(ctx, { repo: repoFlag, agent, extra = [], prompter }) {
  const target = resolveRepo(ctx, repoFlag);
  const prompt = setupPrompt(ctx, { repoName: target.name, repo: target.repo });
  if (!agent) {
    ctx.print(prompt);
    ctx.info("To start an agent with it in a new workspace: nk hooks write <agent>");
    return 0;
  }
  return createWorkspace(ctx, { name: SETUP_NAME, repo: repoFlag ?? target.name, agent, prompt, extra, prompter });
}
