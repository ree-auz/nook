import assert from "node:assert/strict";
import test from "node:test";
import { fitColumns, hint, indenter, unicodeSupported } from "../src/ui.mjs";

test("check marks fall back on older Windows consoles only", () => {
  assert.equal(unicodeSupported({}, "linux"), true);
  assert.equal(unicodeSupported({}, "win32"), false);
  assert.equal(unicodeSupported({ WT_SESSION: "1" }, "win32"), true);
  assert.equal(unicodeSupported({ TERM_PROGRAM: "WarpTerminal" }, "win32"), true);
});

test("other programs' output is indented under nk's text, without Compose's leading space", () => {
  const indent = indenter();
  const out = indent(" Container db Running\n Contai") + indent("ner db Healthy\n+ react@19\n\n   kept\n");
  assert.equal(out, "  Container db Running\n  Container db Healthy\n  + react@19\n\n     kept\n");
});

test("a hint says the state, why, and what to run next, leaving out what is not given", () => {
  assert.equal(hint("locked", "nk clean leaves it", "git worktree unlock /w"), "locked: nk clean leaves it. Next: git worktree unlock /w");
  assert.equal(hint("other branch", "checked out main"), "other branch: checked out main");
  assert.equal(hint("leftover", "", "nk clean deletes it"), "leftover. Next: nk clean deletes it");
});

test("columns are dropped in the order given until the table fits, never the first two", () => {
  const rows = [
    ["", "NAME", "PORTS", "PATH"],
    ["+", "work", "20000-20009", "/a/very/long/path/to/the/workspace"],
  ];
  assert.deepEqual(fitColumns(rows, 0, ["PATH"]), { rows, dropped: [] });
  assert.deepEqual(fitColumns(rows, 200, ["PATH"]), { rows, dropped: [] });
  assert.deepEqual(fitColumns(rows, 20, ["PATH", "PORTS"]).rows, [
    ["", "NAME", "PORTS"],
    ["+", "work", "20000-20009"],
  ]);
  assert.deepEqual(fitColumns(rows, 5, ["PATH", "PORTS", "NAME"]), { rows: [["", "NAME"], ["+", "work"]], dropped: ["PATH", "PORTS"] });
});
