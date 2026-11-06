# Open Linear issues in Nook

Linear's **Work on issue → Custom script** can run a local command for an
issue. With the files here, one click creates a Nook workspace on the
issue's branch (running the repository's hooks) and starts your agent in it
with Linear's prompt, in the terminal Linear opens for the script. Nook
itself knows nothing about Linear: this folder only connects the two.

Tested on Windows. `--terminal` (Windows Terminal or Warp) is Windows only.

## Set up once

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
     opens a Warp tab and closes Linear's window.
   - To let each issue pick its agent, label issues from one label group
     (say `Agent › Codex`, `Agent › Claude`) and add `"--agent-label", "Agent"`
     to `args`. Linear's prompt lists the issue's labels, and the script starts
     the agent named by that group's label (lowercased, spaces as `-`), or the
     `--agent` one when the issue has none.
   - `env` is an allowlist: Linear only passes the variables listed here.

## Use

On an issue, choose **Work on issue → Custom script**. The first time, Linear
asks you to **Choose a directory**: pick the repository's main checkout (the
folder where you ran `nk init`). Nook uses it only to know which repository
the issue belongs to; nothing runs there.

The terminal runs `nk -b <issue branch> <agent> -y -p <Linear's prompt>` in
that folder (`-y` keeps the converted workspace name without asking).
Choosing the same issue again reopens its workspace and starts the agent
without the prompt.

Linear's GitHub integration moves the issue along as the branch and its pull
request change, because the branch name holds the issue identifier. After the
pull request is merged, `nk clean` removes the workspace.

## How it works

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
  `warp://tab_config/<name>` (the tab deletes it when it starts). It then
  closes the window Linear opened.
- `nk` runs with the same Node, never through `cmd.exe`, which would cut a
  multi-line prompt at its first line break.
