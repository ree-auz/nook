import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isInstallCommand, planFromCi, planJob } from "../src/ci.mjs";
import { createHook } from "../src/generate-hooks.mjs";
import { planCompose } from "../src/compose-plan.mjs";
import { makeRepo, tempDir, write } from "./helpers.mjs";

test("only dependency installs are copied from CI", () => {
  for (const command of ["pnpm install --frozen-lockfile", "npm ci", "uv sync --locked --project apps/collector", "pip install -r requirements.txt", "pnpm exec playwright install chromium", "yarn --immutable", "bun ci"])
    assert.ok(isInstallCommand(command), command);
  for (const command of ["node scripts/ci-docker.mjs start", "docker compose up -d", "pnpm db:migrate", "npm install && psql -c 'drop table x'", "pip install x; rm -rf /", "make setup", "npm ci\nnpm run seed", "yarn sequelize db:migrate", "yarn build"])
    assert.ok(!isInstallCommand(command), command);
});

test("a step that runs a project package installs dependencies first when CI hides the install in an action (vuetify)", () => {
  let plan = planJob("ci.yml", "test", { steps: [{ uses: "vuetifyjs/setup-action@v1" }, { run: "pnpm exec playwright install chromium" }] });
  assert.deepEqual(plan.create.map((step) => step.run), ["pnpm install --frozen-lockfile", "pnpm exec playwright install chromium"]);
  plan = planJob("ci.yml", "test", { steps: [{ uses: "acme/setup@v1" }, { run: "npm ci" }, { run: "npx playwright install" }] });
  assert.deepEqual(plan.create.map((step) => step.run), ["npm ci", "npx playwright install"], "CI's own install is enough");
});

test("run: steps use the job's or workflow's default working directory (firezone)", (t) => {
  const dir = makeRepo(tempDir(t), {
    ".github/workflows/ci.yml": `on: pull_request
defaults: { run: { working-directory: ./rust/gui-client } }
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{ run: pnpm install }, { run: uv sync, working-directory: py }, { run: pnpm test }]
`,
  });
  const { best } = planFromCi(dir);
  assert.deepEqual(best.create.map((step) => [step.run, step.cwd]), [["pnpm install", "./rust/gui-client"], ["uv sync", "py"]]);
});

