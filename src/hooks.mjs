import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import spawn from "cross-spawn";
import { which } from "./agents.mjs";
import { NookError } from "./errors.mjs";

export const HOOK_EVENTS = ["create", "open", "remove"];

/** Extensions tried for a hook, in order. Platform scripts first, then portable ones. */
export function hookExtensions(platform = process.platform) {
  return platform === "win32" ? [".ps1", ".cmd", ".mjs", ".py"] : [".sh", ".mjs", ".py"];
}

/** The hook file for `event` in `<dir>/.nook/`, or null. */
export function findHook(dir, event, platform = process.platform) {
  let entries;
  try {
    entries = readdirSync(join(dir, ".nook"));
  } catch {
    return null;
  }
  for (const ext of hookExtensions(platform)) {
    const name = event + ext;
    if (entries.includes(name)) return { event, ext, name, file: join(dir, ".nook", name) };
  }
  return null;
}

export function hookHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** How to run a hook file: { command, args }. */
export function hookCommand(hook, { platform = process.platform, find = which } = {}) {
  switch (hook.ext) {
    case ".ps1": {
      const shell = find("pwsh") ?? (platform === "win32" ? "powershell.exe" : "pwsh");
      return { command: shell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hook.file] };
    }
    case ".cmd":
      return { command: hook.file, args: [] };
    case ".sh":
      return { command: find("bash") ?? "sh", args: [hook.file] };
    case ".mjs":
      return { command: process.execPath, args: [hook.file] };
    case ".py": {
      const python = find("python3") ?? find("python") ?? "python3";
      return { command: python, args: [hook.file] };
    }
    default:
      throw new NookError(`Unknown hook type: ${hook.name}`);
  }
}

/** "trusted", "new" or "changed" for a hook of a repository. */
export function trustState(repoConfig, hook) {
  const saved = repoConfig.hooks?.[hook.name];
  if (!saved) return "new";
  return saved === hookHash(hook.file) ? "trusted" : "changed";
}

/**
 * Shows the hook and asks before its first run, and again after it changes.
 * Calls `save` after the person says yes.
 */
export async function ensureTrusted({ repoConfig, hook, prompter, save, output = process.stderr }) {
  const state = trustState(repoConfig, hook);
  if (state === "trusted") return;
  const text = readFileSync(hook.file, "utf8");
  const lines = text.split(/\r?\n/);
  output.write(`\n${state === "new" ? "New" : "Changed"} hook .nook/${hook.name} wants to run:\n`);
  output.write(`${"-".repeat(60)}\n${lines.slice(0, 200).join("\n")}\n`);
  if (lines.length > 200) output.write(`... ${lines.length - 200} more lines in ${hook.file}\n`);
  output.write(`${"-".repeat(60)}\n`);
  let ok;
  try {
    ok = await prompter.confirm(`Allow .nook/${hook.name} to run?`, false);
  } catch (error) {
    throw new NookError(`Hook .nook/${hook.name} is ${state} and needs your OK. Run nk in a terminal once, or run nk init again`);
  }
  if (!ok) throw new NookError(`Hook .nook/${hook.name} was not allowed`);
  repoConfig.hooks ??= {};
  repoConfig.hooks[hook.name] = hookHash(hook.file);
  save();
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Runs a hook in the workspace. Output goes to the terminal and to a log file.
 * Resolves to { status, log }.
 */
export function runHook(hook, { cwd, env, logsDir, label, output = process.stderr }) {
  mkdirSync(logsDir, { recursive: true });
  const log = join(logsDir, `${label}-${hook.event}-${stamp()}.log`);
  const stream = createWriteStream(log);
  const { command, args } = hookCommand(hook);
  output.write(`> .nook/${hook.name}\n`);
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
    const forward = (chunk) => {
      stream.write(chunk);
      output.write(chunk);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    let finished = false;
    const finish = (status, error) => {
      if (finished) return;
      finished = true;
      if (error) stream.write(`\n${error.message}\n`);
      stream.end(() => done({ status, log }));
    };
    child.on("error", (error) => finish(127, error));
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}
