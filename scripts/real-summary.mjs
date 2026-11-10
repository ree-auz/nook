#!/usr/bin/env node
/**
 * One report from the full runs' results (scripts/real-run.mjs --out), in
 * Markdown for the GitHub Actions run summary. Failures are grouped by whose
 * they are (scripts/real-cause.mjs), nk's own first.
 *
 *   node scripts/real-summary.mjs <results-folder> >> "$GITHUB_STEP_SUMMARY"
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GROUPS = [
  ["nk", "nk broke a promise or crashed: fix these first"],
  ["unknown", "Not told apart yet: read the step's output"],
  ["repository", "The repository's own setup failed on this runner"],
  ["runner", "The checkout failed before nk ran"],
];
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

export function summary(results) {
  const sorted = [...results].sort((a, b) => a.name.localeCompare(b.name));
  const failed = sorted.filter((r) => !r.ok);
  // Results written before causes were recorded count as not told apart.
  const of = (cause) => failed.filter((r) => (r.cause ?? "unknown") === cause);
  const counts = GROUPS.map(([cause]) => [cause, of(cause).length]).filter(([, n]) => n);
  const lines = [`## nk on real repositories: ${sorted.length - failed.length} of ${sorted.length} passed`, ""];
  if (counts.length) lines.push(`Failed: ${counts.map(([cause, n]) => `${n} ${cause}`).join(", ")}`, "");
  const fresh = sorted.filter((r) => r.new);
  if (fresh.length)
    lines.push("New this run (not in tests/corpus/repos.json yet; add the failing ones once fixed):", "", "```json", fresh.map(({ name, repo, commit }) => JSON.stringify({ name, repo, commit, full: true })).join(",\n"), "```", "");
  for (const [cause, title] of GROUPS) {
    const group = of(cause);
    if (!group.length) continue;
    lines.push(`### ${title}`, "", "| Repository | Failed at | Why | Minutes | Last lines |", "|---|---|---|---|---|");
    for (const r of group) {
      const step = r.steps.find((s) => !s.ok);
      const last = step ? `<details><summary>${cell(step.step)}</summary><pre>${cell(step.output.split(/\r?\n/).slice(-15).join("\n"))}</pre></details>` : "";
      lines.push(`| ${link(r)} | ${cell(r.failedAt)} | ${cell(r.why ?? "")} | ${minutes(r)} | ${last} |`);
    }
    lines.push("");
  }
  const passed = sorted.filter((r) => r.ok);
  if (passed.length) lines.push("### Passed", "", "| Repository | Minutes |", "|---|---|", ...passed.map((r) => `| ${link(r)} | ${minutes(r)} |`), "");
  return lines.join("\n");
}

const link = (r) => `[${r.name}](https://github.com/${r.repo})${r.new ? " (new)" : ""}`;
const minutes = (r) => (r.steps.reduce((sum, s) => sum + s.seconds, 0) / 60).toFixed(1);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? "results";
  const results = (existsSync(dir) ? readdirSync(dir) : []).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")));
  console.log(summary(results));
}
