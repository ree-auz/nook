import { NookError } from "./errors.mjs";

export const SUBCOMMANDS = ["init", "ls", "rm", "clean", "doctor", "help", "version"];

/**
 * Workspace name = branch name = folder name.
 * Lowercase letters, digits, "-" and "."; no "/"; not a subcommand.
 * Returns an error message, or null when the name is valid.
 */
export function nameProblem(name) {
  if (typeof name !== "string" || name === "") return "name is empty";
  if (name.length > 100) return "name is longer than 100 characters";
  if (name.includes("/")) return `"${name}" contains "/"; use "-" instead`;
  if (!/^[a-z0-9.-]+$/.test(name))
    return `"${name}" may only use lowercase letters, digits, "-" and "."`;
  if (!/^[a-z0-9]/.test(name)) return `"${name}" must start with a letter or digit`;
  if (name.endsWith(".") || name.endsWith(".lock"))
    return `"${name}" cannot end with "." or ".lock"`;
  if (name.includes("..")) return `"${name}" cannot contain ".."`;
  if (SUBCOMMANDS.includes(name)) return `"${name}" is a nk command; pick another name`;
  return null;
}

export function assertName(name, what = "workspace") {
  const problem = nameProblem(name);
  if (problem) throw new NookError(`Invalid ${what} name: ${problem}`);
  return name;
}

/**
 * Turns any branch-like text into a valid name, so callers (trackers, scripts,
 * people) can pass what they have: lowercase it, turn "/", spaces, non-ASCII
 * and other characters into "-", and tidy the ends.
 * "REE-267-Nook-第-1-步：建-nook" -> "ree-267-nook-1-nook"; "feat/Login" -> "feat-login".
 */
export function normalizeName(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/(\.lock)+$/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 100)
    .replace(/[.-]+$/, "");
}

/** Normalizes, then checks what normalizing cannot fix (empty, command names). */
export function toName(input) {
  const name = normalizeName(input);
  const problem = nameProblem(name);
  if (problem) throw new NookError(`Cannot use "${input}" as a workspace name: ${problem}`);
  return name;
}

/** Turns a folder name into a repository short name suggestion. */
export function suggestRepoName(folder) {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[.-]+$/, "");
  return nameProblem(name) ? "repo" : name;
}
