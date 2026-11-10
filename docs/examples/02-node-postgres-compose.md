# Node, PostgreSQL and Compose

**outline/outline** at `a518799e9a4d0adf7790c98ae9709a82c65c113f` (corpus
name `outline`). A Node app that needs PostgreSQL and Redis, both started
from a Compose file on fixed host ports, and a `.env` that says where they are.

## The files that matter

`docker-compose.yml`, in full:

```yaml
services:
  redis:
    image: redis
    ports:
      - "127.0.0.1:6379:6379"
  postgres:
    image: postgres
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: outline
```

`.env.sample`, written for running the app inside Docker, names the services:

```
DATABASE_URL=postgres://user:pass@postgres:5432/outline
REDIS_URL=redis://redis:6379
PORT=3000
```

The `test` job of `.github/workflows/ci.yml` has no services of its own. It
calls a local action, `./.github/actions/install`, and the workflow sets
`env:` for the tests, among them
`DATABASE_URL: postgres://postgres:password@localhost:5432/outline_test`.

## What nk init does

`.env` is ignored by git and `.env.sample` is its committed template, so init
starts the shared file `~/nook/shared/outline/.env` from the template and
opens it for you to fill in. Because the Compose file publishes `postgres`
and `redis` on this machine, init points the two addresses at
`127.0.0.1:5432` and `127.0.0.1:6379` and leaves user, password and database
name as they are. The secrets (`SECRET_KEY`, `UTILS_SECRET`) are yours to
fill in, once.

## What nk hooks write makes of it

<!-- corpus: outline -->
```
source: .github/workflows/ci.yml › test + docker-compose.yml
tools: node, corepack
create: corepack enable ; yarn install --immutable
compose start: redis, postgres
compose moves: redis 6379
compose moves: postgres 5432
template addresses: redis:6379 -> 127.0.0.1:6379, postgres:5432 -> 127.0.0.1:5432
left out: env: URL points at local port 3000, which is not a service nk starts; likely the app's own address, so the shared .env keeps its value
```

- The local action is read step by step, as if its steps were in the job:
  that is where `corepack enable` and `yarn install --immutable` come from.
- **compose start**: create runs `docker compose up` for these two services
  in the workspace's own project, `nook-outline-<workspace>`. open starts
  them again. remove runs `docker compose down --volumes` for that project.
- **compose moves**: the file says `6379` and `5432`, which only one
  workspace could have. nk writes a small Compose file into the worktree's
  git folder that moves them to the workspace's first two ports, bound to
  `127.0.0.1`, and lists it in `COMPOSE_FILE` in the workspace's `.env`. A
  `docker compose` you run in the workspace uses it too.
- In the workspace's `.env`, `DATABASE_URL` and `REDIS_URL` then point at
  those two ports, and `COMPOSE_PROJECT_NAME` is the workspace's project.
  `.env.development` and `.env.test`, which this repository commits and
  loads after `.env`, are pointed at the same ports; nk marks them
  `skip-worktree`, so that change never shows in `git status`.
- CI's `env:` values fill gaps only: a key the copied `.env` already has
  keeps its value.

With a first port of 20000, the workspace's `.env` ends up like this:

```
COMPOSE_PROJECT_NAME=nook-outline-try-it
DATABASE_URL=postgres://user:pass@127.0.0.1:20001/outline
REDIS_URL=redis://127.0.0.1:20000
```

## What is left for you

- **CI's database is not the Compose file's.** CI says
  `postgres:password@.../outline_test`; the Compose file creates user `user`,
  password `pass`, database `outline`. With the shared `.env` filled in from
  the template this does not matter, since CI's value is not used. If your
  shared `.env` has no `DATABASE_URL`, CI's value is added and will not log
  in. Keep the template's line.
- **`URL` and `PORT`** are the app's own address. nk leaves them alone, so
  two workspaces that both run the app would both want port 3000. Set them
  from `NOOK_PORT` in create if you run the app in several workspaces.
- **Migrations and seed data.** nk copies only commands that install
  dependencies. `yarn db:migrate` or the like is yours to add to create,
  after you have checked that it uses the workspace's `DATABASE_URL`.

## Try it

```
nk init                        # fill in ~/nook/shared/outline/.env
nk hooks write
nk hooks test
nk -b try-it
cd "$(nk switch try-it)"
docker compose ps              # redis and postgres of nook-outline-try-it
grep -c ':2000[01]' .env       # the two addresses carry the workspace's ports
nk rm try-it
```

It passes when the main checkout's `docker compose ps` is unchanged while the
workspace runs, both sets of containers can be up at once, and after `nk rm`
`docker volume ls` has nothing from `nook-outline-try-it`.

## When it fails

- `corepack is not installed`: Node 25 and later no longer include it;
  `npm install -g corepack`.
- `port is already allocated` when create starts the services: something
  took one of the workspace's ports after nk chose the block. Remove the
  workspace and make it again; nk skips ports something listens on.
- The app in the workspace reaches the main checkout's database: a file nk
  does not know still says `5432`. Search the workspace for the old port,
  outside `.env*`, and set it from the workspace's `.env`.
