#!/usr/bin/env node
/**
 * Picks repositories nk has not been tried on yet, for the weekly full run:
 * popular, pushed to recently, not archived, and starting a database or
 * similar from a root Compose file or from CI services. Each week's pick is
 * different. Prints JSON: [{ name, repo, commit, new: true }].
 *
 *   GITHUB_TOKEN=... node scripts/real-explore.mjs [count]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const count = Number(process.argv[2] ?? 10);
const known = new Set(JSON.parse(readFileSync(join(root, "tests", "corpus", "repos.json"), "utf8")).map((r) => r.repo.toLowerCase()));
const LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Ruby", "PHP", "Java", "Rust", "Elixir", "C#", "Kotlin"];
const COMPOSE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/;

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "nook-real-repos", ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) },
  });
  if (!response.ok) return null;
  return response.json();
}

/**
 * The repository's newest commit and whether it starts services, read with git
 * (a shallow fetch without file contents) so only the search uses the API.
 */
function look(repo) {
  const dir = mkdtempSync(join(tmpdir(), "nook-explore-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120000 });
  try {
    git("init", "-q");
    if (git("fetch", "-q", "--depth", "1", "--filter=blob:none", `https://github.com/${repo}.git`, "HEAD").status !== 0) return null;
    const sha = git("rev-parse", "FETCH_HEAD").stdout.trim();
    const top = git("ls-tree", "--name-only", sha).stdout.split("\n");
    if (top.some((file) => COMPOSE.test(file))) return { sha, services: true };
    const workflows = git("ls-tree", "--name-only", `${sha}:.github/workflows`).stdout.split("\n").filter((file) => /\.ya?ml$/.test(file)).slice(0, 8);
    const services = workflows.some((file) => /^\s+services:\s*$/m.test(git("show", `${sha}:.github/workflows/${file}`).stdout));
    return { sha, services };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shuffle = (items) => items.map((item) => [Math.random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);
const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
const picked = [];

for (const language of shuffle(LANGUAGES)) {
  if (picked.length >= count) break;
  const page = 1 + Math.floor(Math.random() * 10);
  const found = await api(`/search/repositories?q=${encodeURIComponent(`language:"${language}" stars:>2000 pushed:>${since} archived:false fork:false`)}&sort=stars&per_page=30&page=${page}`);
  // Up to two per language, so one week is not all one ecosystem.
  let fromLanguage = 0;
  for (const candidate of shuffle(found?.items ?? [])) {
    if (picked.length >= count || fromLanguage >= 2) break;
    if (known.has(candidate.full_name.toLowerCase())) continue;
    const head = look(candidate.full_name);
    if (!head) continue;
    const { sha, services } = head;
    if (!services) continue;
    const name = candidate.full_name.split("/")[1].toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    picked.push({ name: picked.some((p) => p.name === name) ? `${name}-${candidate.owner.login.toLowerCase()}` : name, repo: candidate.full_name, commit: sha, new: true });
    fromLanguage++;
  }
}
console.log(JSON.stringify(picked));
