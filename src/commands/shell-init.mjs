// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { which } from "../agents.mjs";
import { NookError } from "../errors.mjs";

/**
 * A program cannot change the folder of the shell that started it, so going
 * to a workspace takes a function of the shell itself: nks. It runs
 * nk switch, which draws its list on stderr, and changes to the folder that
 * comes back on stdout. Nothing comes back when the list was left or nk
 * failed, and the function then stays where it is.
 *
 * nk shell-init <shell> prints the function. nk shell-init --install, and
 * nk init after asking, write it into the shell's profile between two marker
 * lines, so that a new terminal has nks without starting nk first.
 */
const SHELLS = {
  powershell: {
    load: "Invoke-Expression (& nk shell-init powershell | Out-String)",
    profile: "$PROFILE",
    // nk prints the folder as UTF-8. PowerShell reads a program's output in the console's
    // encoding, which on Windows is often another one, so it is set for this one call:
    // otherwise a folder with letters outside ASCII would come back garbled.
    code: `function nks {
    $nookEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $nookPath = & nk switch @args
    } finally {
        [Console]::OutputEncoding = $nookEncoding
    }
    if ($LASTEXITCODE -eq 0 -and $nookPath) {
        Set-Location -LiteralPath $nookPath
    }
}`,
  },
  bash: {
    load: 'eval "$(nk shell-init bash)"',
    profile: "~/.bashrc",
    code: `nks() {
  local nook_path
  nook_path="$(command nk switch "$@")" || return
  [ -n "$nook_path" ] && cd -- "$nook_path"
}`,
  },
  zsh: {
    load: 'eval "$(nk shell-init zsh)"',
    profile: "~/.zshrc",
    code: `nks() {
  local nook_path
  nook_path="$(command nk switch "$@")" || return
  [ -n "$nook_path" ] && cd -- "$nook_path"
}`,
  },
  fish: {
    load: "nk shell-init fish | source",
    profile: "~/.config/fish/config.fish",
    code: `function nks --description "Go to a nk workspace"
    set -l nook_path (command nk switch $argv)
    or return
    test -n "$nook_path"; and cd -- $nook_path
end`,
  },
};

// What people type for the same shells.
const ALIASES = { pwsh: "powershell", ps: "powershell", ps1: "powershell" };

export const SHELL_NAMES = Object.keys(SHELLS);

/** The text nk shell-init prints for a shell: comments on how to load it, then the function. */
export function shellInit(name) {
  const key = resolve(name);
  const shell = SHELLS[key];
  return `# nks: choose a nk workspace and go to its folder (nks <name> goes there without the list).
# To have it in every new ${key} session: nk shell-init --install
# Or add this line to ${shell.profile} yourself:
#   ${shell.load}
${shell.code}`;
}

function resolve(name) {
  const key = ALIASES[String(name).toLowerCase()] ?? String(name).toLowerCase();
  if (!Object.hasOwn(SHELLS, key)) throw new NookError(`Unknown shell "${name}"\nUse one of: ${SHELL_NAMES.join(", ")}`);
  return key;
}

/** PowerShell's own answer to where its profile is: the Documents folder can be moved (OneDrive), so it is not worked out here. */
function askPowerShell(program) {
  const result = spawnSync(program, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $PROFILE"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/**
 * The profiles nks belongs in on this machine, as [{ shell, file }].
 * Windows: PowerShell 7 and Windows PowerShell, whichever is installed.
 * Elsewhere: the login shell ($SHELL). `only` names one shell instead.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, home?: string, ask?: (program: string) => string | null, only?: string }} [options]
 * @returns {{ shell: string, file: string }[]}
 */
