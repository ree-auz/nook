import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findOccupants, parseLsof } from "../src/occupancy.mjs";
import { tempDir } from "./helpers.mjs";

test("parses lsof field output", () => {
  const text = ["p101", "csleep", "fcwd", "n/work/demo", "p102", "cnode", "f12", "n/work/demo/file.txt", "f13", "n/other", "p103", "cvim", "fcwd", "n/work/demo-two"].join("\n");
  assert.deepEqual(parseLsof(text, "/work/demo", "linux"), [
    { pid: 101, name: "sleep", reasons: ["working directory"] },
    { pid: 102, name: "node", reasons: ["open file"] },
  ]);
});

test("finds a process whose working directory is inside", async (t) => {
  const dir = join(tempDir(t), "ws");
  mkdirSync(dir);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: dir, stdio: "ignore" });
  t.after(() => child.kill());
  await new Promise((done) => setTimeout(done, 500));
  const result = findOccupants(dir);
  assert.equal(result.unsupported, undefined, result.unsupported);
  assert.ok(
    result.processes.some((item) => item.pid === child.pid),
    `expected PID ${child.pid} in ${JSON.stringify(result.processes)}`,
  );
  child.kill();
  await new Promise((done) => child.once("exit", done));
  assert.ok(!findOccupants(dir).processes.some((item) => item.pid === child.pid));
});

test("on Windows, finds an open file but skips dependency folders", { skip: process.platform !== "win32" }, async (t) => {
  const root = tempDir(t);
  const dir = join(root, "ws");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "src", "held.txt"), "x");
  for (let i = 0; i < 2000; i++) writeFileSync(join(dir, "node_modules", "pkg", `f${i}.js`), "");
  const holder = spawn(process.execPath, ["-e", `require("fs").openSync(${JSON.stringify(join(dir, "src", "held.txt"))}, "r+"); setInterval(() => {}, 1000)`], { cwd: root, stdio: "ignore" });
  t.after(() => holder.kill());
  await new Promise((done) => setTimeout(done, 800));
  const started = Date.now();
  const result = findOccupants(dir);
  assert.equal(result.unsupported, undefined, result.unsupported);
  assert.ok(Date.now() - started < 20000, `scan took ${Date.now() - started} ms`);
  assert.ok(
    result.processes.some((item) => item.pid === holder.pid && item.reasons.includes("open file")),
    `expected PID ${holder.pid} holding a file in ${JSON.stringify(result.processes)}`,
  );
});
