import assert from "node:assert/strict";
import test from "node:test";
import { unicodeSupported } from "../src/ui.mjs";

test("check marks fall back on older Windows consoles only", () => {
  assert.equal(unicodeSupported({}, "linux"), true);
  assert.equal(unicodeSupported({}, "win32"), false);
  assert.equal(unicodeSupported({ WT_SESSION: "1" }, "win32"), true);
  assert.equal(unicodeSupported({ TERM_PROGRAM: "WarpTerminal" }, "win32"), true);
});
