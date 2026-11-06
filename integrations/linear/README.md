# Open Linear issues in Nook

Linear's **Work on issue → Custom script** can run a local command for an
issue. With the files here, one click creates a Nook workspace on the
issue's branch (running the repository's hooks) and starts your agent in it
with Linear's prompt, in a new terminal tab. Nook itself knows nothing about
Linear: this folder only connects the two.

Supported so far: Windows, with Windows Terminal (default) or Warp.

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
   - To open the tab in Warp instead of Windows Terminal, add
     `"--terminal", "warp"` to `args`.
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

A Windows Terminal tab opens in that folder and runs
`nk -b <issue branch> <agent> -p <Linear's prompt>`. Choosing the same issue
again reopens its workspace and starts the agent without the prompt.

Linear's GitHub integration moves the issue along as the branch and its pull
request change, because the branch name holds the issue identifier. After the
pull request is merged, `nk clean` removes the workspace.

## How it works

- Linear runs `open-issue.mjs` without a window and passes the issue
  through the `LINEAR_*` variables.
- The prompt is long Markdown with quotes and semicolons, so the script
  writes it to a temporary file instead of putting it on a command line.
- It opens a tab in the chosen folder that runs the same script again:
  Windows Terminal with `wt.exe -w 0 new-tab -d <folder>`; Warp, whose
  `warp://` links cannot run a command, through a
  [tab config](https://docs.warp.dev/terminal/windows/tab-configs/) written to
  `%APPDATA%\warp\Warp\data\tab_configs\` and opened with
  `warp://tab_config/<name>`. The tab deletes that config when it starts.
- Inside the tab the script reads and deletes the prompt file, then runs
  `nk` with the same Node, so the prompt never passes through `cmd.exe`.
