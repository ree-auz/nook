# Setting up hooks with an agent

Nook does not guess how a repository is set up. Projects differ too much: one
needs `uv sync`, another restores a database snapshot. Like Conductor's
"Configure your project", Nook gives you a prompt instead. Paste it into your
agent in the main checkout. The agent reads the repository and writes
`.nook/` hooks for you to review and commit.

## The prompt

```text
Set up Nook hooks for this repository. Nook (nk) creates one git worktree per
task and runs scripts from .nook/ in it. Read https://github.com/ree-auz/nook/blob/main/docs/setup-hooks.md
for the rules and examples, then:

1. Inspect how this project is set up: lockfiles, package.json scripts,
   pyproject.toml, compose files, README and contributing docs, Makefile or
   justfile, existing setup scripts.
2. Write .nook/create.mjs (install dependencies, start per-workspace
   services), and only if needed .nook/open.mjs (start stopped services again)
   and .nook/remove.mjs (delete what create started).
3. Tell me which commands each hook runs and anything I must fill in once,
   such as values in ~/nook/shared/<repo>/.env. Do not commit; I will review.
```

## Rules for the hooks

- One `.mjs` file per moment works on Windows, macOS and Linux. Use
  `node:child_process` and stop at the first failing command with a non-zero
  exit code, so nk does not start an agent on a broken workspace.
- Hooks run inside the workspace with these variables: `NOOK_WORKSPACE`
  (name), `NOOK_PATH` (folder), `NOOK_REPO` (main checkout), `NOOK_SHARED`
  (shared folder) and `NOOK_PORT` (first of ten ports for this workspace).
- `create` runs once, after shared files such as `.env` are copied. `open`
  runs every time the workspace is opened, so it must be safe to run again.
  `remove` runs before the folder is deleted; when it fails nothing is deleted.
- Never touch the main checkout or its services: do not read or copy its
  `.env`, and do not stop or remove its containers.
- Servers and containers use ports from `NOOK_PORT` to `NOOK_PORT + 9`.
- Do not print secrets. Do not run `docker compose config`: it prints every
  value from `.env`.

## Examples

A small helper the examples share:

```js
import { spawnSync } from "node:child_process";

function run(command, ...args) {
  // shell: true lets Windows find pnpm.cmd and npm.cmd.
  const result = spawnSync([command, ...args].join(" "), { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

### Node (pnpm, npm, yarn, bun)

Install with the package manager whose lockfile the repository has:
`pnpm-lock.yaml` → `pnpm install`, `package-lock.json` → `npm ci`,
`yarn.lock` → `yarn install`, `bun.lock` → `bun install`.

```js
// .nook/create.mjs
run("pnpm", "install");
```

### Python (uv)

A virtual environment holds absolute paths and cannot be copied from the main
checkout; create it again:

```js
// .nook/create.mjs
run("uv", "sync");
```

### Docker Compose

Give each workspace its own Compose project, so its containers, volumes and
networks never mix with the main checkout's. Compose's own rule for a project
name is lowercase letters, digits, `_` and `-`.

```js
// .nook/create.mjs
const project = process.env.NOOK_WORKSPACE.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
const port = Number(process.env.NOOK_PORT);
process.env.DB_PORT = String(port); // whatever the compose file reads
run("docker", "compose", "--project-name", project, "up", "-d", "--wait");
```

Write the project name and ports into the workspace `.env` as well
(`COMPOSE_PROJECT_NAME=...`), so a plain `docker compose` typed in the
workspace later finds the same project.

```js
// .nook/open.mjs: start the containers again after a restart
run("docker", "compose", "start");
```

```js
// .nook/remove.mjs: delete everything the project created, found by its label
import { spawnSync } from "node:child_process";
const project = process.env.NOOK_WORKSPACE.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
const result = spawnSync("docker", ["compose", "--project-name", project, "down", "--volumes", "--remove-orphans"], { stdio: "inherit" });
process.exit(result.status ?? 1);
```

A fuller setup with a database per workspace also refuses the production
project name in every hook, and removes containers, volumes and networks by
the label `com.docker.compose.project=<project>`, which still works when the
workspace's `.env` or compose file is gone.
