import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { exists } from "./home.mjs";
import { isBackingService } from "./rules.mjs";

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

/** The override file Compose merges in by default: compose.override.yaml next to compose.yaml, and so on. */
export function overrideFile(repoPath, file = composeFile(repoPath)) {
  if (!file) return null;
  const stem = file.replace(/\.ya?ml$/, "");
  const override = [`${stem}.override.yaml`, `${stem}.override.yml`].find((name) => exists(join(repoPath, name)));
  if (override) return override;
  // A base file that cannot run alone (a service with neither image nor build, as coolify's) is meant to be
  // combined with its development file: docker compose -f docker-compose.yml -f docker-compose.dev.yml.
  let services = {};
  try {
    services = parse(readFileSync(join(repoPath, file), "utf8"))?.services ?? {};
  } catch {}
  if (!Object.values(services).some((service) => service && typeof service === "object" && !service.image && !service.build && !service.extends)) return null;
  return [".dev.yaml", ".dev.yml", ".development.yaml", ".development.yml"].map((end) => stem + end).find((name) => exists(join(repoPath, name))) ?? null;
}

/**
 * Networks and volumes the files give a fixed name (networks: { coolify: { name: coolify } }): every
 * workspace and the main checkout would share them, data too. external ones are shared on purpose.
 */
function fixedNames(repoPath, files) {
  const found = { networks: [], volumes: [] };
  for (const file of files)
    for (const kind of ["networks", "volumes"])
      for (const [key, value] of Object.entries(parse(readFileSync(join(repoPath, file), "utf8"))?.[kind] ?? {}))
        if (value?.name && !value.external && !found[kind].includes(key)) found[kind].push(key);
  return found;
}

/** Both files, as `docker compose` reads them with no -f: ports add up, other keys are replaced. */
function readServices(repoPath, file, override) {
  const services = { ...(parse(readFileSync(join(repoPath, file), "utf8"))?.services ?? {}) };
  if (override)
    for (const [name, extra] of Object.entries(parse(readFileSync(join(repoPath, override), "utf8"))?.services ?? {})) {
      const base = services[name] ?? {};
      services[name] = { ...base, ...extra, ports: [...(base.ports ?? []), ...(extra?.ports ?? [])] };
    }
  return services;
}

/** "${PORT:-3001}" → { name: "PORT", fallback: "3001" }; a literal port → null. */
function portVariable(text) {
  const match = /^\$\{(\w+)(?::?-([^}]*))?\}$/.exec(text.trim());
  return match ? { name: match[1], fallback: match[2] ?? "" } : null;
}

/**
 * A ports entry as { host, target }: "127.0.0.1:${P:-80}:80" → { host: "${P:-80}", target: "80" },
 * "5432:5432/tcp" → { host: "5432", target: "5432/tcp" }. host is null when Compose picks one.
 */
function portEntry(entry) {
  if (typeof entry === "object" && entry) {
    const target = `${entry.target}${entry.protocol && entry.protocol !== "tcp" ? `/${entry.protocol}` : ""}`;
    return { host: entry.published === undefined ? null : String(entry.published), target };
  }
  // Split on ":" outside ${...}.
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of String(entry)) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return { host: parts.length >= 2 ? parts.at(-2) : null, target: parts.at(-1) };
}

