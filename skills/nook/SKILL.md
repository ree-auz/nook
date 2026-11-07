---
name: nook
description: Use when working in a git worktree managed by nk (Nook), when asked to create, list, open, remove or clean up workspaces with nk, or to set up a repository's .nook hooks.
---

# Working with Nook (`nk`)

Nook keeps one git worktree per task under `~/nook/workspaces/<repo>/<name>`.
The workspace name is also the branch name and the folder name.

## Am I in a workspace?

`NOOK_WORKSPACE` is set when nk started you. These variables are also set:

| Variable | Meaning |
| --- | --- |
| `NOOK_WORKSPACE` | workspace and branch name |
| `NOOK_PATH` | this workspace's folder |
| `NOOK_REPO` | the main checkout of the repository |
| `NOOK_SHARED` | the repository's shared folder (holds files such as `.env`) |
| `NOOK_PORT` | first of ten ports reserved for this workspace (`NOOK_PORT` to `NOOK_PORT + 9`) |

Without the variables, `nk ls --json` lists every workspace with its `path`;
you are in one when your working directory is inside that path.

## Rules

- Work and commit only inside your own workspace folder. Do not edit the main
  checkout (`NOOK_REPO`) or another workspace.
- Use ports from `NOOK_PORT` to `NOOK_PORT + 9` for servers you start, so
  workspaces do not collide.
- Files copied from the shared folder (such as `.env`) are local settings.
  Do not commit them and do not print their contents.
- Do not run `nk rm` or `nk clean` on your own workspace: nk refuses while
  you are inside it. Leave removal to the person or the tool that started you.
- Hooks in `.nook/` run with the person's approval. Do not edit them to get
  past a failure; report the failure and the log path nk printed.

## Setting up hooks

When asked to set up Nook hooks: if you were started by `nk hooks write
<agent>`, nk has already generated hooks from CI and the Compose file; finish what its prompt lists
as not translated. Otherwise run `nk hooks write` first. Follow
[docs/setup-hooks.md](https://github.com/ree-auz/nook/blob/main/docs/setup-hooks.md),
run `nk hooks test` in the folder you work in and fix the hooks until it
passes. Delete the first line of a generated hook you edit. Do not commit or
push unless asked.

## Commands

| Command | Use |
| --- | --- |
| `nk -b <name> [agent] [-p <prompt>]` | Create a workspace from the default branch (or an existing branch of that name) |
| `nk <name>` | Print a workspace's path; with an agent, start it there |
| `nk ls --json` | Every workspace of this repository: `name`, `repo`, `path`, `port`, `changes`, `ahead`, `behind`, `pr` (`number`, `state`, `ci`) |
| `nk rm <name>... -n` | Show what removing would back up and delete, change nothing |
| `nk clean -n` | Show which workspaces are merged and would be removed |
| `nk hooks test` | Run this folder's hooks in a temporary workspace; fails on leftovers |
| `nk hooks` | The repository's hooks: allowed, tested |
| `nk doctor` | Check nk's tools; exit 1 when something is broken |

Pass `-y` to `nk rm` or `nk clean` only when the person asked for the
removal. Both back up uncommitted changes and unpushed commits to
`~/nook/backup/<repo>/` first.

## Reading results

Exit code 0 means success. On failure, stderr starts with `✗ what failed`,
followed by `○` lines saying why and what to do next. Follow those lines
instead of guessing.
