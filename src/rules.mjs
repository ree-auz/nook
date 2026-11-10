/**
 * The rules `nk hooks write` reads CI and Compose files by, as lists: one
 * entry per tool, command or service, so that a new case is one line, and so
 * that `npm run corpus -- --rules` can show which entries real repositories
 * use.
 *
 * A rule is added when the same case shows in about three repositories, or at
 * once when it keeps a workspace from reaching something outside itself. What
 * no rule covers is listed for a person or agent ("left out"), never guessed.
 * An entry that no repository of the corpus uses is not removed for that
 * alone: the corpus is a sample, and a protective entry costs nothing unused.
 */

/** Rules that matched since counting was turned on: "kind id" → times. Off unless countRuleHits() ran. */
let hits = null;

/** Starts counting which rules match, from zero. Only the corpus report uses it. */
export function countRuleHits() {
  hits = new Map();
  return hits;
}

function hit(kind, id) {
  if (hits) hits.set(`${kind} ${id}`, (hits.get(`${kind} ${id}`) ?? 0) + 1);
}

/**
 * Actions that install a tool. On a developer machine the tool is already
 * there or not, so they become a check ("node 22 is needed") before anything
 * starts. `version` reads the wanted version from the step's with:.
 */
export const TOOL_ACTIONS = [
  { match: /^actions\/setup-node@/, tool: "node", version: (w) => w["node-version"] },
  { match: /^actions\/setup-python@/, tool: "python", version: (w) => w["python-version"] },
  { match: /^actions\/setup-go@/, tool: "go", version: (w) => w["go-version"] },
  { match: /^actions\/setup-java@/, tool: "java", version: (w) => w["java-version"] },
  { match: /^pnpm\/action-setup@/, tool: "pnpm", version: (w) => w.version },
  { match: /^oven-sh\/setup-bun@/, tool: "bun", version: (w) => w["bun-version"] },
  // setup-uv can install Python too, so both are checked.
  { match: /^astral-sh\/setup-uv@/, tool: "uv", version: (w) => w.version, also: (w) => (w["python-version"] ? [{ name: "python", version: String(w["python-version"]) }] : []) },
  { match: /^denoland\/setup-deno@/, tool: "deno", version: (w) => w["deno-version"] },
  { match: /^dtolnay\/rust-toolchain@|^actions-rs\/toolchain@/, tool: "cargo" },
  { match: /^ruby\/setup-ruby@/, tool: "ruby", version: (w) => w["ruby-version"] },
  { match: /^erlef\/setup-beam@/, tool: "elixir", version: (w) => w["elixir-version"] },
  { match: /^shivammathur\/setup-php@/, tool: "php", version: (w) => w["php-version"] },
];

/** The entry of TOOL_ACTIONS for a step's uses:, or undefined. */
export function toolAction(uses) {
  const entry = TOOL_ACTIONS.find((candidate) => candidate.match.test(uses));
  if (entry) hit("tool", entry.tool);
  return entry;
}

/**
 * Commands that install dependencies into the workspace folder and nothing
 * else. CI runs in a throwaway machine, so its other steps may assume nothing
 * is there; on a developer machine the real database may be. Only these are
 * copied into the create hook; any other step (a script, docker, a migration)
 * is listed for review.
 *
 * `start` is how the command begins, as a regular expression. Plain arguments
 * may follow (--frozen-lockfile, -r requirements.txt, a package name), shell
 * syntax may not.
 */