/** Variables a service needs set: ${NAME:?message} or ${NAME?message}. */
function requiredVariables(service) {
  return [...JSON.stringify(service).matchAll(/\$\{(\w+):?\?/g)].map((match) => match[1]);
}

/**
 * { file, files, start, ports, remap, required, notStarted, untranslated } for the
 * repository's Compose file and its override file, or null without one.
 */
const PORTS = 10;

/**
 * The repository paths a service mounts (./vendor/x.sh:/docker-entrypoint-initdb.d/x.sh). When one is
 * missing, docker creates it as a root-owned folder, so the create hook waits for it instead.
 */
function bindMounts(service) {
  const paths = [];
  for (const volume of service.volumes ?? []) {
    const source = typeof volume === "string" ? volume.split(":")[0] : volume?.type === "bind" ? volume.source : null;
    if (typeof source === "string" && /^\.\.?\//.test(source) && !source.includes("$")) paths.push(source);
  }
  return paths;
}

/** startAny false: start nothing (CI has its own services). reserved: ports CI's services take first. */
export function planCompose(repoPath, { start: startAny = true, reserved = 0 } = {}) {
  const file = composeFile(repoPath);
  if (!file) return null;
  const untranslated = [];
  const override = overrideFile(repoPath, file);
  const where = override ? `${file} + ${override}` : file;
  let services;
  try {
    services = readServices(repoPath, file, override);
  } catch (error) {
    untranslated.push({ step: where, why: `could not be read (${error.message.split("\n")[0]})` });
    return { file: where, files: [file, override].filter(Boolean), start: [], ports: {}, remap: {}, required: [], notStarted: [], untranslated };
  }
  const ports = {};
  const remap = {};
  const start = [];
  const notStarted = [];
  const required = new Set();
  const mounts = {};
  const named = [];
  const ownNetwork = [];
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== "object") continue;
    // A fixed container_name (plane-redis) would clash between workspaces, even for a service you start yourself: each gets its own.
    if (service.container_name) named.push(name);
    const fixed = [];
    // On the host's network a service listens on the host's own ports, the main checkout's too (forem's
    // postgres and redis): a workspace runs it on its project network instead, its ports moved to its own.
    const hostNetwork = service.network_mode === "host";
    for (const entry of service.ports ?? []) {
      const { host, target } = portEntry(entry);
      if (hostNetwork && (host === null || host === "")) fixed.push({ host: target.split("/")[0], target });
      if (host === null || host === "") continue;
      const variable = portVariable(host);
      if (variable) ports[variable.name] ??= variable.fallback;
      else fixed.push({ host, target });
    }
    if (service.build) notStarted.push({ name, why: "built from this repository" });
    else if (service.profiles?.length) notStarted.push({ name, why: `only with the profile ${service.profiles.join(", ")}` });
    else if (!service.image) notStarted.push({ name, why: "no image" });
    else if (!isBackingService(service.image)) notStarted.push({ name, why: `${service.image} is not a database or similar service` });
    else if (!startAny) notStarted.push({ name, why: "CI starts its own services" });
    else if (hostNetwork && !fixed.length) notStarted.push({ name, why: "uses the host's network and names no ports, so it would share the main checkout's" });
    else {
      start.push(name);
      for (const variable of requiredVariables(service)) required.add(variable);
      const files = bindMounts(service);
      if (files.length) mounts[name] = files;
      // A fixed host port (5432:5432) would be the same for every workspace, and the main checkout may hold
      // it: each workspace moves it to one of its own ports.
      if (fixed.length) remap[name] = fixed;
      if (hostNetwork) ownNetwork.push(name);
    }
  }
  // A workspace has ten ports: services that do not fit are left out, last first.
  const used = (extra = 0) => Object.keys(ports).length + Object.values(remap).flat().length + extra;
  while (start.length && used() > PORTS - reserved) {
    const name = start.pop();
    delete remap[name];
    if (ownNetwork.includes(name)) ownNetwork.splice(ownNetwork.indexOf(name), 1);
    notStarted.push({ name, why: "no port left of the workspace's ten" });
    untranslated.push({ step: `${where} › ${name}`, why: "not started: the workspace's ten ports are taken by the other services" });
  }
  return { file: where, files: [file, override].filter(Boolean), start, ports, remap, required: [...required], mounts, named, ownNetwork, fixed: fixedNames(repoPath, [file, override].filter(Boolean)), notStarted, untranslated };
}

/**
 * Where the Compose services a workspace starts are reached from this machine:
 * { "postgres:5432": "127.0.0.1:5432" }. A template written for apps running
 * inside Docker (DATABASE_URL=...@postgres:5432) is rewritten with it, since
 * here the app runs on the machine; each workspace then moves the port to its own.
 * start false: CI's own services are started instead, so there is nothing to point at.
 */
export function hostAddresses(repoPath, { start = true } = {}) {
  const plan = planCompose(repoPath, { start });
  if (!plan?.start.length) return {};
  const services = readServices(repoPath, plan.files[0], plan.files[1]);
  const addresses = {};
  for (const name of plan.start)
    for (const entry of services[name]?.ports ?? []) {
      const { host, target } = portEntry(entry);
      if (!host) continue;
      const variable = portVariable(host);
      const port = variable ? variable.fallback : host;
      if (/^\d+$/.test(port)) addresses[`${name}:${target.split("/")[0]}`] = `127.0.0.1:${port}`;
    }
  return addresses;
}

/** Rewrites service addresses in an env file's values; returns { text, keys } with the keys it changed. */
export function pointAtHost(text, addresses) {
  const keys = [];
  const lines = text.split(/(\r?\n)/).map((line) => {
    const match = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)(.*)$/.exec(line);
    if (!match) return line;
    let value = match[3];
    for (const [from, to] of Object.entries(addresses)) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(new RegExp(`(^|[\\s"'=/@,])${escaped}(?!\\d)`, "g"), `$1${to}`);
    }
    if (value === match[3]) return line;
    keys.push(match[2]);
    return match[1] + value;
  });
  return { text: lines.join(""), keys };
}
