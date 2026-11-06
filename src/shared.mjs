import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gitTry, ignoredPaths } from "./git.mjs";
import { exists } from "./home.mjs";

export const DEFAULT_INCLUDE = [".env*"];
/** Suffixes that mark a committed template: `.env.example` is the template for `.env`. */
export const TEMPLATE_SUFFIX = /^(.+)\.(example|sample|template|dist)$/;
/** Ignored secret files other tools use; init offers them one by one. */
export const KNOWN_SECRET_FILES = [".dev.vars", "config/master.key", ".envrc"];

/** Patterns from .worktreeinclude (gitignore syntax), or the default `.env*`. */
export function includePatterns(repo) {
  const file = join(repo, ".worktreeinclude");
  if (!exists(file)) return { patterns: DEFAULT_INCLUDE, source: "default" };
  const patterns = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return { patterns, source: ".worktreeinclude" };
}

/** Files in `repo` that match the patterns and that git ignores. Paths use "/". */
export function sharedCandidates(repo, patterns) {
  if (!patterns.length) return [];
  const args = ["ls-files", "-z", "--others", "--ignored"];
  for (const pattern of patterns) args.push(`--exclude=${pattern}`);
  const listed = gitTry(args, { cwd: repo });
  if (!listed.ok) return [];
  const files = listed.out.split("\0").filter(Boolean);
  const ignored = ignoredPaths(repo, files);
  return files.filter((file) => ignored.has(file)).sort();
}

/**
 * Committed templates for files git ignores, as { from, to }, in any folder:
 * `.env.example` -> `.env`, `apps/api/.dev.vars.sample` -> `apps/api/.dev.vars`.
 * A template whose target git does not ignore is a normal file and is left out.
 */
export function templateFiles(repo) {
  const listed = gitTry(["ls-files", "-z"], { cwd: repo });
  if (!listed.ok) return [];
  const pairs = [];
  for (const from of listed.out.split("\0").filter(Boolean)) {
    const match = TEMPLATE_SUFFIX.exec(from);
    if (match && !match[1].endsWith("/")) pairs.push({ from, to: match[1] });
  }
  const ignored = ignoredPaths(repo, pairs.map((pair) => pair.to));
  return pairs.filter((pair) => ignored.has(pair.to)).sort((a, b) => a.to.localeCompare(b.to));
}

export function knownSecretFiles(repo, already) {
  const present = KNOWN_SECRET_FILES.filter((file) => exists(join(repo, file)) && !already.includes(file));
  const ignored = ignoredPaths(repo, present);
  return present.filter((file) => ignored.has(file));
}

/** Every file below `dir`, relative, with "/" separators. */
export function listFiles(dir) {
  if (!exists(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() || statSync(full).isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

export function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/**
 * Copies the shared folder into a new workspace. Only files git ignores in the
 * workspace are copied, so a shared file never overwrites a tracked one.
 */
export function copyShared(sharedDir, workspace) {
  const files = listFiles(sharedDir);
  const ignored = ignoredPaths(workspace, files);
  const copied = [];
  const skipped = [];
  for (const file of files) {
    if (!ignored.has(file)) {
      skipped.push(file);
      continue;
    }
    copyFile(join(sharedDir, file), join(workspace, file));
    copied.push(file);
  }
  return { copied, skipped };
}
