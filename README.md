# Nook

`nk` keeps every git worktree you work in under one home folder, `~/nook/`.
It creates a workspace for a branch, copies the ignored files the project needs
(such as `.env`), gives each workspace its own block of ports, runs the
repository's setup hooks, and can start a command-line agent inside it.

> Early work in progress. Commands and config may still change.

## Commands

| Command | What it does |
|---|---|
| `nk init` | Register the current repository (once per repository; safe to rerun) |
| `nk -b <name> [agent] [-p <prompt>] [-y]` | Create a workspace; start the agent if given (`-y` keeps a converted name without asking) |
| `nk <name> [agent] [-p <prompt>]` | Open a workspace; start the agent if given |
| `nk ls [--json]` | List workspaces: uncommitted changes, commits ahead of and behind the default branch, PR and CI |
| `nk rm <name>... [-n] [-y]` | Back up and remove one or more workspaces, asking once (`-n` shows what would happen, `-y` skips the question) |
| `nk clean [-n] [-y]` | Remove every workspace whose work is merged, and folders left from earlier removals |
| `nk hooks` | The repository's `.nook` hooks: allowed, and tested since they last changed |
| `nk hooks write [agent]` | Write the hooks from the repository's CI; with an agent, also starts it in the same folder to finish what CI could not tell |
| `nk hooks test` | Run the hooks of the folder you are in, in a temporary workspace; fails if remove leaves anything behind |
| `nk forget [<short-name>]` | Stop knowing a repository: remove its registration and shared files; its folder and backups stay |
| `nk doctor` | Check nk's tools (node, git, gh, docker, agents) without changing anything |

Like git, every command acts on the repository you are in: its main
checkout or one of its workspaces. Outside a repository, `nk -b`, opening,
`nk rm` and `nk clean` refuse to guess; pass `--repo <short-name>` to name
one. `nk ls` only reads, so outside a repository it lists all of them.

Without an agent, `nk -b` and `nk <name>` print the workspace path, so
`cd "$(nk my-branch)"` works. Arguments after `--` go to the agent.

`nk init` records the agents it finds on PATH and asks nothing about them:
each one starts with its own default command. To always pass extra
arguments to one agent, set `args` under `[agents.<name>]` in `config.toml`.

## Home folder

```
~/nook/                      (set NOOK_HOME to move it)
  config.toml                repositories, agents, workspaces, allowed hooks
  workspace/<repo>/<name>/   one git worktree per workspace
  shared/<repo>/             files copied into every new workspace
  backup/<repo>/             what nk rm saved before deleting
  logs/                      output of every hook run
```

## Names

A workspace name is also its branch name and folder name. It uses lowercase
letters, digits, `-` and `.` only, and cannot be a command name (`init`, `ls`,
`rm`, `clean`, `hooks`, `forget`, `doctor`, `help`, `version`).

You can pass any branch text; `nk` turns it into a valid name and says so:
uppercase becomes lowercase, and `/`, spaces, non-ASCII and other characters
become `-`. For example `REE-12-修复登录/Login` becomes `ree-12-login`. This
way any tool that calls `nk` can pass its own branch name as it is.

When a branch with exactly the text you passed already exists (locally or on
`origin`), `nk -b` checks out that branch and only the workspace and folder use
the converted name: `nk -b feat/Login` makes workspace `feat-login` on branch
`feat/Login`, the same way worktrunk sanitizes `/` in folder names. `nk ls`,
`nk rm` and `nk clean` then use that branch for git and pull requests.

When `nk -b` runs in a terminal and had to change the name, it shows the
converted name ready to edit; press Enter to keep it. Without a terminal it uses
the converted name.

## Shared files

New worktrees do not contain ignored files such as `.env`. `nk init` prepares
`~/nook/shared/<repo>/` once, and every new workspace copies it.

- Files are picked with `.worktreeinclude` (gitignore syntax) when the
  repository has one, otherwise with `.env*`.
- Only files git ignores are used, so a shared file never replaces a tracked one.
- Every committed template for an ignored file starts a shared file: init
  copies `X.example`, `X.sample`, `X.template` or `X.dist` to the shared `X`
  (in any folder) and opens it for you to fill in once. Examples: `.env.example`,
  `.dev.vars.example`, `config/database.yml.dist`. The same file in the main
  checkout is not copied then, since it may be production.
- A template written for running the app inside Docker names Compose services:
  `DATABASE_URL=...@postgres:5432/app`. When the Compose file publishes that
  service on this machine (`127.0.0.1:5432:5432`), init points the value at
  `127.0.0.1:5432` and leaves the user, password and database name as they
  are; each workspace then moves the port to its own. Secrets stay for you to
  fill in.