test("CI values that could reach a real database on this machine are left out", () => {
  const plan = planJob("ci.yml", "test", {
    services: { db: { image: "postgres:16", ports: ["5432:5432"] } },
    env: {
      DATABASE_URL: "postgres://u:p@localhost:5432/app",
      CACHE_URL: "redis://localhost:6379",
      URL: "http://localhost:3000",
      REPORTS_DB: "postgres://u:p@db.internal/reports",
      TZ: "UTC",
    },
    steps: [{ run: "docker compose up -d" }, { run: "npm ci" }],
  });
  assert.deepEqual(Object.keys(plan.env), ["DATABASE_URL", "TZ"]);
  assert.deepEqual(plan.create.map((step) => step.run), ["npm ci"]);
  const why = plan.untranslated.map((item) => item.why).join("\n");
  assert.match(why, /CACHE_URL points at local port 6379, which is not a service nk starts; on this machine it may be a real database/);
  assert.match(why, /URL points at local port 3000, which is not a service nk starts; likely the app's own address/);
  assert.match(why, /REPORTS_DB is a service address outside the workspace/);
  assert.match(plan.untranslated.find((item) => item.step === "docker compose up -d").why, /not a dependency install/);
});

test("service options keep quoted values whole, as docker run reads them", () => {
  const plan = planJob("ci.yml", "test", {
    services: { mysql: { image: "mysql:8", ports: ["3306:3306"], options: `--health-cmd="mysqladmin ping" --health-interval 10s\n  -e TZ='UTC'` } },
    steps: [{ run: "npm ci" }],
  });
  assert.deepEqual(plan.services[0].options, ["--health-cmd=mysqladmin ping", "--health-interval", "10s", "-e", "TZ=UTC"]);
});

test("service options read backslash escapes as the shell does (gorm's sqlserver health check)", () => {
  const options = String.raw`--health-cmd="sqlcmd -P \${PASS} -Q \"SELECT 1\" || exit 1" --health-retries 10 -e A=b\ c`;
  const plan = planJob("ci.yml", "test", { services: { db: { image: "mssql", options } }, steps: [{ run: "go mod download" }] });
  assert.deepEqual(plan.services[0].options, ['--health-cmd=sqlcmd -P ${PASS} -Q "SELECT 1" || exit 1', "--health-retries", "10", "-e", "A=b c"]);
});

test("a generated hook refuses to run outside nk", () => {
  const plan = planJob("ci.yml", "test", { steps: [{ run: "npm ci" }] });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", createHook(plan)], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run by nk only/);
});

test("a generated hook takes only .env.<name> files for env files", () => {
  const text = createHook(planJob("ci.yml", "test", { steps: [{ run: "npm ci" }] }));
  // The hook's text is a template in generate-hooks.mjs, where a backslash has to be written twice to reach the file.
  const source = /readdirSync\(ws\)\.filter\(\(file\) => \/(.+?)\/\.test\(file\)/.exec(text)?.[1];
  assert.equal(source, String.raw`^\.env\..+`);
  const envFile = new RegExp(source);
  for (const name of [".env.development", ".env.test", ".env.local"]) assert.equal(envFile.test(name), true, name);
  for (const name of [".env", ".envrc", "Xenv.ab", "my.env.txt", "aenvbcd"]) assert.equal(envFile.test(name), false, name);
});

test("a setup step whose program is missing says so plainly; corepack is checked first", (t) => {
  const ws = tempDir(t);
  const env = { PATH: process.env.PATH, NOOK_PATH: ws, NOOK_WORKSPACE: "w", NOOK_PORT: "40000", NOOK_REPO: ws };
  const run = (plan) => spawnSync(process.execPath, ["--input-type=module", "-e", createHook(plan)], { cwd: ws, encoding: "utf8", env });

  const base = planJob("ci.yml", "test", { steps: [] });
  let result = run({ ...base, create: [{ name: "Install", run: "nook-no-such-program install" }] });
  assert.equal(result.status, 127, result.stderr);
  assert.match(result.stderr, /nook-no-such-program is not installed or not on PATH\. Needed by: nook-no-such-program install/);

  const plan = planJob("ci.yml", "test", { steps: [{ run: "corepack enable" }, { run: "yarn install --immutable" }] });
  assert.deepEqual(plan.tools.map((tool) => tool.name), ["corepack"]);
  result = run({ ...plan, tools: [{ name: "nook-no-such-program" }] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nook-no-such-program is not installed/);
});

test("Compose services remember the repository files they mount, such as Sail's init script", (t) => {
  const dir = tempDir(t);
  write(dir, {
    "docker-compose.yml": `services:
  mariadb:
    image: mariadb:11
    volumes: ["sail-mariadb:/var/lib/mysql", "./vendor/laravel/sail/database/mysql/create-testing-database.sh:/docker-entrypoint-initdb.d/10.sh"]
  redis: { image: redis, volumes: [{ type: bind, source: ./redis.conf, target: /etc/redis.conf }, "\${DATA}:/data"] }
volumes: { sail-mariadb: {} }
`,
  });
  assert.deepEqual(planCompose(dir).mounts, { mariadb: ["./vendor/laravel/sail/database/mysql/create-testing-database.sh"], redis: ["./redis.conf"] });
});

test("reads which Compose services a workspace starts and which ports it chooses", (t) => {
  const dir = tempDir(t);
  write(dir, {
    "compose.yaml": `services:
  db: { image: "pgvector/pgvector:pg16", environment: { POSTGRES_PASSWORD: "\${PG_PASSWORD:?needed}" } }
  queue: { image: rabbitmq, ports: ["5672"] }
  web: { build: ., ports: [{ target: 80, published: "\${WEB_PORT:-8080}" }] }
  admin: { image: adminer, profiles: [tools], ports: ["127.0.0.1:\${ADMIN_PORT}:8080"] }
  mail: { image: mailpit, container_name: app-mail, ports: ["1025:1025"] }
`,
  });
  const plan = planCompose(dir);
  assert.deepEqual(plan.named, ["mail"], "a fixed container name, which each workspace replaces with its own");
  assert.equal(plan.file, "compose.yaml");
  assert.deepEqual(plan.start, ["db", "queue", "mail"]);
  assert.deepEqual(plan.ports, { WEB_PORT: "8080", ADMIN_PORT: "" });
  assert.deepEqual(plan.remap, { mail: [{ host: "1025", target: "1025" }] }, "a fixed host port moves to the workspace's own");
  assert.deepEqual(plan.required, ["PG_PASSWORD"]);
  assert.deepEqual(plan.notStarted.map((s) => s.name), ["web", "admin"]);
  assert.deepEqual(plan.untranslated, []);
});

test("a service on the host's network moves to the workspace's own network and ports (forem)", (t) => {
  const dir = tempDir(t);
  write(dir, {
    "docker-compose.yml": `services:
  postgres: { image: "pgvector/pgvector:pg13", network_mode: host, ports: ["5432"] }
  redis: { image: "redis:7", network_mode: host }
`,
  });
  const plan = planCompose(dir);
  assert.deepEqual(plan.start, ["postgres"]);
  assert.deepEqual(plan.ownNetwork, ["postgres"]);
  assert.deepEqual(plan.remap, { postgres: [{ host: "5432", target: "5432" }] }, "it listened on the host's 5432, the main checkout's");
  assert.match(plan.notStarted.find((s) => s.name === "redis").why, /host's network and names no ports/);
});

test("a base Compose file that cannot run alone is read with its development file (coolify)", (t) => {
  const dir = tempDir(t);
  write(dir, {
    "docker-compose.yml": "services:\n  app: { container_name: app, depends_on: [db] }\n  db: { image: 'postgres:15', networks: [net] }\nnetworks:\n  net: { name: coolify }\n  shared: { name: proxy, external: true }\nvolumes:\n  data: { name: app-data }\n",
    "docker-compose.dev.yml": "services:\n  app: { build: . }\n  db: { ports: ['${FORWARD_DB_PORT:-5432}:5432'] }\n",
  });
  const plan = planCompose(dir);
  assert.deepEqual(plan.files, ["docker-compose.yml", "docker-compose.dev.yml"]);
  assert.deepEqual(plan.start, ["db"]);
  assert.deepEqual(plan.fixed, { networks: ["net"], volumes: ["data"] }, "fixed names each workspace replaces; an external network is shared on purpose");
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

test("picks the job that sets up and tests the project, reading local actions", (t) => {
  const dir = makeRepo(tempDir(t), {
    ".github/actions/setup/action.yml": `runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@v4
    - run: pnpm install --frozen-lockfile \${{ inputs.flags }}
      shell: bash
inputs:
  flags: { default: "--prefer-offline" }
`,
    ".github/workflows/release.yml": `on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    services: { db: { image: postgres, ports: ["5432:5432"] } }
    steps: [{ uses: actions/setup-node@v4 }, { run: npm ci }, { run: npm publish }]
`,
    ".github/workflows/ci.yml": `on: pull_request
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [{ uses: ./.github/actions/setup }, { run: pnpm lint }]
  test:
    runs-on: ubuntu-latest
    services:
      mysql: { image: "mysql:8", ports: ["3306:3306"] }
      mariadb: { image: mariadb, ports: ["3307:3306"] }
    steps:
      - uses: ./.github/actions/setup
      - id: cache
        uses: actions/cache@v4
      - run: pnpm exec playwright install chromium
        if: steps.cache.outputs.cache-hit != 'true'
      - run: pnpm install --filter docs
        if: runner.os == 'Linux'
      - run: pnpm test
`,
  });
  const { best, others } = planFromCi(dir);
  assert.equal(`${best.source} › ${best.job}`, ".github/workflows/ci.yml › test", "not lint, not the release job");
  assert.ok(others.includes(".github/workflows/release.yml › publish"));
  assert.deepEqual(best.tools.map((tool) => tool.name), ["pnpm"]);
  assert.deepEqual(best.create.map((step) => step.run), ["pnpm install --frozen-lockfile --prefer-offline", "pnpm exec playwright install chromium"]);
  assert.ok(best.untranslated.some((entry) => /runner\.os/.test(entry.why)), "an OS-only step is listed, not run");
  assert.deepEqual(best.services.map((service) => service.ports), [[{ host: 3306, container: 3306 }], [{ host: 3307, container: 3306 }]]);
});

test("Compose starts only databases and similar services, within the workspace's ten ports", (t) => {
  const dir = tempDir(t);
  const many = Array.from({ length: 11 }, (_, i) => `  db${i}: { image: "postgres:${i + 10}", ports: ["${5432 + i}:5432"] }`).join("\n");
  write(dir, { "compose.yaml": `services:\n  web: { image: "acme/web:1", ports: ["3000:3000"] }\n${many}\n` });
  const plan = planCompose(dir);
  assert.equal(plan.start.length, 10);
  assert.ok(!plan.start.includes("web"), "an app image is not started");
  assert.deepEqual(plan.notStarted.map((service) => service.name), ["web", "db10"]);
  assert.ok(plan.untranslated.some((entry) => /db10/.test(entry.step)));

  const ci = planCompose(dir, { start: false });
  assert.deepEqual(ci.start, [], "CI has its own services, so Compose starts none");
});
