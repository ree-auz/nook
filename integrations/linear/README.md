# Open Linear issues in Nook

Two ways, which work together:

- [`nkl`](#from-the-command-line-nkl): choose and start issues from the
  command line, and see their status and what blocks them.
- [Work on issue → Custom script](#from-linear-work-on-issue): one click in
  Linear starts the same thing.

Nook itself knows nothing about Linear: this folder only connects the two.

## From the command line: nkl

`nkl` comes with nook (`npm i -g @ree-auz/nook`). It only reads Linear: the
issue's status still changes through Linear's GitHub integration as the
branch and its pull request move.

### Set up once

Create a personal API key in Linear (**Settings → Security & access →
Personal API keys**; read access is enough) and put it in `LINEAR_API_KEY`.
In PowerShell:

```powershell
setx LINEAR_API_KEY "lin_api_..."
```

then open a new terminal. To always use the same agent, terminal or agent
label group, set `NKL_AGENT`, `NKL_TERMINAL` or `NKL_AGENT_LABEL` the same way.

### Use

Run it in a repository's main checkout, where you ran `nk init`:

```text
nkl                      choose from your unfinished issues
nkl REE-292 [agent]      start one: nk -b <issue branch> <agent> -y -p <prompt>
nkl next                 start the first ready issue
nkl show REE-292         status, assignee, priority, blocked by, blocks, sub-issues
nkl prompt REE-292       print the prompt the agent would get
nkl ls                   your workspaces with their issue's status in Linear
```

- **The list** puts first what you can start now: issues nothing unfinished
  blocks, then started before planned before backlog, the current cycle, and
  higher priority. `⛔` marks a blocked issue (with what blocks it) and `●` one
  that has a workspace. Arrows move, typing filters (on the identifier, title,
  status and labels), Enter starts the issue.
- **Several at once**: Tab marks issues, Enter starts each in a tab of its own
  (Windows Terminal by default, or `--terminal warp`), with its agent.
- **Blocked issues**: before starting one, nkl says what blocks it and asks
  whether to start it anyway, start the blocker instead, or do nothing
  (`-y` starts it without asking).
- **`nkl next`** starts the first issue in the list's order that nothing
  blocks and that has no workspace yet.
- **The prompt** holds the issue's title, link, status, priority, project,
  labels, description (with its image links), parent, blocked by, blocks,
  sub-issues, related issues and the latest five comments, so the agent need
  not look anything up. Starting an issue that has a workspace reopens it and
  starts the agent without the prompt, as the click in Linear does.
- **`nkl ls`** flags workspaces whose issue is Done or Canceled while their PR
  is not merged: `nk clean` keeps those, so they are easy to forget.

Filters, for the list and `nkl next`: `--all` (everyone's issues, not only
yours), `--team REE`, `--cycle` (the current cycle), `--project <name>`,
`--label <name>`, `--view <name>` (a custom view you saved in Linear).

The agent is the one given after the issue, else the one a label names with
`--agent-label <group>` (as below), else `--agent`, else `codex`.
`--terminal orca` starts the agent in Orca, as described below.

## From Linear: Work on issue

Linear's **Work on issue → Custom script** can run a local command for an
issue. With the files here, one click creates a Nook workspace on the
issue's branch (running the repository's hooks) and starts your agent in it
with Linear's prompt, in the terminal Linear opens for the script. Nook
Tested on Windows. `--terminal wt` and `--terminal warp` are Windows only.

### Set up once

1. Install Nook and run `nk init` in each repository you work on.
2. In Linear, open **Settings → Code & reviews → Configure coding tools** and
   enable **Custom script**.
3. Put this in `~/.linear/coding-tools.json` (on Windows,
   `C:\Users\<you>\.linear\coding-tools.json`). If Linear already wrote a
   starter file there, replace its `openIssue` block with this one:

   ```json
   {
     "openIssue": {
       "path": "C:\\Program Files\\nodejs\\node.exe",
       "args": ["<nook folder>\\integrations\\linear\\open-issue.mjs", "--agent", "codex"],
       "env": ["LINEAR_ISSUE_IDENTIFIER", "LINEAR_ISSUE_BRANCH_NAME", "LINEAR_PROMPT", "LINEAR_WORK_DIR"]
     }
   }
   ```

   - `path` is the absolute path of Node (`where node` prints it). With a
     version manager, use a path that stays put: for fnm,
     `%APPDATA%\fnm\aliases\default\node.exe` written out in full (it follows
     `fnm default`), not the temporary `fnm_multishells` folder. The script
     puts that Node's folder first on PATH, so global npm commands such as
     `codex` and `pnpm` are found even though Linear starts without your
     shell setup.
   - `<nook folder>` is where Nook is installed: the cloned folder, or
     `npm root -g` + `\@ree-auz\nook`.
   - `--agent` is the agent to start: `codex` (the default), `claude` or any
     command `nk -b <name> <agent>` accepts.
   - Linear runs the script in a terminal of its own (on Windows, Windows
     Terminal; the terminal choice in Linear's settings is macOS only). To
     work in Warp instead, add `"--terminal", "warp"` to `args`: the script
     opens a tab in Warp and closes Linear's window.
   - To keep agents in [Orca](https://www.onorca.dev) (its accounts and
     sessions), add `"--terminal", "orca"`: Nook creates the workspace and
     runs its hooks in Linear's window, then
     `orca agent launch --agent <agent> --worktree path:<workspace> --prompt <Linear's prompt> --focus`
     starts the agent in Orca. Orca shows worktrees it did not create, and
     `nk rm` / `nk clean` still remove them with their containers and
     volumes. Orca's command-line tool must be installed; if Linear cannot
     find it on PATH, add `"--orca", "<full path to orca>"`. Linear's window
     closes when Orca has the agent, and stays open with the error otherwise.
   - To let each issue pick its agent, label issues from one label group
     (say `Agent › Codex`, `Agent › Claude`) and add `"--agent-label", "Agent"`
     to `args`. Linear's prompt lists the issue's labels, and the script starts
     the agent named by that group's label (lowercased, spaces as `-`), or the
     `--agent` one when the issue has none.
   - `env` is an allowlist: Linear only passes the variables listed here.

### Use

On an issue, choose **Work on issue → Custom script**. The first time, Linear
asks you to **Choose a directory**: pick the repository's main checkout (the
folder where you ran `nk init`). Nook uses it only to know which repository
the issue belongs to; nothing runs there.

The terminal runs `nk -b <issue branch> <agent> -y -p <Linear's prompt>` in
that folder (`-y` keeps the converted workspace name without asking).
Choosing the same issue again reopens its workspace and starts the agent
without the prompt (with `--terminal orca`, a new agent session in Orca;
earlier sessions stay in Orca's list).

Linear's GitHub integration moves the issue along as the branch and its pull
request change, because the branch name holds the issue identifier. After the
pull request is merged, `nk clean` removes the workspace.

### How it works

- Linear opens a terminal, runs `open-issue.mjs` in it and passes the issue
  through the `LINEAR_*` variables.
- By default the script runs `nk` right there, with the same Node.
- With `--terminal`, the prompt is long Markdown with quotes and semicolons,
  so the script writes it to a temporary file and opens a tab in the chosen
  folder that runs the same script again: Windows Terminal with
  `wt.exe -w 0 new-tab -d <folder>`; Warp, whose `warp://` links cannot run a
  command, through a
  [tab config](https://docs.warp.dev/terminal/windows/tab-configs/) written to
  `%APPDATA%\warp\Warp\data\tab_configs\` and opened with
  `warp://tab_config/<name>` (the tab deletes it when it starts). A
  minimized Warp window stays minimized. It then
  closes the window Linear opened.
- `nk` runs with the same Node, never through `cmd.exe`, which would cut a
  multi-line prompt at its first line break.
