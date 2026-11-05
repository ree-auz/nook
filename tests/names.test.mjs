import assert from "node:assert/strict";
import test from "node:test";
import { nameProblem, suggestRepoName } from "../src/names.mjs";

test("valid workspace names", () => {
  for (const name of ["smoke", "ree-12-fix-login", "v1.2", "a", "0-start"]) assert.equal(nameProblem(name), null, name);
});

test("invalid workspace names", () => {
  for (const name of ["", "Fix", "feat/login", "has space", "-dash", ".dot", "end.", "x.lock", "a..b", "ls", "rm", "init", "doctor", "clean", "名字", "a_b"])
    assert.notEqual(nameProblem(name), null, name);
  assert.match(nameProblem("feat/login"), /"\/"/);
  assert.match(nameProblem("rm"), /command/);
});

test("repository name suggestions", () => {
  assert.equal(suggestRepoName("My_Project"), "my-project");
  assert.equal(suggestRepoName("demo.app"), "demo.app");
  assert.equal(suggestRepoName("___"), "repo");
  assert.equal(suggestRepoName("ls"), "repo");
});
