// @ts-check
/**
 * A list to choose one row from, on a terminal: arrows move, typing filters,
 * Enter takes the row, Esc or Ctrl+C leaves; with `sides`, Left and Right
 * take the row too, to change its value in place. Only node's own readline is used.
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
 * chosen item (and { side: -1 or 1 } for Left or Right when `sides`), or
 * { cancelled } with the key that left.
 * state: { query, at } where `at` is the chosen item (or undefined when nothing matches).
 */
export function press(state, shown, str, key = {}, sides = false) {
  const index = shown.indexOf(state.at);
  const move = (by) => ({ ...state, at: shown.length ? shown[(Math.max(index, 0) + by + shown.length) % shown.length] : undefined });
  if (key.ctrl && key.name === "c") return { cancelled: "interrupt" };
  if (key.name === "escape") return { cancelled: "escape" };
  if (key.name === "return" || key.name === "enter") return index === -1 ? state : { done: state.at };
  if (sides && (key.name === "left" || key.name === "right")) return index === -1 ? state : { done: state.at, side: key.name === "left" ? -1 : 1 };
  if (key.name === "up" || (key.ctrl && key.name === "p")) return move(-1);
  if (key.name === "down" || (key.ctrl && key.name === "n")) return move(1);
  if (key.name === "backspace") return { ...state, query: [...state.query].slice(0, -1).join("") };
  if (key.ctrl && key.name === "u") return { ...state, query: "" };
  if (str && !key.ctrl && !key.meta && [...str].every((char) => char >= " " && char !== "\x7f")) return { ...state, query: state.query + str };
  return state;
}

/**
 * Leaves raw mode. Stop reading first: on Windows, leaving raw mode while a
 * read waits starts a line-mode read that holds back what is drawn next
 * until a key is pressed.
 */
export function release(input) {
  input.pause();
  input.setRawMode?.(false);
}

/**
 * Shows the list and waits for a choice.
 * items: the rows. cells(item): its columns as texts, read again at every
 * draw, so a row can gain details while the list is open (call redraw()).
 * text(item): what typing filters on. start: the item chosen at first.
 * unicode: false where the terminal cannot show "…" and arrows.
 * hint(item): a line under the list about the chosen row.
 * sides: Left and Right choose too, with { side }.
 * onChoose(item, side) and onCancel(): may return { view } to show another
 * list in place (title, items, cells, text, start, hint, sides, onChoose,
 * onCancel); anything else ends the list. Changing lists inside the key
 * that asked for it keeps one list on screen: a Windows console can show
 * nothing for a list drawn after another one ended, until a key is pressed.
 * Returns { result, redraw }; result resolves to { item, side? } or { cancelled }.
 */
export function pick({ input, output, color = false, unicode = true, ...first }) {
  // Older Windows consoles have no "…" and no arrows in their code page.
  const more = unicode ? "…" : "...";
  /** @type {any} */
  let view = first;
  let state = { query: "", at: view.start ?? view.items[0] };
  let drawn = 0;
  let closed = false;
  const paint = (code, value) => (color ? `\x1b[${code}m${value}\x1b[0m` : value);

  const frame = () => {
    const { title, items, cells, text, hint, sides } = view;
    const columns = Math.max(20, (output.columns ?? 80) - 1);
    const shown = filter(items, state.query, text);
    // Typing can filter the chosen row away: the first one left is chosen then.
    if (!shown.includes(state.at)) state = { ...state, at: shown[0] };
    const room = Math.max(3, (output.rows ?? 24) - (hint ? 7 : 6));
    const index = Math.max(shown.indexOf(state.at), 0);
    const from = Math.min(Math.max(0, index - room + 1), Math.max(0, shown.length - room));
    const visible = shown.slice(from, from + room);
    const rows = visible.map(cells);
    const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((row) => width(row[i]))));
    const count = shown.length === items.length ? "" : `  ${shown.length} of ${items.length}`;
    const lines = [fit(`${title}${state.query ? `  filter: ${state.query}` : ""}${count}`, columns, more), ""];
    rows.forEach((row, i) => {
      const body = row.map((cell, c) => (c === row.length - 1 ? cell : cell + " ".repeat(widths[c] - width(cell)))).join("  ");
      const chosen = visible[i] === state.at;
      const line = fit(`${chosen ? ">" : " "} ${body}`.trimEnd(), columns, more);
      lines.push(chosen ? paint(1, line) : line);
    });
    if (!shown.length) lines.push(`  nothing matches "${state.query}"`);
    if (shown.length > from + room) lines.push(paint(2, `  ${more} ${shown.length - from - room} more below`));
    const about = state.at === undefined ? "" : (hint?.(state.at) ?? "");
    lines.push("");
    if (about) lines.push(fit(about, columns, more));
    const change = sides ? ` · ${unicode ? "←→" : "Left/Right"} change` : "";
    lines.push(paint(2, fit(`${unicode ? "↑↓" : "Up/Down"} move${change} · type to filter · Enter choose · Esc cancel`, columns, more)));
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
    const finish = (value) => {
      closed = true;
      input.off("keypress", onKey);
      output.off?.("resize", redraw);
      release(input);
      // The list goes, so the terminal is left as it was; the cursor comes back.
      output.write(`${erase()}\x1b[?25h`);
      done(value);
    };
    const onKey = (str, key) => {
      const next = press(state, filter(view.items, state.query, view.text), str, key, view.sides);
      if ("done" in next || "cancelled" in next) {
        const after = "done" in next ? view.onChoose?.(next.done, next.side) : next.cancelled === "escape" ? view.onCancel?.() : undefined;
        if (after?.view) {
          view = after.view;
          state = { query: "", at: view.start ?? view.items[0] };
          return redraw();
        }
        if ("cancelled" in next) return finish({ cancelled: next.cancelled });
        return finish("side" in next ? { item: next.done, side: next.side } : { item: next.done });
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
