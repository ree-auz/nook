import assert from "node:assert/strict";
import test from "node:test";
import { failureCause } from "../scripts/real-cause.mjs";
import { summary } from "../scripts/real-summary.mjs";

// The two failures of the weekly run of 2026-11-09, from their logs.
const KNEX = "  npm error gyp ERR! not ok\n  Failed (exit 1): npm i pg-native\n✗ The hooks did not pass:\n   ┃ create failed (exit 1). Log: /tmp/x.log";
const MONICA = "  container nook-monica-nook-hooks-test-meilisearch-1 is unhealthy\n  Failed (exit 1): docker compose up --detach --wait --quiet-pull redis memcached meilisearch mailpit\n◎ Running remove hook .nook/remove.mjs";

test("a failed setup command of the repository is the repository's", () => {
  assert.deepEqual(failureCause("nk hooks test", KNEX), { cause: "repository", why: "its own setup command failed (exit 1): npm i pg-native", command: "npm i pg-native" });
  assert.equal(failureCause("nk hooks test", MONICA).cause, "repository");
  assert.equal(failureCause("nk -b try1", MONICA).cause, "repository");
});

test("a broken promise or a crash is nk's, whatever else the output says", () => {
  for (const step of ["try1 and try2 share nothing", "data written in try1 stays in try1", "removing try1 leaves try2 and the main checkout alone", "nothing left behind, main checkout intact", "nk rm try2", "try1 is clean in git", "try2 .env uses its own ports", "nk hooks write"])
    assert.equal(failureCause(step, MONICA).cause, "nk", step);
  const crash = "TypeError: Cannot read properties of undefined (reading 'path')\n    at planRemoval (file:///home/runner/work/nook/nook/nook/src/commands/rm.mjs:120:11)";
  assert.deepEqual(failureCause("nk hooks test", `${KNEX}\n${crash}`), { cause: "nk", why: "nk crashed" });
  // A stack trace out of the repository's own tools is not nk crashing.
  assert.equal(failureCause("nk hooks test", `TypeError: x\n    at run (/tmp/ws/node_modules/tool/index.js:1:1)\n${KNEX}`).cause, "repository");
});

test("the rest is the runner's or not told apart", () => {
  assert.equal(failureCause("clone", "fatal: unable to access").cause, "runner");
  assert.equal(failureCause("nk hooks test", "✗ The hooks did not pass").cause, "unknown");
  assert.equal(failureCause(null), null);
});

test("the summary puts nk's failures first and counts each kind", () => {
  const result = (name, cause, extra = {}) => ({ name, repo: `o/${name}`, commit: "c", new: false, ok: !cause, failedAt: cause ? "nk hooks test" : null, cause, why: cause ? `${cause} reason` : null, steps: [{ step: "nk hooks test", ok: !cause, seconds: 60, output: "last | line" }], ...extra });
  const text = summary([result("knex", "repository"), result("zed", "nk"), result("fine", null), result("old", undefined, { ok: false, failedAt: "nk -b try1" }), result("fresh", "repository", { new: true })]);
  assert.match(text, /## nk on real repositories: 1 of 5 passed/);
  assert.match(text, /Failed: 1 nk, 1 unknown, 2 repository/);
  assert.ok(text.indexOf("nk broke a promise") < text.indexOf("Not told apart") && text.indexOf("Not told apart") < text.indexOf("own setup failed"));
  assert.match(text, /\| \[zed\]\(https:\/\/github.com\/o\/zed\) \| nk hooks test \| nk reason \| 1\.0 \|/);
  assert.match(text, /\[fresh\]\(https:\/\/github.com\/o\/fresh\) \(new\)/);
  assert.match(text, /last \\\| line/);
  assert.match(text, /### Passed[^]*\[fine\]/);
});
