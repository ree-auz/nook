import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findOccupants, parseLsof, stopProcesses } from "../src/occupancy.mjs";
import { tempDir } from "./helpers.mjs";

test("parses lsof field output", () => {
  const text = ["p101", "csleep", "fcwd", "n/work/demo", "p102", "cnode", "f12", "n/work/demo/file.txt", "p103", "cvim", "fcwd", "n/work/demo-two"].join("\n");
  assert.deepEqual(parseLsof(text, "/work/demo", "linux"), [{ pid: 101, name: "sleep", reasons: ["working directory"] }]);
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


test("stops a process running in the folder", async (t) => {
  const dir = join(tempDir(t), "ws");
  mkdirSync(dir);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: dir, stdio: "ignore" });
  t.after(() => child.kill());
  const exited = new Promise((done) => child.once("exit", done));
  await new Promise((done) => setTimeout(done, 500));
  const found = findOccupants(dir).processes.filter((item) => item.pid === child.pid);
  assert.equal(found.length, 1);
  await stopProcesses(found);
  await exited;
  assert.ok(!findOccupants(dir).processes.some((item) => item.pid === child.pid));
});
