// @ts-check
/**
 * Line prefixes in the style of worktrunk: ◎ a step that runs now, ✓ done,
 * ▲ needs attention, ✗ failed, ○ information, ┃ an item under the line above,
 * ? a question.
 * Colors only on a terminal, and never when NO_COLOR is set (no-color.org).
 */
const UNICODE = { step: "◎", ok: "✓", warn: "▲", fail: "✗", info: "○", item: "┃", ask: "?" };
// Older Windows consoles show ✓ and ✗ as "?"; √ and × exist in their code pages
// (the same fallbacks as the figures package).
const FALLBACK = { ...UNICODE, ok: "√", fail: "×" };
const COLORS = { step: 36, ok: 32, warn: 33, fail: 31, info: 2, item: 2, ask: 35 };

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

/**
 * Indents another program's output by two columns, under the text of the line
 * above it. Docker Compose starts its lines with one space; that space goes.
 * Returns a function that takes chunks and returns them indented.
 */
export function indenter(width = 2) {
  const pad = " ".repeat(width);
  let state = "start"; // start of a line, after one leading space, or inside it
  return (chunk) => {
    let out = "";
    for (const char of String(chunk)) {
      const newline = char === "\n" || char === "\r";
      if (state === "mid") out += char;
      else if (newline) out += char;
      else if (state === "start" && char === " ") {
        state = "space";
        continue;
      } else out += pad + (state === "space" && char === " " ? "  " : char);
      state = newline ? "start" : "mid";
    }
    return out;
  };
}

/**
 * A hint in the shape ls, clean, rm and doctor all use: the state in one of a
 * few words (merged, locked, prunable, ignored data, unknown, ...), why, and
 * the command that moves on from it.
 */
export function hint(state, reason, next) {
  return `${state}${reason ? `: ${reason}` : ""}${next ? `. Next: ${next}` : ""}`;
}

/**
 * Drops columns, last named first, until the rows fit `width`; never the first
 * two. Returns the rows and the headers it dropped. No width (not a terminal): all stay.
 */
export function fitColumns(rows, width, drop) {
  const measure = (table) => table[0].reduce((sum, _, i) => sum + Math.max(...table.map((row) => row[i].length)) + 2, -2);
  let table = rows;
  const dropped = [];
  for (const header of drop) {
    if (!width || measure(table) <= width) break;
    const i = table[0].indexOf(header);
    if (i < 2) continue;
    table = table.map((row) => row.filter((_, j) => j !== i));
    dropped.push(header);
  }
  return { rows: table, dropped };
}