export const INSTALL_COMMANDS = [
  // Bare `yarn` installs. Only flags may follow it, to the end, so that `yarn build` is not taken for one.
  { id: "yarn", start: "yarn( install)?(\\s+--?[\\w-]+(=\\S+)?)*$" },
  { id: "npm", start: "npm (ci|install|i)" },
  { id: "pnpm", start: "pnpm (install|i|fetch)" },
  { id: "bun", start: "bun (install|ci)" },
  { id: "corepack", start: "corepack enable" },
  { id: "uv sync", start: "uv sync" },
  { id: "uv pip", start: "uv pip install" },
  { id: "pip", start: "pip install" },
  { id: "python -m pip", start: "python3? -m pip install" },
  { id: "poetry", start: "poetry install" },
  { id: "pipenv", start: "pipenv (install|sync)" },
  { id: "bundle", start: "bundle install" },
  { id: "go mod", start: "go mod download" },
  { id: "cargo", start: "cargo fetch" },
  { id: "composer", start: "composer install" },
  { id: "deno", start: "deno (cache|install)" },
  // Browsers for end-to-end tests: large, but they go into the user's cache folder, not a service.
  { id: "playwright", start: "(npx|pnpm exec|yarn) playwright install" },
];

const ARGUMENTS = "(\\s+[\\w@./:=,+-]+)*$";
const INSTALL = INSTALL_COMMANDS.map((entry) => ({ id: entry.id, test: new RegExp(`^(${entry.start})${ARGUMENTS}`) }));
/** One of these anywhere makes a command more than an install: it chains, pipes, substitutes or redirects. */
const SHELL_SYNTAX = /[;|&`$<>()\\]|\n/;

export function isInstallCommand(command) {
  const text = String(command).trim();
  if (SHELL_SYNTAX.test(text)) return false;
  const entry = INSTALL.find((candidate) => candidate.test.test(text));
  if (entry) hit("install", entry.id);
  return Boolean(entry);
}

/**
 * Images a project uses as they are, beside its own code: databases, caches,
 * queues, search, object storage, mail catchers, cloud emulators. nk starts
 * these Compose services for a workspace. An image the project publishes
 * itself (its app) is not one of them, and is not started.
 *
 * Each entry is the name as it appears in an image (a regular expression),
 * matched as a whole word of the image: postgres, bitnami/mysql:8,
 * ghcr.io/x/postgres-ci, but not postgrest or redisinsight.
 */
export const BACKING_SERVICES = [
  // SQL and analytics databases
  "postgres",
  "postgis",
  "pgvector",
  "timescale(db)?",
  "mysql",
  "mariadb",
  "percona",
  "cockroach(db)?",
  "mssql(-server)?",
  "azure-sql-edge",
  "clickhouse(-server)?",
  // Document, key-value, graph and cache
  "mongo(db)?",
  "redis",
  "valkey",
  "valkey-bundle",
  "keydb",
  "dragonfly(db)?",
  "memcached",
  "cassandra",
  "scylla",
  "neo4j",
  "couchdb",
  "surrealdb",
  "etcd",
  // Queues and streams
  "rabbitmq",
  "kafka",
  "redpanda",
  "zookeeper",
  "nats",
  // Search and vector databases
  "elasticsearch",
  "opensearch",
  "meilisearch",
  "typesense",
  "qdrant",
  "weaviate",
  "milvus",
  "chroma",
  // Time series
  "influxdb",
  "questdb",
  // Object storage
  "minio",
  "garage",
  "seaweedfs",
  // Cloud emulators
  "localstack",
  "dynamodb-local",
  "azurite",
  "pubsub-emulator",
  "firebase-emulator",
  "spanner-emulator",
  // Mail catchers
  "mailpit",
  "mailhog",
  "maildev",
  "smtp4dev",
];

const BACKING = new RegExp(`(^|[/:_-])(${BACKING_SERVICES.join("|")})($|[/:._@-]|\\d)`, "i");
const BACKING_EACH = BACKING_SERVICES.map((name) => ({ name, test: new RegExp(`(^|[/:_-])(${name})($|[/:._@-]|\\d)`, "i") }));

/** Whether a Compose image is a database or similar service nk may start. */
export function isBackingService(image) {
  const yes = BACKING.test(image);
  if (yes && hits) hit("service", BACKING_EACH.find((entry) => entry.test.test(image))?.name ?? "?");
  return yes;
}
