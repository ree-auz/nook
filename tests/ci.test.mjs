import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isInstallCommand, planJob } from "../src/ci.mjs";
import { createHook } from "../src/generate-hooks.mjs";
import { planCompose } from "../src/compose-plan.mjs";
import { tempDir, write } from "./helpers.mjs";

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

test("reads which Compose services a workspace starts and which ports it chooses", (t) => {
  const dir = tempDir(t);
  write(dir, {
    "compose.yaml": `services:
  db: { image: "pgvector/pgvector:pg16", environment: { POSTGRES_PASSWORD: "\${PG_PASSWORD:?needed}" } }
  queue: { image: rabbitmq, ports: ["5672"] }
  web: { build: ., ports: [{ target: 80, published: "\${WEB_PORT:-8080}" }] }
  admin: { image: adminer, profiles: [tools], ports: ["127.0.0.1:\${ADMIN_PORT}:8080"] }
  mail: { image: mailpit, ports: ["1025:1025"] }
`,
  });
  const plan = planCompose(dir);
  assert.equal(plan.file, "compose.yaml");
  assert.deepEqual(plan.start, ["db", "queue", "mail"]);
  assert.deepEqual(plan.ports, { WEB_PORT: "8080", ADMIN_PORT: "" });
  assert.deepEqual(plan.remap, { mail: [{ host: "1025", target: "1025" }] }, "a fixed host port moves to the workspace's own");
  assert.deepEqual(plan.required, ["PG_PASSWORD"]);
  assert.deepEqual(plan.notStarted.map((s) => s.name), ["web", "admin"]);
  assert.deepEqual(plan.untranslated, []);
});

test("reads the Compose override file the way docker compose does", (t) => {
  const dir = tempDir(t);
  write(dir, {
    "compose.yml": "services:\n  db: { image: postgres }\n  api: { build: . }\n",
    "compose.override.yml": "services:\n  db: { ports: ['127.0.0.1:5432:5432'] }\n  mail: { image: mailpit, ports: [{ target: 1025, published: 1025 }] }\n",
  });
  const plan = planCompose(dir);
  assert.equal(plan.file, "compose.yml + compose.override.yml");
  assert.deepEqual(plan.files, ["compose.yml", "compose.override.yml"]);
  assert.deepEqual(plan.start, ["db", "mail"]);
  assert.deepEqual(plan.remap, { db: [{ host: "5432", target: "5432" }], mail: [{ host: "1025", target: "1025" }] });
});
