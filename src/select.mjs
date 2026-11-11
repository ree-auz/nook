// @ts-check
/**
 * A list to choose one row from, on a terminal: arrows move, typing filters,
 * Enter takes the row, Esc or Ctrl+C leaves. Only node's own readline is used.
 * Everything is drawn on `output` (stderr for nk), so stdout stays free for
 * the answer.
 */
import { emitKeypressEvents } from "node:readline";

/** Columns a text takes on a terminal: 2 for CJK and other wide characters, 1 for the rest. */
export function width(text) {
  let n = 0;
  for (const char of text) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(char) ? 2 : 1;
  return n;
}

/** `text` cut to fit in `columns`, ending in "…" when something was cut. */
export function fit(text, columns, more = "…") {
  if (width(text) <= columns) return text;
  let out = "";
  let n = 0;
  for (const char of text) {
    const w = width(char);
    if (n + w > columns - more.length) break;
    out += char;
    n += w;
  }
  return `${out}${more}`;
}

/** The items whose text has every word of `query`, in any order and any case. */
export function filter(items, query, text) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => words.every((word) => text(item).toLowerCase().includes(word)));
}

/**
 * What a key does to the list. Returns the new state, or { done } with the
 * chosen item, or { cancelled } with the key that left.
 * state: { query, at } where `at` is the chosen item (or undefined when nothing matches).
 */
export function press(state, shown, str, key = {}) {
  const index = shown.indexOf(state.at);
  const move = (by) => ({ ...state, at: shown.length ? shown[(Math.max(index, 0) + by + shown.length) % shown.length] : undefined });
  if (key.ctrl && key.name === "c") return { cancelled: "interrupt" };
  if (key.name === "escape") return { cancelled: "escape" };
  if (key.name === "return" || key.name === "enter") {
    if (state.marked?.length) return { done: state.at, marked: state.marked };
    return index === -1 ? state : { done: state.at };
  }
  // With several to choose (state.marked), Tab marks the row or unmarks it and moves on.
  if (key.name === "tab" && state.marked && index !== -1) {
    const marked = state.marked.includes(state.at) ? state.marked.filter((item) => item !== state.at) : [...state.marked, state.at];
    return { ...move(1), marked };
  }
  if (key.name === "up" || (key.ctrl && key.name === "p")) return move(-1);
  if (key.name === "down" || (key.ctrl && key.name === "n")) return move(1);
  if (key.name === "backspace") return { ...state, query: [...state.query].slice(0, -1).join("") };
  if (key.ctrl && key.name === "u") return { ...state, query: "" };
  if (str && !key.ctrl && !key.meta && [...str].every((char) => char >= " " && char !== "\x7f")) return { ...state, query: state.query + str };
  return state;
}

/**
 * Shows the list and waits for a choice.
 * items: the rows. cells(item): its columns as texts, read again at every
 * draw, so a row can gain details while the list is open (call redraw()).
 * text(item): what typing filters on. start: the item chosen at first.
 * unicode: false where the terminal cannot show "…" and arrows.
 * multi: Tab marks rows, and Enter takes the marked ones (or the chosen row
 * when none is marked).
 * Returns { result, redraw }; result resolves to { item } (with multi, also { items }) or { cancelled }.
 */
export function pick({ input, output, title, items, cells, text, start, color = false, unicode = true, multi = false }) {
  // Older Windows consoles have no "…" and no arrows in their code page.
  const more = unicode ? "…" : "...";
  /** @type {{ query: string, at: any, marked?: any[] }} */
  let state = { query: "", at: start ?? items[0], ...(multi ? { marked: [] } : {}) };
  let drawn = 0;
  let closed = false;
  const paint = (code, value) => (color ? `\x1b[${code}m${value}\x1b[0m` : value);

  const frame = () => {
    const columns = Math.max(20, (output.columns ?? 80) - 1);
    const shown = filter(items, state.query, text);
    // Typing can filter the chosen row away: the first one left is chosen then.
    if (!shown.includes(state.at)) state = { ...state, at: shown[0] };
    const room = Math.max(3, (output.rows ?? 24) - 6);
    const index = Math.max(shown.indexOf(state.at), 0);
    const from = Math.min(Math.max(0, index - room + 1), Math.max(0, shown.length - room));
    const visible = shown.slice(from, from + room);
    const rows = visible.map(cells);
    const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((row) => width(row[i]))));
    const count = `${shown.length === items.length ? "" : `  ${shown.length} of ${items.length}`}${state.marked?.length ? `  ${state.marked.length} marked` : ""}`;
    const lines = [fit(`${title}${state.query ? `  filter: ${state.query}` : ""}${count}`, columns, more), ""];
    rows.forEach((row, i) => {
      const body = row.map((cell, c) => (c === row.length - 1 ? cell : cell + " ".repeat(widths[c] - width(cell)))).join("  ");
      const chosen = visible[i] === state.at;
      const marked = state.marked?.includes(visible[i]) ? "+" : " ";
      const line = fit(`${chosen ? ">" : " "}${multi ? marked : ""} ${body}`.trimEnd(), columns, more);
      lines.push(chosen ? paint(1, line) : line);
    });
    if (!shown.length) lines.push(`  nothing matches "${state.query}"`);
    if (shown.length > from + room) lines.push(paint(2, `  ${more} ${shown.length - from - room} more below`));
    const keys = `${unicode ? "↑↓" : "Up/Down"} move · type to filter${multi ? " · Tab mark" : ""} · Enter choose · Esc cancel`;
    lines.push("", paint(2, fit(keys, columns, more)));
    return lines;
  };

  const erase = () => (drawn ? `\x1b[${drawn}A\r\x1b[J` : "");
  const redraw = () => {
    if (closed) return;
    const lines = frame();
    output.write(`${erase()}${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  const result = new Promise((done) => {
    const onKey = (str, key) => {
      const next = press(state, filter(items, state.query, text), str, key);
      if ("done" in next || "cancelled" in next) {
        closed = true;
        input.off("keypress", onKey);
        output.off?.("resize", redraw);
        input.setRawMode?.(false);
        input.pause();
        // The list goes, so the terminal is left as it was; the cursor comes back.
        output.write(`${erase()}\x1b[?25h`);
        if ("cancelled" in next) return done({ cancelled: next.cancelled });
        return done(multi ? { item: next.done, items: next.marked ?? [next.done] } : { item: next.done });
      }
      state = next;
      redraw();
    };
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKey);
    output.on?.("resize", redraw);
    input.resume();
    output.write("\x1b[?25l");
    redraw();
  });
  return { result, redraw };
}
