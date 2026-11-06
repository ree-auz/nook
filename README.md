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
| `nk -b <name> [agent] [-p <prompt>]` | Create a workspace; start the agent if given |
| `nk <name> [agent] [-p <prompt>]` | Open a workspace; start the agent if given |
| `nk ls [--json]` | List workspaces: uncommitted changes, commits ahead of and behind the default branch, PR and CI |
| `nk rm <name> [-n] [-y]` | Back up and remove a workspace (`-n` shows what would happen, `-y` skips the question) |
| `nk clean [-n] [-y]` | Remove every workspace whose work is merged |
| `nk doctor` | Check the setup without changing anything |

Without an agent, `nk -b` and `nk <name>` print the workspace path, so
`cd "$(nk my-branch)"` works. Arguments after `--` go to the agent.

`nk init` records the agents it finds on PATH and asks nothing about them:
each one starts with its own default command. To always pass extra
arguments to one agent, set `args` under `[agents.<name>]` in `config.toml`.

## Home folder

```
~/nook/                      (set NOOK_HOME to move it)
  config.toml                repositories, agents, workspaces, allowed hooks
  workspaces/<repo>/<name>/  one git worktree per workspace
  shared/<repo>/             files copied into every new workspace
  backup/<repo>/             what nk rm saved before deleting
  logs/                      output of every hook run
```

## Names

A workspace name is also its branch name and folder name. It uses lowercase
letters, digits, `-` and `.` only, and cannot be a command name (`init`, `ls`,
`rm`, `clean`, `doctor`, `help`, `version`).

You can pass any branch text; `nk` turns it into a valid name and says so:
uppercase becomes lowercase, and `/`, spaces, non-ASCII and other characters
become `-`. For example `REE-12-修复登录/Login` becomes `ree-12-login`. This
way any tool that calls `nk` can pass its own branch name as it is.

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
- Other ignored files in the main checkout are copied only if you say yes.

## Hooks

Put scripts in `.nook/` in the repository and commit them. The file name is the
moment it runs:

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
3. runs the `remove` hook;
4. deletes the folder and the branch.

## Listing and cleaning up

`nk ls` shows each workspace's uncommitted changes, its commits ahead (↑) and
behind (↓) the default branch, and its pull request with the CI result
(`#12 open running`, `#12 merged`). PR and CI come from the
[GitHub CLI](https://cli.github.com/) (`gh`), one request per repository. When
`gh` is missing or not logged in, the PR column stays empty and a ▲ line says
why. Merged rows are dimmed. `nk ls --json` prints the same data for scripts
and agents.

`nk clean` removes workspaces whose work is merged, like worktrunk's
`wt step prune` and gh-poi. It first fetches the default branch, then counts a
workspace as merged when:

- its pull request is merged and the local branch has nothing the PR did not
  have (so squash merges count), or
- it has no pull request, its branch is already in the default branch, and it
  is at least a day old (so a workspace you just created is kept).

It keeps workspaces with uncommitted changes, with programs running in them,
with commits made after the PR was merged, and the one you are inside. It lists
what it would remove and what it keeps, asks once, then removes each one the
way `nk rm` does (backup, `remove` hook, folder and branch). `-n` only shows
the list; `-y` removes without asking.

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

## License

MIT
