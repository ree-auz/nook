import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { exists } from "./home.mjs";

/**
 * Reads the repository's Docker Compose file for what a workspace needs from
 * it: the services it uses as they are (a database, a queue), and the
 * variables that choose host ports. Services the repository builds itself are
 * the app; a workspace starts those when the developer wants.
 */

/** The files Compose itself looks for, in its order. */
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export function composeFile(repoPath) {
  return COMPOSE_FILES.find((file) => exists(join(repoPath, file))) ?? null;
}

/** "${PORT:-3001}" → { name: "PORT", fallback: "3001" }; a literal port → null. */
function portVariable(text) {
  const match = /^\$\{(\w+)(?::?-([^}]*))?\}$/.exec(text.trim());
  return match ? { name: match[1], fallback: match[2] ?? "" } : null;
}

/** The host side of a ports entry: "127.0.0.1:${P:-80}:80" → "${P:-80}", "5432" → null (Compose picks one). */
function hostPort(entry) {
  if (typeof entry === "object" && entry) return entry.published === undefined ? null : String(entry.published);
  const text = String(entry);
  // Split on ":" outside ${...}.
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.length >= 2 ? parts.at(-2) : null;
}

/** Variables a service needs set: ${NAME:?message} or ${NAME?message}. */
function requiredVariables(service) {
  return [...JSON.stringify(service).matchAll(/\$\{(\w+):?\?/g)].map((match) => match[1]);
}

/**
 * { file, start, ports, required, notStarted, untranslated } for the
 * repository's Compose file, or null without one.
 */
export function planCompose(repoPath) {
  const file = composeFile(repoPath);
  if (!file) return null;
  const untranslated = [];
  let doc;
  try {
    doc = parse(readFileSync(join(repoPath, file), "utf8"));
  } catch (error) {
    untranslated.push({ step: file, why: `could not be read (${error.message.split("\n")[0]})` });
    return { file, start: [], ports: {}, required: [], notStarted: [], untranslated };
  }
  const ports = {};
  const start = [];
  const notStarted = [];
  const required = new Set();
  for (const [name, service] of Object.entries(doc?.services ?? {})) {
    if (!service || typeof service !== "object") continue;
    const fixed = [];
    for (const entry of service.ports ?? []) {
      const host = hostPort(entry);
      if (host === null || host === "") continue;
      const variable = portVariable(host);
      if (variable) ports[variable.name] ??= variable.fallback;
      else fixed.push(host);
    }
    if (service.build) notStarted.push({ name, why: "built from this repository" });
    else if (service.profiles?.length) notStarted.push({ name, why: `only with the profile ${service.profiles.join(", ")}` });
    else if (!service.image) notStarted.push({ name, why: "no image" });
    else if (fixed.length) {
      // Every workspace would ask for the same host port, and the main checkout may hold it.
      notStarted.push({ name, why: `publishes the fixed host port ${fixed.join(", ")}` });
      untranslated.push({ step: `${file} › ${name}`, why: `publishes the fixed host port ${fixed.join(", ")}; workspaces would collide. Write it as \${${name.toUpperCase().replace(/\W/g, "_")}_PORT:-${fixed[0]}} so nk can give each workspace its own` });
    } else {
      start.push(name);
      for (const variable of requiredVariables(service)) required.add(variable);
    }
  }
  return { file, start, ports, required: [...required], notStarted, untranslated };
}