export function profiles({ env = process.env, platform = process.platform, home = env.HOME || homedir(), ask = askPowerShell, only } = {}) {
  const posix = {
    bash: join(home, ".bashrc"),
    zsh: join(env.ZDOTDIR || home, ".zshrc"),
    fish: join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "config.fish"),
  };
  const powershell = (programs) =>
    programs.flatMap((program) => {
      const file = which(program, env) ? ask(program) : null;
      return file ? [{ shell: "powershell", file }] : [];
    });
  const key = only ? resolve(only) : platform === "win32" ? "powershell" : basename(env.SHELL || "");
  if (key === "powershell" || key === "pwsh") return powershell(platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]);
  return Object.hasOwn(posix, key) ? [{ shell: key, file: posix[key] }] : [];
}

const BEGIN = "# >>> nk shell-init >>>";
const END = "# <<< nk shell-init <<<";

/** The lines nk keeps in a profile, between its two markers. */
export function profileBlock(shell) {
  return [BEGIN, "# nks: choose a nk workspace and go to its folder. Written by nk shell-init --install;", "# remove these lines, markers included, to remove it.", SHELLS[resolve(shell)].code, END].join("\n");
}

/** A profile as text and how to write it back: Windows PowerShell profiles made in Notepad can be UTF-16. */
function readProfile(file) {
  if (!existsSync(file)) return { text: "", encoding: "latin1", bom: "" };
  const bytes = readFileSync(file);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString("utf16le"), encoding: "utf16le", bom: "\ufeff" };
  // Every byte is kept as it is; what nk adds is ASCII, which is the same in every encoding in use.
  return { text: bytes.toString("latin1"), encoding: "latin1", bom: "" };
}

/** Whether a profile already has nk's lines, as they are now. */
export function profileState(file, shell) {
  const { text } = readProfile(file);
  const start = text.indexOf(BEGIN);
  if (start === -1) return "missing";
  const end = text.indexOf(END, start);
  const block = end === -1 ? "" : text.slice(start, end + END.length).replace(/\r\n/g, "\n");
  return block === profileBlock(shell) ? "current" : "outdated";
}

/**
 * Puts nk's lines into a profile: added at the end, or in place of the lines
 * an older nk wrote. Nothing else in the file changes. Returns "added",
 * "updated" or "current".
 */
export function installProfile(file, shell) {
  const state = profileState(file, shell);
  if (state === "current") return "current";
  const { text, encoding, bom } = readProfile(file);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = profileBlock(shell).replace(/\n/g, eol);
  let next;
  if (state === "outdated") {
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END, start);
    next = text.slice(0, start) + block + (end === -1 ? eol : text.slice(end + END.length));
  } else next = text + (text && !text.endsWith("\n") ? eol : "") + (text ? eol : "") + block + eol;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(bom + next, /** @type {BufferEncoding} */ (encoding)));
  return state === "outdated" ? "updated" : "added";
}

/** Writes nks into the given profiles and says what happened to each. */
export function installInto(ctx, targets) {
  for (const { shell, file } of targets) {
    const done = installProfile(file, shell);
    if (done === "current") ctx.info(`nks is already in ${file}`);
    else ctx.ok(`${done === "added" ? "Added nks to" : "Updated nks in"} ${file}`);
  }
  if (targets.length) ctx.info("Open a new terminal to use it: nks shows your workspaces, nks <name> goes to one");
}

/** nk shell-init <shell> | nk shell-init --install [shell] */
export function printShellInit(ctx, { shell, install = false, find = profiles }) {
  if (install) {
    const targets = find({ env: ctx.env, only: shell });
    if (!targets.length)
      throw new NookError(
        shell
          ? `${shell} is not installed here, so it has no profile to write to`
          : `Cannot tell which shell you use${ctx.env.SHELL ? ` (${ctx.env.SHELL})` : ""}\nName it: nk shell-init --install <shell> (${SHELL_NAMES.join(", ")})`,
      );
    installInto(ctx, targets);
    return 0;
  }
  if (!shell) throw new NookError(`Usage: nk shell-init <shell> | nk shell-init --install [shell]\nShells: ${SHELL_NAMES.join(", ")}`);
  ctx.print(shellInit(shell));
  return 0;
}
