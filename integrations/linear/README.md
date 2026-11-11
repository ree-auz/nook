# Open Linear issues in Nook

Linear's **Work on issue → Custom script** can run a local command for an
issue. With the files here, one click creates a Nook workspace on the
issue's branch (running the repository's hooks) and starts your agent in it
with Linear's prompt, in the terminal Linear opens for the script. Nook
itself knows nothing about Linear: this folder only connects the two.

Tested on Windows. `--terminal wt` and `--terminal warp` are Windows only;
`--terminal wezterm` and `--terminal orca` work on Windows, macOS and Linux.

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
     opens a tab in Warp and closes Linear's window.
   - To work in [WezTerm](https://wezterm.org), add `"--terminal", "wezterm"`:
     the script opens a tab in the WezTerm window that is open, or a new
     WezTerm window when none is, and closes Linear's window. If WezTerm is
     not on PATH, add `"--wezterm", "<full path to wezterm>"` (on Windows,
     usually `C:\\Program Files\\WezTerm\\wezterm.exe`). When a WezTerm
     window is open but a new one opens anyway, the new window's first line
     says why.
   - Windows Terminal and WezTerm open a tab by default. For a window of its
     own per issue, add `"--open", "window"` (or `"open": "window"` in the
     config file below). Warp always opens a tab.
   - To keep agents in [Orca](https://www.onorca.dev) (its accounts and
     sessions), add `"--terminal", "orca"`: Nook creates the workspace and
     runs its hooks in Linear's window, then
     `orca agent launch --agent <agent> --worktree path:<workspace> --prompt <Linear's prompt> --focus`
     starts the agent in Orca. Orca shows worktrees it did not create, and
     `nk rm` / `nk clean` still remove them with their containers and
     volumes. Orca's command-line tool must be installed; if Linear cannot
     find it on PATH, add `"--orca", "<full path to orca>"`. Linear's window
     closes when Orca has the agent, and stays open with the error otherwise.
   - `env` is an allowlist: Linear only passes the variables listed here.

4. Optional: let labels choose, per issue, the agent, its model and effort,
   and the terminal. Put this in `~/.linear/nook.json` (on Windows,
   `C:\Users\<you>\.linear\nook.json`; or name another file with
   `"--config", "<path>"` in `args`). [`nook.example.json`](nook.example.json)
   is a fuller example (its model ids are examples: use the ones your agents'
   command-line tools take):

   ```json
   {
     "agent": "codex",
     "terminal": "here",
     "labels": { "agent": "Agent", "model": "Model", "effort": "Effort", "terminal": "Terminal" },
     "models": {
       "Light": { "codex": "gpt-6-luna", "claude": "claude-haiku-5-5" },
       "Strong": { "codex": "gpt-6-astra", "claude": "claude-opus-5-5" }
     }
   }
   ```

   In Linear, make a label group for each entry of `labels` and put the
   labels in it (**Settings → Teams → Labels**, then a label with
   **Create group**). Every key is optional: what is left out falls back to
   the defaults below. [Labels](#labels) lists every key and the names each
   group's labels can have.

## Labels

### What starts when there are no labels

| | Order, first one wins | Without any |
| -- | -- | -- |
| Agent | `Agent` label → the agent of a model label → `--agent` → `"agent"` | `codex` |
| Model | `Model` label | the agent's own default model |
| Effort | `Effort` label → the effort in the `Model` label (`Strong · high`) → the tier's effort in `models`; each mapped through `efforts` for the agent | the agent's own default effort |
| Terminal | `Terminal` label → `--terminal` → `"terminal"` | the window Linear opened |

The first line in Linear's window says which agent, model and terminal were
chosen, and why a label was not used, if one was not.

### Group names

The names in `labels` are yours: `"agent": "执行"`, `"model": "Modelo"`,
anything. They must match the label group's name in Linear exactly,
including case. A group that is not in `labels` is not read.

### Label names in each group

| Group | Label names | Built in, no config needed | Map other names with |
| -- | -- | -- | -- |
| `agent` | any | any agent command: `codex`, `claude`, `gemini`, `grok`, `opencode`, `pi`, `aider`, `amp`, `cursor-agent`, `qwen`, … (lowercased, spaces as `-`: `Cursor Agent` → `cursor-agent`) | `"agents": { "克劳德": "claude" }` |
| `model` | any, optionally `<model> · <effort>` | a model id as the agent takes it: `Model › gpt-6.1-sol · low` | `"models"`, see below |
| `effort` | any | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `"efforts": { "高": "high", "极高": { "codex": "xhigh", "claude": "max" } }` |
| `terminal` | any | `Orca`, `Warp`, `WezTerm`, `Windows Terminal` (or `wt`), `Here` (or `Linear`: the window Linear opened) | `"terminals": { "终端窗口": "wt" }` |

Names are matched without regard to case. Without its group, a single label
named like a built-in agent or terminal (`Claude`, `Orca`), or like a mapped
one, works too. A label in the `terminal` group that is neither built in nor
mapped stops the script with an error, so a typo does not start the agent
somewhere you did not mean.

- **agents** maps a label name to the command that starts the agent.
- **terminals** maps a label name to `orca`, `warp`, `wezterm`, `wt` or `here`.
  `"terminal"` and `--terminal` take these names too, and the label names
  (`"terminal": "Windows Terminal"`).
- **models**: a name in it is one of:
  - a **tier**, the shortest to label with: each agent's model for it,
    `"Strong": { "codex": "gpt-6-astra", "claude": "claude-opus-5-5" }`.
    The issue's agent picks its model from the tier; an agent the tier does
    not list starts with its own default. An agent's model can carry its
    effort, `"codex": { "id": "gpt-6-astra", "effort": "medium" }`.
  - the id alone, for any agent: `"Luna": "gpt-6-luna"`.
  - one agent's model: `"Luna": { "id": "gpt-6-luna", "agent": "codex" }`.
    An issue with only that model label starts that agent, and an issue
    labelled for another agent starts it with its own default model.
- **efforts** maps a label word to an effort: one value for every agent
  (`"高": "high"`), or each agent's own, since agents name their levels
  differently (`"极高": { "codex": "xhigh", "claude": "max" }`). An agent
  missing from such a mapping starts with its own default effort.
- **agentArgs** says how each agent takes a model and an effort when it
  starts in a terminal: `{ "model": ["--model", "{model}"], "effort":
  ["--effort", "{effort}"] }`, with `{model}` and `{effort}` filled in.
  Codex is built in (`-m {model}`, `-c model_reasoning_effort={effort}`);
  any other agent without an entry gets `--model {model}` and no effort.
  These change rarely, unlike model ids.
- An `Effort` label works without a `Model` label: the agent keeps its
  default model and gets the effort. Orca takes `--model <id> --effort
  <effort>` for any agent, with the agent's own effort value from `efforts`;
  it needs a model with the effort.

[`nook.example.json`](nook.example.json) is a starting point to copy to
`~/.linear/nook.json`. It starts agents in Linear's own window
(`"terminal": "here"`), which needs nothing else installed; switch it to
`wt`, `warp`, `wezterm` or `orca` if you use one. Its `agentArgs` hold the
flags of Codex, Claude Code, Grok, Gemini CLI, Qwen Code, GitHub Copilot CLI,
Cursor Agent, OpenCode, Pi, Factory Droid, Kimi Code, Aider and Amp; its
`efforts` map five levels for the agents that take an effort; and its four
model tiers name a model for most of them. Change the label names and model
ids to yours.

Notes on the flags, from each tool's command-line reference:

| Agent | Model | Effort |
| -- | -- | -- |
| `codex` | `-m` | `-c model_reasoning_effort=…` |
| `claude` | `--model` | `--effort` (low … max) |
| `grok` | `-m` | `--effort` (values not documented) |
| `gemini` | `-m` (`flash-lite`, `flash`, `pro`, `auto` or an id) | none |
| `qwen` | `-m` | none; set with `/effort` |
| `copilot` | `--model` | none; `effortLevel` in its settings |
| `cursor-agent` | `--model` (`agent models` lists ids) | none |
| `opencode` | `-m provider/model`; `provider/model#high` picks a reasoning variant | none |
| `pi` | `--model provider/id` | `--thinking` (off … max) |
| `droid` | `-m` | `--reasoning-effort` (depends on the model) |
| `kimi` | `-m` | none; `--thinking` only turns thinking on |
| `aider` | `--model` | `--reasoning-effort` |
| `amp` | none: pick a mode in Amp | none |

Agents that take no effort flag start with their own effort, with a note in
Linear's window. Check the flags with each tool's `--help` when one fails;
model ids change often, and agents with many providers (Copilot, Droid,
OpenCode, Pi, Aider) take whichever ids your accounts allow.

### A Chinese setup

```json
{
  "agent": "codex",
  "terminal": "orca",
  "labels": { "agent": "执行", "model": "模型", "effort": "档位", "terminal": "终端" },
  "agents": { "克劳德": "claude", "双子座": "gemini" },
  "terminals": { "终端窗口": "wt", "韦兹": "wezterm", "本窗口": "here" },
  "models": {
    "轻": { "codex": { "id": "gpt-6-luna", "effort": "high" }, "claude": "claude-haiku-5-5" },
    "标准": { "codex": { "id": "gpt-6.1-sol", "effort": "low" }, "claude": "claude-sonnet-5-5" },
    "强": { "codex": { "id": "gpt-6.1-sol", "effort": "high" }, "claude": "claude-opus-5-5" },
    "最强": { "codex": { "id": "gpt-6-astra", "effort": "medium" }, "claude": "claude-opus-5-5" }
  },
  "efforts": { "低": "low", "中": "medium", "高": "high", "极高": { "codex": "xhigh", "claude": "max" } },
  "agentArgs": { "claude": { "model": ["--model", "{model}"], "effort": ["--effort", "{effort}"] } }
}
```

With these labels in Linear: `执行 › 克劳德`, `模型 › 强`, `档位 › 极高`,
`终端 › Orca` starts `claude-opus-5-5` with effort `max` in Orca. With
only `模型 › 强`, Codex starts `gpt-6.1-sol` with effort `high` in Orca.

### Every setting

`args` in `coding-tools.json`:

| Argument | What it does |
| -- | -- |
| `--agent <command>` | the default agent, over `"agent"` |
| `--terminal <name>` | the default terminal, over `"terminal"`: `orca`, `warp`, `wezterm`, `wt` or `here` |
| `--config <file>` | another config file than `~/.linear/nook.json`; it must exist |
| `--agent-label <group>` | the agent label group, over `labels.agent` |
| `--terminal-label <group>` | the terminal label group, over `labels.terminal` |
| `--orca <path>` | Orca's command-line tool, when it is not on PATH |
| `--wezterm <path>` | WezTerm, when it is not on PATH |
| `--open tab\|window` | a tab (the default) or a window of its own, over `"open"`; Windows Terminal and WezTerm |

`nook.json`:

| Key | What it holds |
| -- | -- |
| `agent` | the default agent's command |
| `terminal` | the default terminal |
| `open` | `"tab"` (the default) or `"window"`: where Windows Terminal and WezTerm open the issue |
| `closeLinearWindow` | `false` keeps the window Linear opened after the agent starts in another terminal |
| `orca` | Orca's command-line tool |
| `wezterm` | WezTerm's program |
| `labels` | `{ agent, model, effort, terminal }`: your label group names |
| `agents` | label name → agent command |
| `terminals` | label name → `orca`, `warp`, `wezterm`, `wt` or `here` |
| `models` | label name → tier, id, or one agent's model |
| `efforts` | label word → an effort, or each agent's effort |
| `agentArgs` | agent → how it takes `{model}` and `{effort}` |
| `linear` | `{ apiKey, start, assign }`: move the issue to In Progress (default with a key) and assign it to you (off by default) |

## Use

On an issue, choose **Work on issue → Custom script**. The first time, Linear
asks you to **Choose a directory**: pick the repository's main checkout (the
folder where you ran `nk init`). Nook uses it only to know which repository
the issue belongs to; nothing runs there.

The terminal runs `nk -b <issue branch> <agent> -y -p <Linear's prompt>` in
that folder (`-y` keeps the converted workspace name without asking).
Choosing the same issue again reopens its workspace and starts the agent
without the prompt (with `--terminal orca`, a new agent session in Orca;
earlier sessions stay in Orca's list).

Linear's **Move issue to started status** setting (Settings → Account →
Code & reviews) does not apply to custom scripts, so the script moves the
issue itself when it has a Linear API key: to the team's first started status
(In Progress), unless the issue has already started or ended. Create a
personal API key in Linear's **Settings → Account → Security & access**, then
either put it in the config file as `"linear": { "apiKey": "lin_api_…" }`, or
set it as the `LINEAR_API_KEY` environment variable and add
`"LINEAR_API_KEY"` to `env` in `coding-tools.json` (Linear passes only the
variables listed there). The key stays on your computer; the script sends it
only to `api.linear.app`. `"linear": { "assign": true }` also assigns an
unassigned issue to you; `"start": false` turns the status change off.
After that, Linear's GitHub
integration moves the issue along as the branch and its pull request change,
because the branch name holds the issue identifier. After the
pull request is merged, `nk clean` removes the workspace.

## How it works

- Linear opens a terminal, runs `open-issue.mjs` in it and passes the issue
  through the `LINEAR_*` variables.
- By default the script runs `nk` right there, with the same Node.
- With `--terminal`, the prompt is long Markdown with quotes and semicolons,
  so the script writes it to a temporary file and opens a tab in the chosen
  folder that runs the same script again: Windows Terminal with
  `wt.exe -w 0 new-tab -d <folder>` (`-w new` for a window); Warp, whose `warp://` links cannot run a
  command, through a
  [tab config](https://docs.warp.dev/terminal/windows/tab-configs/) written to
  `%APPDATA%\warp\Warp\data\tab_configs\` and opened with
  `warp://tab_config/<name>` (the tab deletes it when it starts). A
  minimized Warp window stays minimized; WezTerm with
  `wezterm cli --no-auto-start list --format json` to find the open window,
  then `wezterm cli --no-auto-start spawn --window-id <id> --cwd <folder> -- <command>`,
  which adds a tab to it and names it after the issue (outside WezTerm, spawn
  has no current window of its own), or
  `wezterm start --cwd <folder> -- <command>` when no WezTerm window is open,
  with `"open": "window"`, or when the tab could not be opened.
  It then
  closes the window Linear opened.
- `nk` runs with the same Node, never through `cmd.exe`, which would cut a
  multi-line prompt at its first line break.
