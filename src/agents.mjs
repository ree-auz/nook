import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { NookError } from "./errors.mjs";
import spawn from "cross-spawn";

/** Command-line coding agents init looks for. Any other command works too. */
export const KNOWN_AGENTS = ["claude", "codex", "gemini", "grok", "opencode", "pi", "aider", "amp", "cursor-agent", "qwen", "copilot", "droid", "kimi"];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Finds a command on PATH, like `which` / `where`. */
export function which(command, env = process.env, platform = process.platform) {
  const extensions =
    platform === "win32" ? ["", ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())] : [""];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    for (const ext of extensions) if (isFile(command + ext)) return command + ext;
    return null;
  }
  const dirs = (env.PATH || env.Path || "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  for (const dir of dirs)
    for (const ext of extensions) {
      if (platform === "win32" && ext === "" && !extname(command)) continue;
      const full = join(dir, command + ext);
      if (isFile(full)) return full;
    }
  return null;
}

export function commandVersion(path) {
  const result = spawn.sync(path, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (result.status !== 0 || !result.stdout) return "";
  return result.stdout.trim().split(/\r?\n/)[0].slice(0, 80);
}

export function detectAgents(env = process.env, names = KNOWN_AGENTS) {
  const found = [];
  for (const name of names) {
    const path = which(name, env);
    if (path) found.push({ name, path, version: commandVersion(path) });
  }
  return found;
}

/** Command for `nk <name> <agent> [-p prompt] [-- extra]`. */
export function agentCommand(config, agent, { prompt, extra = [] } = {}, env = process.env) {
  const entry = config.agents?.[agent];
  const command = entry?.path && isFile(entry.path) ? entry.path : which(agent, env) ?? agent;
  const args = [...(entry?.args ?? []), ...extra];
  if (prompt) args.push(prompt);
  return { command, args };
}

/**
 * The program behind an npm .cmd shim on Windows, read the way npm's own
 * read-cmd-shim does: the quoted path after %dp0% (or %~dp0) followed by %*.
 */
export function cmdShimTarget(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match = /"%(?:~dp0|dp0%)\\?([^"]+?)"\s+%\*/.exec(text);
  return match ? join(dirname(shimPath), ...match[1].split(/[\\/]/)) : null;
}

/**
 * cmd.exe ends a command at the first line break, so a .cmd agent would get
 * only the first line of a multi-line prompt. Run the program behind an npm
 * shim directly instead.
 */
export function windowsDirect({ command, args }, platform = process.platform) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command) || !args.some((arg) => /[\r\n]/.test(arg))) return { command, args };
  const target = cmdShimTarget(command);
  if (target && /\.(c|m)?js$/i.test(target) && isFile(target)) return { command: process.execPath, args: [target, ...args] };
  if (target && /\.exe$/i.test(target) && isFile(target)) return { command: target, args };
  throw new NookError(`${command} runs through cmd.exe, which cannot pass a prompt with line breaks; put the prompt on one line`);
}

export function launch(spec, { cwd, env }) {
  const { command, args } = windowsDirect(spec);
  const result = spawn.sync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
