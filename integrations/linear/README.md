# Open Linear issues in Nook

Linear's **Work on issue → Custom script** can run a local command for an
issue. With the files here, one click creates a Nook workspace on the
issue's branch (running the repository's hooks) and starts your agent in it
with Linear's prompt, in a new terminal tab. Nook itself knows nothing about
Linear: this folder only connects the two.

Supported so far: Windows with Windows Terminal.

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
       "args": ["<nook folder>\\integrations\\linear\\open-issue.mjs", "codex"],
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
   - The last argument is the agent: `codex`, `claude` or any command
     `nk -b <name> <agent>` accepts.
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
- It opens a tab with `wt.exe -w 0 new-tab -d <chosen folder>`, which runs the
  same script again inside the tab. That second run reads and deletes the
  file, then runs `nk` with the same Node, so the prompt never passes through
  `cmd.exe`.
