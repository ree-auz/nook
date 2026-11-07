import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { copyShared, includePatterns, knownSecretFiles, sharedCandidates, templateFiles } from "../src/shared.mjs";
import { makeRepo, tempDir, write } from "./helpers.mjs";

test("defaults to ignored .env* files", (t) => {
  const repo = makeRepo(join(tempDir(t), "demo"), { ".gitignore": ".env\n.env.local\nnode_modules/\n", ".env.example": "KEY=\n" });
  write(repo, { ".env": "KEY=fake\n", ".env.local": "X=1\n", ".envrc.untracked": "", "node_modules/a/.env": "Y=1\n" });
  assert.deepEqual(includePatterns(repo), { patterns: [".env*"], source: "default" });
  const files = sharedCandidates(repo, [".env*"]);
  assert.ok(files.includes(".env"));
  assert.ok(files.includes(".env.local"));
  assert.ok(!files.includes(".env.example"), "tracked template is not a shared file");
  assert.ok(!files.includes(".envrc.untracked"), "untracked but not ignored files are skipped");
  assert.deepEqual(templateFiles(repo), [{ from: ".env.example", to: ".env" }]);
});

test(".worktreeinclude replaces the default", (t) => {
  const repo = makeRepo(join(tempDir(t), "demo"), {
    ".gitignore": ".env\nsecrets/\n",
    ".worktreeinclude": "# shared\nsecrets/*.json\n",
  });
  write(repo, { ".env": "KEY=fake\n", "secrets/app.json": "{}\n", "secrets/notes.txt": "x\n" });
  const { patterns, source } = includePatterns(repo);
  assert.equal(source, ".worktreeinclude");
  assert.deepEqual(sharedCandidates(repo, patterns), ["secrets/app.json"]);
});

test("finds known secret files only when ignored", (t) => {
  const repo = makeRepo(join(tempDir(t), "demo"), { ".gitignore": ".dev.vars\n", ".envrc": "tracked\n" });
  write(repo, { ".dev.vars": "TOKEN=fake\n" });
  assert.deepEqual(knownSecretFiles(repo, []), [".dev.vars"]);
  assert.deepEqual(knownSecretFiles(repo, [".dev.vars"]), []);
});

test("copies only files git ignores in the workspace", (t) => {
  const root = tempDir(t);
  const repo = makeRepo(join(root, "demo"), { ".gitignore": ".env\nlocal/\n", "config.json": "{}\n" });
  const shared = join(root, "shared");
  write(shared, { ".env": "KEY=fake\n", "local/key.txt": "k\n", "config.json": "{\"x\":1}\n" });
  const result = copyShared(shared, repo);
  assert.deepEqual(result.copied, [".env", "local/key.txt"]);
  assert.deepEqual(result.skipped, ["config.json"]);
  assert.equal(readFileSync(join(repo, ".env"), "utf8"), "KEY=fake\n");
  assert.equal(readFileSync(join(repo, "config.json"), "utf8"), "{}\n");
  assert.ok(existsSync(join(repo, "local/key.txt")));
});

test("finds templates for any ignored file, in any folder", (t) => {
  const repo = makeRepo(join(tempDir(t), "demo"), {
    ".gitignore": ".env\n.dev.vars\nconfig/database.yml\nphpunit.xml\n",
    ".env.sample": "KEY=\n",
    "apps/api/.dev.vars.example": "TOKEN=\n",
    "config/database.yml.dist": "host: localhost\n",
    "docs/readme.template": "not a secret\n",
    "server/vendor/guzzle/phpunit.xml.dist": "<phpunit/>\n",
  });
  assert.deepEqual(templateFiles(repo), [
    { from: ".env.sample", to: ".env" },
    { from: "apps/api/.dev.vars.example", to: "apps/api/.dev.vars" },
    { from: "config/database.yml.dist", to: "config/database.yml" },
  ], "not a library's template in a committed vendor folder");
});
