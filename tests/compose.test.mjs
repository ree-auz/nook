import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { describeProject, findComposeProjects, leftoverComposeProjects, removeComposeProject } from "../src/compose.mjs";

const ws = resolve("/work/nook/workspace/demo/feat");
const main = resolve("/work/demo");

/** A stand-in for the docker CLI: answers ls calls from a table, records the rest. */
function fakeDocker(containers, labelled = {}) {
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    if (args[0] === "container" && args[1] === "ls") return { ok: true, out: containers.map((c) => c.join("\t")).join("\n") };
    if (args[1] === "ls") {
      const project = args.at(-1).split("=").at(-1);
      return { ok: true, out: (labelled[project]?.[args[0]] ?? []).join("\n") };
    }
    return { ok: true, out: "" };
  };
  return { docker, calls };
}

test("finds the Compose projects started inside a workspace, with their volumes, networks and built images", () => {
  const { docker } = fakeDocker(
    [
      ["c1", "feat", ws],
      ["c2", "feat", join(ws, "services")],
      ["c3", "demo", main],
    ],
    { feat: { volume: ["feat_db"], network: ["n1"], image: ["i1"] } },
  );
  const { projects, shared } = findComposeProjects(ws, docker);
  assert.deepEqual(shared, []);
  assert.deepEqual(projects, [{ name: "feat", containers: ["c1", "c2"], volumes: ["feat_db"], networks: ["n1"], images: ["i1"] }]);
  assert.equal(describeProject(projects[0]), "Compose project feat: 2 containers, 1 volume, 1 network, 1 built image");
});

test("a project that also runs outside the workspace is kept", () => {
  const { docker } = fakeDocker([
    ["c1", "pipit", ws],
    ["c2", "pipit", main],
  ]);
  assert.deepEqual(findComposeProjects(ws, docker), { projects: [], shared: ["pipit"] });
});

test("without Docker nothing is found and nothing fails", () => {
  const result = findComposeProjects(ws, () => ({ ok: false, out: "", err: "not installed" }));
  assert.deepEqual(result, { unavailable: "not installed", projects: [], shared: [] });
});

test("removes containers first, then volumes, networks and images", () => {
  const { docker, calls } = fakeDocker([]);
  removeComposeProject({ name: "feat", containers: ["c1"], volumes: ["v1"], networks: [], images: ["i1"] }, docker);
  assert.deepEqual(calls, [
    ["container", "rm", "-f", "-v", "c1"],
    ["volume", "rm", "-f", "v1"],
    ["image", "rm", "-f", "i1"],
  ]);
  assert.throws(() => removeComposeProject({ name: "x", containers: ["c"], volumes: [], networks: [], images: [] }, () => ({ ok: false, err: "busy" })), /container rm failed: busy/);
});

test("doctor's check: projects left behind by a workspace that is gone", () => {
  const root = resolve("/work/nook/workspace/demo");
  const docker = () => ({
    ok: true,
    out: [`old\t${join(root, "old")}`, `feat\t${ws}`, `demo\t${main}`].join("\n"),
  });
  assert.deepEqual(leftoverComposeProjects(root, [ws], docker), [{ name: "old", dir: join(root, "old") }]);
});
