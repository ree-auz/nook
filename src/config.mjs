import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { NookError } from "./errors.mjs";

export function emptyConfig() {
  return { agents: {}, repos: {} };
}

export function loadConfig(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyConfig();
    throw error;
  }
  let data;
  try {
    data = parse(text);
  } catch (error) {
    throw new NookError(`Cannot read ${file}: ${error.message}`);
  }
  data.agents ??= {};
  data.repos ??= {};
  for (const repo of Object.values(data.repos)) {
    repo.workspaces ??= {};
    repo.hooks ??= {};
  }
  return data;
}

export function saveConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, stringify(config) + "\n");
  renameSync(temp, file);
}
