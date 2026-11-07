import assert from "node:assert/strict";
import test from "node:test";
import { indenter, unicodeSupported } from "../src/ui.mjs";

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