- Other ignored files in the main checkout are copied only if you say yes.
- Running `nk init` again never replaces a shared file that is already there;
  it only adds new ones. Edit the files in `~/nook/shared/<repo>/` directly.

## Hooks

Put scripts in `.nook/` in the repository and commit them. Nook reads them from
the main checkout and runs them inside the workspace, so a workspace on an old
branch that predates the hooks still gets them (worktrunk likewise reads its
project config from where the command runs). The file name is the moment it
runs:

| File | Runs | On failure |
|---|---|---|
| `create` | after a workspace is created and shared files are copied | workspace is kept, agent is not started |
| `open` | every time a workspace is opened (and once after `create`) | agent is not started |
| `remove` | before a workspace is deleted | nothing is deleted |

Nook picks one file per moment: on Windows `.ps1`, then `.cmd`; on macOS and
Linux `.sh`; on every system `.mjs` (run with Node) and `.py`. One `.mjs` file
works everywhere.

Hooks see `NOOK_WORKSPACE`, `NOOK_PATH`, `NOOK_REPO`, `NOOK_SHARED` and
`NOOK_PORT` (the first of 10 ports reserved for the workspace).

### Writing the hooks from CI and Compose

CI already says, step by step, how a clean machine gets the project running,
and it is kept working because it runs on every change. Nook turns it into
hooks without AI, and tests them.

The whole cycle:

```
nk init                     once per repository
nk hooks write              hooks from CI (GitHub Actions) and the Compose file
nk hooks test               run them in a temporary workspace; nothing may be left behind
nk -b <name> codex          new workspace; nk <name> codex reopens one
nk ls                       PR and CI of every workspace; merge or close on GitHub
nk clean | nk rm <name>     remove merged or chosen workspaces
```

nk picks the CI job most like "set up and test the project": it runs on pull
requests or pushes, runs tests, and has the most setup steps and services. Jobs
that release, deploy, lint or only build are passed over; the report lists the
others. Local composite actions (`uses: ./.github/actions/setup`) are read
step by step, as if their steps were in the job. What it takes from that job:

| In CI | In the hooks |
|---|---|
| `actions/setup-node`, `setup-python`, `pnpm/action-setup`, `astral-sh/setup-uv`... | create checks the tool is installed and warns about another version |
| `corepack enable` | also a tool check: Node 25 and later no longer include corepack (`npm install -g corepack`) |
| `run:` steps before the first test, lint or build step | create runs them in the workspace, and stops with a plain message when a step's program is not installed; an install CI skips on a cache hit (`if: steps.cache.outputs.cache-hit != 'true'`) runs, since a new workspace has no cache |
| a job that `needs:` another and downloads its artifact | the other job's installs come first |
| `services:` (a database, say) | create starts one container per workspace on the workspace's own ports; open starts it again; remove deletes it with its volumes |
| `env:` | added to the workspace's `.env`, with `localhost:<CI port>` changed to the workspace's port |
| `run:` steps with `if: always()` (cleanup) | remove runs them |
| checkout, caches, uploads, tests, lint, builds | left out |

When the repository has a Compose file (`compose.yaml`, `docker-compose.yml`...),
nk also reads it, together with its override file (`compose.override.yaml`...)
as `docker compose` does, since many projects start their database there rather than
in CI:

| In the Compose file | In the hooks |
|---|---|
| a database or similar service used as it is (`postgres`, `redis`, `rabbitmq`, `minio`, `mailpit`...) | create starts it in the workspace's own Compose project, `nook-<repo>-<workspace>`; open starts it again; remove runs `docker compose down --volumes` for that project |
| a host port written as a variable, `${API_PORT:-3001}:3001` | the variable gets one of the workspace's ports in its `.env`, so you can run that service too without a clash |
| a value it needs, `${POSTGRES_PASSWORD:?...}` | create stops and names it when `.env` does not have it; set it once in the shared `.env` |
| a service built from the repository, the project's own image (the app), or one under a profile | not started; start it yourself when you need it |
| more services than the workspace's ten ports hold | the last ones are not started, and listed |
| a fixed host port, `5432:5432` | moved to one of the workspace's ports (`127.0.0.1:<port>:5432`) by a small Compose file nk writes into the worktree's git folder; `COMPOSE_FILE` in `.env` lists it, so a `docker compose` you run there uses it too |

When the chosen CI job has services of its own, nk starts those and none from
Compose, so the same database is not started twice.

