// docs/examples/ shows what nk hooks write makes of real repositories. Each page quotes
// lines of that repository's corpus result (tests/corpus/expected/<name>.txt), which
// npm run corpus keeps equal to what the generator makes today. So when the generator
// changes its answer for one of them, this test says which page no longer tells the truth.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "docs", "examples");
const repos = JSON.parse(readFileSync(join(root, "tests", "corpus", "repos.json"), "utf8"));
const pages = readdirSync(dir).filter((name) => /^\d\d-.*\.md$/.test(name));
const read = (name) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
// <!-- corpus: name --> and the fenced block right after it.
const QUOTE = /<!-- corpus: ([\w-]+) -->\n```\n([\s\S]*?)\n```/g;

test("the examples quote the corpus line for line, at the commit the corpus pins", () => {
  assert.equal(pages.length, 6);
  for (const page of pages) {
    const text = read(page);
    const quotes = [...text.matchAll(QUOTE)];
    assert.ok(quotes.length, `${page} quotes no corpus result`);
    for (const [, name, block] of quotes) {
      const repo = repos.find((entry) => entry.name === name);
      assert.ok(repo, `${page}: ${name} is not in tests/corpus/repos.json`);
      assert.ok(text.includes(repo.repo), `${page} does not name ${repo.repo}`);
      assert.ok(text.includes(repo.commit), `${page}: ${name} is pinned to ${repo.commit} in the corpus`);
      const expected = readFileSync(join(root, "tests", "corpus", "expected", `${name}.txt`), "utf8").split(/\r?\n/);
      for (const line of block.split("\n")) assert.ok(expected.includes(line), `${page}: tests/corpus/expected/${name}.txt no longer has the line\n${line}`);
      // In the order of the result, so the page reads like the report.
      const places = block.split("\n").map((line) => expected.indexOf(line));
      assert.deepEqual(places, [...places].sort((a, b) => a - b), `${page}: the lines of ${name} are out of order`);
    }
  }
});

test("the index of the examples lists every page, and every link on the pages leads somewhere", () => {
  const index = read("README.md");
  for (const page of pages) assert.ok(index.includes(`(${page})`), `docs/examples/README.md does not link ${page}`);
  for (const page of [...pages, "README.md"]) {
    for (const [, target] of read(page).matchAll(/\]\(([^)#]+\.md)\)/g)) assert.doesNotThrow(() => readFileSync(join(dir, target)), `${page} links ${target}, which is not there`);
  }
});
