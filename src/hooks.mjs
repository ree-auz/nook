import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import spawn from "cross-spawn";
import { which } from "./agents.mjs";
import { NookError } from "./errors.mjs";
import { line, useColor, indenter } from "./ui.mjs";

export const HOOK_EVENTS = ["create", "open", "remove"];

/** Extensions tried for a hook, in order. Platform scripts first, then portable ones. */
export function hookExtensions(platform = process.platform) {
  return platform === "win32" ? [".ps1", ".cmd", ".mjs", ".py"] : [".sh", ".mjs", ".py"];
}

/** Every hook in `<dir>/.nook/` for this platform. */
export function findHooks(dir, platform = process.platform) {
  return HOOK_EVENTS.map((event) => findHook(dir, event, platform)).filter(Boolean);
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

/**
 * Fingerprint of a hook's content. Line endings are normalized, so a Windows
 * checkout (CRLF) and the same file with LF count as one version.
 */
export function hookHash(file) {
  const text = readFileSync(file, "latin1").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text, "latin1").digest("hex");
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
 * Asks once before hooks run for the first time, and again after one changes,
 * listing every such hook of the repository (like worktrunk's approval prompt).
 * The file contents are not printed; the paths say where to read them.
 * `ui` is the command context (warn, info, item, note). Calls `save` after a yes.
 */
export async function ensureTrusted({ repoName, repoConfig, hooks, prompter, save, ui }) {
  const pending = hooks.filter((hook) => trustState(repoConfig, hook) !== "trusted");
  if (!pending.length) return;
  const changed = pending.some((hook) => trustState(repoConfig, hook) === "changed");
  const count = pending.length === 1 ? "1 hook" : `${pending.length} hooks`;
  ui.warn(`${repoName} needs approval to run ${count}${changed ? " (changed since you allowed them)" : ""}:`);
  for (const hook of pending)
    ui.item(`${hook.event}: .nook/${hook.name}${trustState(repoConfig, hook) === "changed" ? " (changed)" : ""}`);
  ui.info(`Read them in ${dirname(pending[0].file)}`);
  let ok;
  try {
    ok = await prompter.confirm("Allow and remember?", false);
  } catch {
    throw new NookError(`Hooks of ${repoName} need your OK. Run nk in a terminal once, or run nk init again`);
  }
  if (!ok) throw new NookError("Hooks were not allowed; nothing ran");
  repoConfig.hooks ??= {};
  for (const hook of pending) repoConfig.hooks[hook.name] = hookHash(hook.file);
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
  output.write(`${line("step", `Running ${hook.event} hook .nook/${hook.name}`, useColor(output))}\n`);
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
    // Indented under the "Running … hook" line; the log keeps the output as it was.
    const forward = (indent) => (chunk) => {
      stream.write(chunk);
      output.write(indent(chunk));
    };
    child.stdout.on("data", forward(indenter()));
    child.stderr.on("data", forward(indenter()));
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
