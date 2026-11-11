# Examples from real repositories

Six kinds of project, each shown with a real open-source repository at a
fixed commit: what `nk init` and `nk hooks write` make of it, what they leave
for you or an agent, and how to tell that a workspace really is on its own.

| Example | Repository | What it shows |
|---|---|---|
| [Front end only](01-frontend.md) | vuetifyjs/vuetify | installs and nothing else; a setup action nk cannot read |
| [Node, PostgreSQL and Compose](02-node-postgres-compose.md) | outline/outline | a shared `.env`, fixed host ports moved, one Compose project per workspace |
| [Python with uv](03-python-uv.md) | HumanSignal/label-studio | tool checks for uv and Python; CI services chosen over the Compose file |
| [CI services, no Compose file](04-ci-services.md) | maybe-finance/maybe | one container per service and workspace, removed with it |
| [Go and Rust](05-go-rust.md) | temporalio/temporal, SeaQL/sea-orm | a tool check is the whole hook; what CI caches is not copied |
| [A large mixed repository](06-mixed-compose.md) | makeplane/plane, fastapi/full-stack-fastapi-template | fixed container names, a value Compose requires, services nk does not start |

## How these pages stay true

Every repository here is in nk's corpus (`tests/corpus/repos.json`), pinned
to the commit each page names. `npm run corpus` runs `nk hooks write` on its
CI, Compose and env template files and compares the result with
`tests/corpus/expected/<name>.txt`. The block under "What nk hooks write
makes of it" on each page is taken from that file line for line, and
`tests/examples.test.mjs` fails when a line is no longer there. So when the
generator changes what it makes of one of these repositories, the page has to
change with it.

The repositories marked `full` in the corpus also go through the whole cycle
for real, every week, on a GitHub runner with Docker (the "Real repositories"
workflow): init, hooks write, hooks test, `nk -b`, checks, `nk rm`.

These pages show the repositories as they were at that commit. Yours will
differ; the point is what to look for.

## The same steps every time

```
nk init                     once per repository; fill in ~/nook/shared/<repo>/.env
nk hooks write              read the report: what it starts, moves, adds and leaves out
nk hooks test               create, open twice, remove, in a temporary workspace
nk -b try-it                a real workspace; prints its folder and its ten ports
nk doctor --workspace try-it
nk rm try-it
```

A workspace is on its own when all of these hold:

- `nk hooks test` passes. It fails when remove leaves a container, volume,
  network or built image behind, and when the hooks change files git would
  commit.
- In the workspace, the addresses in `.env` name the workspace's ports
  (20000 and up), not 5432 or 6379. Look at the keys only, or at the port
  numbers: `.env` holds secrets.
- `docker ps` shows the workspace's containers under its own name,
  `nook-<repo>-<workspace>`, bound to `127.0.0.1`, and the main checkout's
  containers untouched.
- After `nk rm`, `docker ps -a`, `docker volume ls` and `docker network ls`
  show nothing with that name, and `git worktree list` no longer has the
  folder.

## When something fails

| What you see | What it means | What to do |
|---|---|---|
| `<tool> is not installed (CI uses <version>)` | create checks the tools CI installs before anything else | install the tool. The workspace is kept and create does not run a second time, so remove it and make it again: `nk rm <name>`, then `nk -b <name>` |
| `<tool>: CI uses X, this machine has Y` | a warning, the hook goes on | usually fine; install X if the project needs it |
| create stops and names a variable | the Compose file requires it (`${NAME:?...}`) and `.env` does not have it | set it once in `~/nook/shared/<repo>/.env`, which every new workspace copies; then `nk rm <name>` and `nk -b <name>` |
| create fails in a setup step | the step's own error is the last thing printed; the full output is in `~/nook/logs/` | fix the cause, then `nk rm <name>` and `nk -b <name>`; `nk <name>` runs only the open hook |
| `nk -b` stops and says to run `nk hooks test` first | the hooks, the CI files or the Compose file changed since the test last passed | `nk hooks write` for a CI or Compose change, then `nk hooks test` |
| the app connects to the wrong database | a value points at a port nk did not move, often in a file nk does not copy | see "What is left for you" on the page of your kind of project |
| `nk rm` says remove failed | nothing was deleted | read the error, fix it, run `nk rm` again; `nk doctor --workspace <name>` shows what is still there |

For hooks written by hand, and the rules an agent has to follow, see
[../setup-hooks.md](../setup-hooks.md).
