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
| `nk ls` | List workspaces and whether they have changes |
| `nk rm <name> [-n] [-y]` | Back up and remove a workspace (`-n` shows what would happen, `-y` skips the question) |
| `nk doctor` | Check the setup without changing anything |

Without an agent, `nk -b` and `nk <name>` print the workspace path, so
`cd "$(nk my-branch)"` works. Arguments after `--` go to the agent.

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

A workspace name is also its branch name and folder name. It may use lowercase
letters, digits, `-` and `.`, must not contain `/`, and cannot be a command name
(`init`, `ls`, `rm`, `clean`, `doctor`, `help`, `version`).

## Shared files

New worktrees do not contain ignored files such as `.env`. `nk init` prepares
`~/nook/shared/<repo>/` once, and every new workspace copies it.

- Files are picked with `.worktreeinclude` (gitignore syntax) when the
  repository has one, otherwise with `.env*`.
- Only files git ignores are used, so a shared file never replaces a tracked one.
- When the repository has a template such as `.env.example`, init starts the
  shared `.env` from it, so a production `.env` in the main checkout is never
  copied unless you choose that.

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

Before a hook runs for the first time, and again after it changes, Nook shows it
and asks. Rerunning `nk init` also asks.

## Removing a workspace

`nk rm <name>` refuses while you are inside the workspace or while another
program still has it as its working directory or holds a file in it. It lists
uncommitted changes, unpushed commits and an unmerged branch, asks once, then:

1. saves changes and unpushed commits to `~/nook/backup/<repo>/<name>-<time>/`
   (`changes.patch`, `untracked/`, `commits.bundle`);
2. runs the `remove` hook;
3. deletes the folder and the branch.

## Development

```
npm ci
npm test
```

CI runs the tests on Linux, macOS and Windows.
