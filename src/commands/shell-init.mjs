// @ts-check
import { NookError } from "../errors.mjs";

/**
 * A program cannot change the folder of the shell that started it, so going
 * to a workspace takes a function of the shell itself: nks. It runs
 * nk switch, which draws its list on stderr, and changes to the folder that
 * comes back on stdout. Nothing comes back when the list was left or nk
 * failed, and the function then stays where it is.
 *
 * nk never writes to a shell profile: it prints the function, and the line
 * that loads it is the user's to add.
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
  const key = ALIASES[String(name).toLowerCase()] ?? String(name).toLowerCase();
  const shell = Object.hasOwn(SHELLS, key) ? SHELLS[key] : null;
  if (!shell) throw new NookError(`Unknown shell "${name}"\nUse one of: ${SHELL_NAMES.join(", ")}`);
  return `# nks: choose a nk workspace and go to its folder (nks <name> goes there without the list).
# To have it in every new ${key} session, add this line to ${shell.profile}:
#   ${shell.load}
${shell.code}`;
}

/** nk shell-init <shell> */
export function printShellInit(ctx, { shell }) {
  if (!shell) throw new NookError(`Usage: nk shell-init <shell>\nShells: ${SHELL_NAMES.join(", ")}`);
  ctx.print(shellInit(shell));
  return 0;
}
