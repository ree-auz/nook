import assert from "node:assert/strict";
import test from "node:test";
import { nameProblem, normalizeName, suggestRepoName, toName } from "../src/names.mjs";

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

test("normalizes branch names from anywhere", () => {
  assert.equal(normalizeName("ree-267-nook-第-1-步：建-nook-仓库和核心命令"), "ree-267-nook-1-nook");
  assert.equal(normalizeName("feat/Login_Page"), "feat-login-page");
  assert.equal(normalizeName("  Fix the  BUG! "), "fix-the-bug");
  assert.equal(normalizeName("-v1..2.lock"), "v1.2");
  assert.equal(normalizeName("修复登录"), "");
  for (const input of ["ree-12-修复", "Feat/X", "a b c"]) assert.equal(nameProblem(normalizeName(input)), null, input);
  assert.throws(() => toName("修复登录"), /empty/);
  assert.throws(() => toName("RM"), /command/);
});
