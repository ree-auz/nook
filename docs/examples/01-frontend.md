# Front end only

**vuetifyjs/vuetify** at `1e0b9b5e737bad0ecb12898370c6d9817a93ad88`
(corpus name `vuetify`). A pnpm monorepo built with Vite, tested in a browser
with Playwright. No database, no service the tests need.

## The files that matter

The `test` job of `.github/workflows/ci.yml`:

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: actions/cache@v5        # ~/.cache/ms-playwright
  - uses: vuetifyjs/setup-action@cb5ac088588387e65433a762de90c0b06d878677
  - run: pnpm exec playwright install chromium
  - run: pnpm run test
    working-directory: ./packages/vuetify
```

`docker-compose.yml` has one service, a web server for the built docs:

```yaml
services:
  docs:
    image: caddy:alpine
    ports:
      - ${PORT:-8095}:80
```

## What nk hooks write makes of it

<!-- corpus: vuetify -->
```
source: .github/workflows/ci.yml › test + docker-compose.yml
tools: -
create: pnpm install --frozen-lockfile ; pnpm exec playwright install chromium
compose start: -
compose port vars: PORT
compose not started: docs (caddy:alpine is not a database or similar service)
left out: vuetifyjs/setup-action@cb5ac088588387e65433a762de90c0b06d878677: uses the action vuetifyjs/setup-action@cb5ac088588387e65433a762de90c0b06d878677
```

- **create** runs two commands. The first is not in the job: the project's
  own setup action installs Node, pnpm and the dependencies, and nk cannot
  read an action from another repository. The next step is
  `pnpm exec ...`, which only works after an install, so nk puts
  `pnpm install --frozen-lockfile` in front of it.
- **tools** is empty for the same reason: nothing in the job names Node or
  pnpm in a way nk can read. When pnpm is missing, the install step stops
  create with a plain message.
- **PORT** gets one of the workspace's ports in its `.env`, so the `docs`
  service can run in two workspaces at once. nk does not start it: it is not
  a database or the like, and it serves a folder that a build has to make first.
- No `open` hook is written, since there is nothing to start again.
  `remove` only runs `docker compose down --volumes` for the workspace's own
  project, in case you started `docs` there.
- The test, the cache and the checkout are left out, as always.

## What is left for you

- **The setup action.** Read it once (it is short) and compare it with the
  two commands in create. If it pins a Node or pnpm version your machine
  should match, add a check, or let `nk hooks write <agent>` do it.
- **The two `secrets.*` values** in the workflow's `env:` (Crowdin tokens)
  are listed as not added. They are for an upload job; a workspace does not
  need them.
- **The dev server's port.** nk moves ports it can see in CI and Compose
  files. A dev server started by hand (`pnpm dev`) takes its default port in
  every workspace, and the second one to start fails or picks another. Pass
  one of the workspace's ports: `NOOK_PORT` is in the hooks' environment, and
  `nk ls` shows each workspace's block.

## Try it

```
nk init
nk hooks write
nk hooks test
nk -b try-it
cd "$(nk switch try-it)"       # or: nks try-it
pnpm --dir packages/vuetify run test
nk rm try-it
```

It passes when `nk hooks test` passes, `node_modules` exists in the workspace
and not only in the main checkout, and the tests run there. With no services,
there is nothing in Docker to look for afterwards.

## When it fails

- `pnpm is not installed` in the first step: install pnpm (`corepack enable`
  or `npm install -g pnpm`), then `nk rm try-it` and `nk -b try-it` again.
- `playwright install` asks for system libraries on Linux: CI runs on a
  machine that has them. Install them once for your machine
  (`pnpm exec playwright install-deps chromium` asks for sudo); do not add
  that to the hook.
- The install is slow in every new workspace: pnpm's store is shared between
  folders already, so only the first one downloads.
