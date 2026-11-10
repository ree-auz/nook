import assert from "node:assert/strict";
import test from "node:test";
import { BACKING_SERVICES, INSTALL_COMMANDS, TOOL_ACTIONS, countRuleHits, isBackingService, isInstallCommand, toolAction } from "../src/rules.mjs";

test("every rule has a name of its own", () => {
  for (const names of [TOOL_ACTIONS.map((rule) => rule.tool), INSTALL_COMMANDS.map((rule) => rule.id), BACKING_SERVICES])
    assert.deepEqual(
      names.filter((name, i) => names.indexOf(name) !== i),
      [],
    );
});

test("every install rule takes its plain form with arguments, and never shell syntax", () => {
  const plain = {
    yarn: "yarn install --frozen-lockfile",
    npm: "npm ci",
    pnpm: "pnpm install --frozen-lockfile",
    bun: "bun install",
    corepack: "corepack enable",
    "uv sync": "uv sync --all-extras",
    "uv pip": "uv pip install -r requirements.txt",
    pip: "pip install -r requirements.txt",
    "python -m pip": "python -m pip install -e .",
    poetry: "poetry install",
    pipenv: "pipenv sync",
    bundle: "bundle install",
    "go mod": "go mod download",
    cargo: "cargo fetch",
    composer: "composer install",
    deno: "deno install",
    playwright: "npx playwright install chromium",
  };
  // A new rule needs its line here.
  assert.deepEqual(Object.keys(plain).sort(), INSTALL_COMMANDS.map((rule) => rule.id).sort());
  for (const [id, command] of Object.entries(plain)) {
    const hits = countRuleHits();
    assert.equal(isInstallCommand(command), true, command);
    assert.deepEqual([...hits], [[`install ${id}`, 1]], command);
    for (const tail of [" && make db", " | sh", " $EXTRA", "; rm -rf x", "\nnpm run build"]) assert.equal(isInstallCommand(command + tail), false, command + tail);
  }
  for (const command of ["yarn build", "yarn install prod", "npm run migrate", "pnpm db:push", "docker compose up -d", "make install", "bundle exec rake db:setup", "pip", "go build ./..."])
    assert.equal(isInstallCommand(command), false, command);
});

test("a tool action is found by its uses:, with the version it asks for", () => {
  const hits = countRuleHits();
  const node = toolAction("actions/setup-node@v4");
  assert.equal(node.tool, "node");
  assert.equal(node.version({ "node-version": 22 }), 22);
  assert.deepEqual(toolAction("astral-sh/setup-uv@v5").also({ "python-version": 3.12 }), [{ name: "python", version: "3.12" }]);
  assert.equal(toolAction("actions-rs/toolchain@v1").tool, "cargo");
  assert.equal(toolAction("actions/checkout@v4"), undefined);
  assert.equal(toolAction("someone/actions/setup-node@v4"), undefined);
  assert.deepEqual([...hits].sort(), [
    ["tool cargo", 1],
    ["tool node", 1],
    ["tool uv", 1],
  ]);
});

test("a backing service is a whole word of the image; the project's own image is not one", () => {
  for (const image of ["postgres", "postgres:16-alpine", "bitnami/postgresql:16", "docker.io/bitnami/postgresql-repmgr", "bitnami/mysql:8", "ghcr.io/x/postgres-ci", "redis@sha256:abc", "mcr.microsoft.com/mssql/server:2022", "cockroachdb/cockroach:v23", "axllent/mailpit", "valkey/valkey-bundle:8"])
    assert.equal(isBackingService(image), true, image);
  for (const image of ["nginx", "ghcr.io/acme/app:latest", "postgrest/postgrest", "redisinsight", "mypostgres", "node:22", "provectuslabs/kafkaui"]) assert.equal(isBackingService(image), false, image);
  const hits = countRuleHits();
  isBackingService("timescale/timescaledb:latest-pg16");
  isBackingService("nginx");
  assert.deepEqual([...hits], [["service timescale(db)?", 1]]);
});
