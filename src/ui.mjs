/**
 * Line prefixes in the style of worktrunk: ◎ a step that runs now, ✓ done,
 * ▲ needs attention, ○ information, ┃ an item under the line above.
 * Colors only on a terminal, and never when NO_COLOR is set (no-color.org).
 */
const SYMBOLS = { step: "◎", ok: "✓", warn: "▲", info: "○", item: "┃" };
const COLORS = { step: 36, ok: 32, warn: 33, info: 2, item: 2 };

export function useColor(stream, env = process.env) {
  return Boolean(stream?.isTTY) && !("NO_COLOR" in env) && env.TERM !== "dumb";
}

export function line(kind, text, color = false) {
  const symbol = SYMBOLS[kind];
  const mark = color ? `\x1b[${COLORS[kind]}m${symbol}\x1b[0m` : symbol;
  return kind === "item" ? `   ${mark} ${text}` : `${mark} ${text}`;
}
