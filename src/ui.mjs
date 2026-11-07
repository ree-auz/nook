/**
 * Line prefixes in the style of worktrunk: ◎ a step that runs now, ✓ done,
 * ▲ needs attention, ✗ failed, ○ information, ┃ an item under the line above.
 * Colors only on a terminal, and never when NO_COLOR is set (no-color.org).
 */
const UNICODE = { step: "◎", ok: "✓", warn: "▲", fail: "✗", info: "○", item: "┃" };
// Older Windows consoles show ✓ and ✗ as "?"; √ and × exist in their code pages
// (the same fallbacks as the figures package).
const FALLBACK = { ...UNICODE, ok: "√", fail: "×" };
const COLORS = { step: 36, ok: 32, warn: 33, fail: 31, info: 2, item: 2 };

/** The checks of the is-unicode-supported package, plus Warp. */
export function unicodeSupported(env = process.env, platform = process.platform) {
  if (platform !== "win32") return env.TERM !== "linux";
  return (
    Boolean(env.WT_SESSION) ||
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === "{cmd::Cmder}" ||
    ["Terminus-Sublime", "vscode", "WarpTerminal"].includes(env.TERM_PROGRAM) ||
    ["xterm-256color", "alacritty", "rxvt-unicode", "rxvt-unicode-256color"].includes(env.TERM) ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
  );
}

const SYMBOLS = unicodeSupported() ? UNICODE : FALLBACK;

export function useColor(stream, env = process.env) {
  return Boolean(stream?.isTTY) && !("NO_COLOR" in env) && env.TERM !== "dumb";
}

export function line(kind, text, color = false) {
  const symbol = SYMBOLS[kind];
  const mark = color ? `\x1b[${COLORS[kind]}m${symbol}\x1b[0m` : symbol;
  return kind === "item" ? `   ${mark} ${text}` : `${mark} ${text}`;
}