The workspace's `.env` also gets `COMPOSE_PROJECT_NAME` set to the
workspace's project, replacing whatever the copied file said, so a
`docker compose` you run there never reaches the main checkout's project.
Values in the copied `.env` that point at a moved port are pointed at the
workspace's port: `DATABASE_URL=postgres://...@localhost:5432/app` becomes
`localhost:<workspace port>`, and so does `DB_PORT=5432`.
Other env files at the root that many projects load after `.env`, such as
`.env.development` or `.env.test`, are pointed at the workspace's ports the
same way; templates (`.env.example`, `.env.sample`) are left alone. When the
repository commits one of these files, the workspace's copy comes from git and
is changed in place; nk marks it `skip-worktree`, so these changes never show
in `git status` or reach a commit.

CI runs on a throwaway machine; a developer machine also has the real
database and other workspaces. So nk copies less than CI does, never more:

- Only commands that install dependencies into the folder (`pnpm install`,
  `npm ci`, `uv sync`, `pip install`...) are copied. A script, a `docker`
  command or a migration is listed for review instead, since nk cannot tell
  what it would touch here.
- An `env:` value that points at a local port that is not one of CI's
  services (say `localhost:5432` when CI starts Postgres itself), or at a
  database elsewhere, is left out: on this machine it may be the real one.
- Services get containers named after the workspace, on the workspace's own
  ports, bound to 127.0.0.1. Every step runs with `COMPOSE_PROJECT_NAME` set
  to the workspace's own project.
- Generated hooks refuse to run unless nk runs them in a workspace, so they
  never run in the main checkout.

What it cannot translate (a CI expression such as `${{ secrets.X }}`, a step
that runs only under a condition, an action it does not know) is listed too,
not guessed. `nk hooks write <agent>` does the same, then starts the agent in
the same folder (usually the main checkout) to finish those parts; the agent
runs `nk hooks test` until it passes and leaves the changes for you to review.
To keep the agent out of the main checkout, run it inside a workspace instead
(`nk -b hooks`, then `nk hooks write <agent>` there). Generated hooks start with a
line saying so; `nk hooks write` replaces only those, never hooks written by
hand.

`nk hooks test` runs the hooks of the folder you are in (the agent's branch,
before it is merged) in a temporary workspace: create, open twice, then
remove. It fails when a hook fails, when open cannot run twice, when the
hooks change files git would commit, or when remove leaves a Docker
container, volume, network or built image behind.

A passing test records the hooks, the CI files and the Compose file. If any of them changes, `nk -b`
stops before creating a workspace (pass `--untested` to start anyway), and
`nk <name>`, `nk hooks`, `nk doctor` and `nk rm` say so: run `nk hooks write`
again for a CI or Compose change, then `nk hooks test`.

[docs/setup-hooks.md](docs/setup-hooks.md) has the rules and examples for
pnpm and npm, uv, and a Docker Compose project per workspace.

Before hooks run for the first time, and again after one changes, Nook lists
them (event and file, not the contents) and asks once: "Allow and remember?".
Rerunning `nk init` also asks. Each run's output is saved in `~/nook/logs/`.

Output lines start with ◎ (running now), ✓ (done), ▲ (needs attention) or
○ (information), as in worktrunk. Colors are used on a terminal unless
`NO_COLOR` is set.

## Removing a workspace

`nk rm <name>` refuses while you are inside the workspace. It lists
uncommitted changes, unpushed commits, an unmerged branch and programs still
running in the folder (terminals, dev servers, agents: any process whose
working directory is inside it), asks once, then:

1. stops those programs and their child processes;
2. saves changes and unpushed commits to `~/nook/backup/<repo>/<name>-<time>/`
   (`changes.patch`, `untracked/`, `commits.bundle`);
3. runs the `remove` hook, if the repository has one;
4. removes the Docker Compose projects started inside the folder: their
   containers, volumes, networks and built images;
5. deletes the folder and the branch.

