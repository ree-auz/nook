# Setting up hooks with an agent

Nook does not guess how a repository is set up. Projects differ too much: one
needs `uv sync`, another restores a database snapshot. An agent reads the
repository and writes the hooks; nk gives it what it knows and checks the
result.

1. `nk hooks write <agent>` (in the main checkout) creates the workspace
   `nook-hooks` and starts the agent with a prompt that lists the files that
   show how the project is set up, the shared files with their empty keys, and
   the hooks already there. `nk hooks write` without an agent prints the prompt, for an agent
   nk does not start.
2. The agent writes `create` and `remove` as a pair, and `open` if needed.
3. The agent runs `nk hooks test` in its workspace until it passes: the
   hooks run in a temporary workspace (create, open twice, remove), and the
   check fails on any leftover Docker container, volume, network or built
   image.
4. You review the commit and merge it. Hooks that passed are recorded; when
   one changes later, `nk doctor` and `nk rm` ask for a new check.

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
- `remove` undoes everything `create` did outside the folder: containers,
  volumes, networks, built images, databases created in a shared server.
  `nk rm` also stops programs in the folder and, as a safety net, removes
  Compose projects started in it; do not rely on that.
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
// .nook/remove.mjs: everything the project created, volumes and built images too
const project = process.env.NOOK_WORKSPACE.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
run("docker", "compose", "--project-name", project, "down", "--volumes", "--rmi", "local", "--remove-orphans");
```

A fuller setup with a database per workspace also refuses the production
project name in every hook, so a mistyped name can never start or stop the
main checkout's services.
