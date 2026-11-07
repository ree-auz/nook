#!/usr/bin/env node
/**
 * One table from the full runs' results (scripts/real-run.mjs --out), in
 * Markdown for the GitHub Actions run summary.
 *
 *   node scripts/real-summary.mjs <results-folder> >> "$GITHUB_STEP_SUMMARY"
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "results";
const results = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")))
  .sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));
const passed = results.filter((r) => r.ok).length;
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

console.log(`## nk on real repositories: ${passed} of ${results.length} passed\n`);
const fresh = results.filter((r) => r.new);
if (fresh.length)
  console.log(`New this run (not in tests/corpus/repos.json yet; add the failing ones once fixed):\n\n\`\`\`json\n${fresh.map(({ name, repo, commit }) => JSON.stringify({ name, repo, commit, full: true })).join(",\n")}\n\`\`\`\n`);
console.log("| Repository | Result | Minutes | Last lines of the failed step |");
console.log("|---|---|---|---|");
for (const r of results) {
  const failed = r.steps.find((s) => !s.ok);
  const minutes = (r.steps.reduce((sum, s) => sum + s.seconds, 0) / 60).toFixed(1);
  const lines = failed ? `<details><summary>${cell(failed.step)}</summary><pre>${cell(failed.output.split(/\r?\n/).slice(-15).join("\n"))}</pre></details>` : "";
  console.log(`| [${r.name}](https://github.com/${r.repo})${r.new ? " (new)" : ""} | ${r.ok ? "passed" : `failed at ${cell(r.failedAt)}`} | ${minutes} | ${lines} |`);
}