Nothing has to be written down when the workspace is created. Compose labels
every container with the folder it was started from, so nk asks Docker at
removal time and also finds services an agent started later. A project that
also has containers started elsewhere (the main checkout's, for example) is
kept. `nk doctor` lists Compose projects left behind by workspaces that no
longer exist.

This is a safety net: the `remove` hook should still undo everything `create`
did, and `nk hooks test` checks that it does.

## Listing and cleaning up

`nk ls` shows each workspace's uncommitted changes, its commits ahead (↑) and
behind (↓) the default branch, and its pull request with the CI result
(`#12 open running`, `#12 merged`). PR and CI come from the
[GitHub CLI](https://cli.github.com/) (`gh`), one request per repository. When
`gh` is missing or not logged in, the PR column stays empty and a ▲ line says
why. Merged rows are dimmed. `nk ls --json` prints the same data for scripts
and agents.

Git is the source of truth, as in worktrunk: `nk ls` shows every worktree of
the repository, including ones made by other tools (Orca, Conductor, plain
`git worktree add`). Those have no port, and are named by their branch with
the same conversion as `nk -b` (`ree-auz/REE-228` becomes `ree-auz-ree-228`).
The first column marks the main checkout `^`, the worktree you are in `@`, and
the others `+`. `nk rm`, `nk <name>` and `nk clean` work on all of them; a name
matches the branch or the folder. The main checkout and worktrees locked with
`git worktree lock` are never removed, but `nk main [agent]` opens the main
checkout like any workspace.

`nk clean` removes workspaces whose work is merged, like worktrunk's
`wt step prune` and gh-poi. It first fetches the default branch, then counts a
workspace as merged when:

- its pull request is merged and the local branch has nothing the PR did not
  have (so squash merges count), or
- it has no pull request, its branch is already in the default branch, and it
  is at least a day old (so a workspace you just created is kept).

It keeps locked worktrees, workspaces with uncommitted changes, with commits made after the PR
was merged, and the one you are inside. It lists what it would remove, what it
keeps, and the programs running in the ones it removes, asks once, then stops
those programs and removes each workspace the way `nk rm` does (backup,
`remove` hook, folder and branch). `-n` only shows
the list; `-y` removes without asking.

It also deletes folders left from earlier removals: on Windows, git can
remove a worktree and still leave ignored folders such as `node_modules` or
`.venv` behind. Such a folder is neither a workspace nor a git worktree any
more; `nk clean` deletes it, with any Compose project started in it, unless a
program is still running there. `nk rm` itself now deletes whatever git leaves
and stops with the reason when Windows keeps a file open.

## Forgetting a repository

`nk forget` (in the repository, or `nk forget <short-name>` from anywhere)
undoes `nk init`: it removes the repository's registration and its shared
files in `~/nook/shared/<short-name>/`, after one confirmation. The repository
folder and the backups `nk rm` made stay.

It refuses while the repository has workspaces, so their work is backed up by
`nk rm` first. If the repository folder is already deleted, git can no longer
remove its workspaces; then `nk forget` lists what is left in
`~/nook/workspace/<short-name>/` and deletes it too, with the containers,
volumes, networks and built images started there (Compose projects, and the
service containers generated hooks start). Their remove hooks cannot run, since
they were in the deleted folder.

## Linear

To open a Linear issue in a new workspace with one click, see
[integrations/linear](integrations/linear/README.md).

## For agents

[`skills/nook/SKILL.md`](skills/nook/SKILL.md) tells a coding agent how to work
inside a workspace: the `NOOK_*` variables, which ports to use, which files not
to commit, and which commands are safe to run. Copy the `skills/nook` folder
into your agent's skills folder (for example `~/.claude/skills/`).

## Development

```
npm ci
npm test
```

CI runs the tests on Linux, macOS and Windows.

`npm run corpus` checks what `nk hooks write` makes of real repositories
(`tests/corpus/repos.json`, each at a pinned commit; only their CI, Compose and
env template files are fetched, and nothing in them is run) against the
reviewed results in `tests/corpus/expected/`. CI runs it too. After a change to
how hooks are written, review the lines it prints and accept them with
`npm run corpus -- --update`.

The repositories marked `"full": true`, plus about ten popular ones nk has not
seen (`scripts/real-explore.mjs` picks different ones each time, each with a
root Compose file or CI services), also get a real run every Monday
(`.github/workflows/real-repos.yml`; start it by hand from the Actions tab with
Run workflow, optionally for some repositories only). On a fresh GitHub runner
with the tool versions its CI uses, `scripts/real-run.mjs` runs `nk init`,
`nk hooks write` and `nk hooks test`. Then, with the ports a main checkout's
services usually take (5432, 3306, 6379 and others) held as if they were
running, it creates two workspaces, `try1` and `try2`. Each must be clean in
git, have no address or port in its `.env` files that points at those ports,
and have its own services answering; the two must share no port or container,
and `try1` must still answer once `try2` runs. Then `nk rm` removes both, and
no container, volume, network or folder may be left.
The run's summary is one table: each repository, the step it failed at, and
that step's last lines. New repositories that failed are added to
`tests/corpus/repos.json` once fixed, so the fixed list keeps growing.

## License

MIT
