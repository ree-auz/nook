import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isInstallCommand, planJob } from "../src/ci.mjs";
import { createHook } from "../src/generate-hooks.mjs";

test("only dependency installs are copied from CI", () => {
  for (const command of ["pnpm install --frozen-lockfile", "npm ci", "uv sync --locked --project apps/collector", "pip install -r requirements.txt", "pnpm exec playwright install chromium"])
    assert.ok(isInstallCommand(command), command);
  for (const command of ["node scripts/ci-docker.mjs start", "docker compose up -d", "pnpm db:migrate", "npm install && psql -c 'drop table x'", "pip install x; rm -rf /", "make setup", "npm ci\nnpm run seed"])
    assert.ok(!isInstallCommand(command), command);
});

test("CI values that could reach a real database on this machine are left out", () => {
  const plan = planJob("ci.yml", "test", {
    services: { db: { image: "postgres:16", ports: ["5432:5432"] } },
    env: {
      DATABASE_URL: "postgres://u:p@localhost:5432/app",
      CACHE_URL: "redis://localhost:6379",
      REPORTS_DB: "postgres://u:p@db.internal/reports",
      TZ: "UTC",
    },
    steps: [{ run: "docker compose up -d" }, { run: "npm ci" }],
  });
  assert.deepEqual(Object.keys(plan.env), ["DATABASE_URL", "TZ"]);
  assert.deepEqual(plan.create.map((step) => step.run), ["npm ci"]);
  const why = plan.untranslated.map((item) => item.why).join("\n");
  assert.match(why, /CACHE_URL points at local port 6379, which is not a CI service/);
  assert.match(why, /REPORTS_DB is a service address outside the workspace/);
  assert.match(plan.untranslated.find((item) => item.step === "docker compose up -d").why, /not a dependency install/);
});

test("a generated hook refuses to run outside nk", () => {
  const plan = planJob("ci.yml", "test", { steps: [{ run: "npm ci" }] });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", createHook(plan)], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run by nk only/);
});
