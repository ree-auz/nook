# A large mixed repository

**makeplane/plane** at `618d0eb74658329a6f6e92434ac54231422c5b96` (corpus
name `plane`): thirteen Compose services, every one with a fixed
`container_name`, several `.env` files, and a CI job that expects a database
nobody starts for it. And **fastapi/full-stack-fastapi-template** at
`aabb90126964a164e02aff39e7c385bb0598236d` (corpus name `fastapi-template`),
for two things plane does not have: a Compose override file and a value
Compose requires.

## plane: the files that matter

`docker-compose.yml`, shortened to what matters here:

```yaml
services:
  api:
    container_name: api
    build: ./apps/api
    env_file: ./apps/api/.env
    depends_on: [plane-db, plane-redis]
  plane-db:
    container_name: plane-db
    image: postgres:15.7-alpine
    env_file: .env
    volumes:
      - pgdata:/var/lib/postgresql/data
  plane-redis:
    container_name: plane-redis
    image: valkey/valkey:7.2.11-alpine
  plane-mq:
    container_name: plane-mq
    image: rabbitmq:3.13.6-management-alpine
  proxy:
    container_name: proxy
    build: ./apps/proxy
    ports:
      - ${LISTEN_HTTP_PORT}:80
      - ${LISTEN_HTTPS_PORT}:443
volumes:
  pgdata:
  redisdata:
```

The root `.env.example` is written for running inside Docker:
`REDIS_HOST="plane-redis"`, `RABBITMQ_HOST="plane-mq"`, `LISTEN_HTTP_PORT=80`.
The `migration-check` job of `.github/workflows/migration-check.yml` has no
`services:`, yet sets `DATABASE_URL: postgresql://ci:ci@127.0.0.1:5432/ci`
and `REDIS_URL: redis://127.0.0.1:6379/0`, and installs with
`uv sync --locked --no-default-groups --group production` in `apps/api`.

## What nk hooks write makes of plane

<!-- corpus: plane -->
```
source: .github/workflows/migration-check.yml › migration-check + docker-compose.yml
tools: uv, python@3.12.12
create: uv sync --locked --no-default-groups --group production
compose start: plane-db, plane-redis, plane-mq
compose port vars: LISTEN_HTTP_PORT, LISTEN_HTTPS_PORT
compose not started: api (built from this repository)
compose not started: proxy (built from this repository)
left out: env: REDIS_URL points at local port 6379, which is not a service nk starts; on this machine it may be a real database
left out: env: DATABASE_URL points at local port 5432, which is not a service nk starts; on this machine it may be a real database
```

- **Three of thirteen services are started**: the database, the cache and
  the queue, used as they are. The ten others are the app itself (built from
  the repository) or an image nk does not know as a plain service; they are
  listed, and yours to start when you need them.
- **Fixed container names.** `container_name: plane-db` can exist once on a
  machine, so a second workspace, or the main checkout, could never start
  it. nk writes a small Compose file into the worktree's git folder that
  gives every one of the thirteen its own name, and lists it in
  `COMPOSE_FILE` in the workspace's `.env`:

  ```yaml
  # Written by nk: this workspace's own host ports, container names, networks and volumes.
  services:
    "plane-db":
      container_name: "nook-plane-try-it-plane-db"
    "proxy":
      container_name: "nook-plane-try-it-proxy"
  ```

  The services you start yourself are in it too, so `docker compose up api`
  in the workspace is safe.
- **Volumes and networks.** `pgdata` and the default network have no fixed
  `name:`, so Compose already names them after the project, and the project
  is the workspace's: `COMPOSE_PROJECT_NAME=nook-plane-try-it`. Each
  workspace has its own data. A volume or network with a fixed `name:` would
  get the workspace's name in the same file; an `external` one is shared on
  purpose and left alone.
- **Port variables.** `LISTEN_HTTP_PORT` and `LISTEN_HTTPS_PORT` get two of
  the workspace's ports in its `.env`, replacing 80 and 443, so the proxy
  can run in several workspaces.
- **Two values are refused.** CI's `DATABASE_URL` and `REDIS_URL` point at
  5432 and 6379 on localhost, and the job has no service there. On CI
  nothing listens. On your machine it may be a real database, so nk does
  not put them in `.env`.
- **create** runs the install in `apps/api`, where the job runs it.

## What is left for you with plane

- **The database has no door to the host.** `plane-db`, `plane-redis` and
  `plane-mq` publish no ports in this file. Containers of the same project
  reach them by name, which is how the file is meant to be used, and the
  root `.env` (`REDIS_HOST="plane-redis"`) is right for that. A process on
  your machine (`uv run python manage.py ...`) cannot reach them. Choose
  one: run the app in the workspace's Compose project, or use the
  repository's `docker-compose-local.yml`, which publishes `5432:5432` and
  `6379:6379`. nk reads `docker-compose.yml` here; to have it read the other
  file, write the hooks from it by hand or with an agent, and nk will move
  those fixed ports as in [the outline example](02-node-postgres-compose.md).
- **`.env` files in subfolders.** The `api` service reads
  `./apps/api/.env`. `nk init` starts a shared file from every committed
  template of an ignored file, in any folder, so `apps/api/.env` is copied
  into each workspace. But create points only the env files at the root at
  the workspace's ports. An address in `apps/api/.env` is yours to check.
- **CI's migration check is not a setup.** `manage.py check` and
  `makemigrations --check` are tests and are left out. Running real
  migrations is yours to add, once the app can reach its database.

## fastapi-template: an override file and a required value

`compose.yml` cannot be used alone for development; `compose.override.yml`
adds the ports and the mail catcher, as `docker compose` reads them together:

```yaml
# compose.yml
services:
  db:
    image: postgres:18
    environment:
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?Variable not set}
# compose.override.yml
services:
  db:
    ports:
      - "5432:5432"
  mailpit:
    image: axllent/mailpit
    ports:
      - "8025:8025"
      - "1025:1025"
```

<!-- corpus: fastapi-template -->
```
source: .github/workflows/playwright.yml › test-playwright + compose.yml + compose.override.yml
tools: bun@1.3.12, python, uv@latest-known
create: uv sync ; bun ci
compose start: db, mailpit
compose moves: db 5432
compose moves: mailpit 8025 1025
compose needs: POSTGRES_PASSWORD
compose not started: backend (built from this repository)
left out: bash scripts/generate-client.sh: not a dependency install; CI runs it on a throwaway machine, so check what it touches before adding it
```

- **Both files are read**, and `COMPOSE_FILE` in the workspace's `.env`
  lists both, then nk's own.
- **compose needs**: before starting anything, create looks for
  `POSTGRES_PASSWORD` in the workspace's `.env`. Without it, it stops:
  `compose.yml + compose.override.yml needs POSTGRES_PASSWORD in .env. Set
  it once in the shared .env (nk copies it into every workspace), then
  create the workspace again.` Compose's own error would be "Variable not
  set"; this one says where to fix it.
- **Three fixed ports move**, and the values in `.env` that point at them
  move with them. With a first port of 20050:

  ```
  SMTP_PORT=20052
  DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@localhost:20050/app
  ```

- **Two installs in two folders**: `uv sync` in `backend`, `bun ci` in
  `frontend`, where the job runs them.
- `scripts/generate-client.sh` is a script, so it is listed and not run.
  Read it; if it only writes files inside the folder, add it to create.

## Try it

```
nk init                        # fill in the shared .env files; set required values
nk hooks write
nk hooks test
nk -b try-it
cd "$(nk switch try-it)"
docker compose ps              # only this workspace's project
docker compose config --services
docker volume ls --filter name=nook-plane-try-it
nk rm try-it
```

Do not run a bare `docker compose config`: it prints every value from `.env`.

It passes when the main checkout's own `docker compose up` still works while
the workspace's services run (with fixed container names it would not,
before), each has its own volume, and after `nk rm` no container, volume or
network of `nook-<repo>-try-it` is left.

## When it fails

- `... needs POSTGRES_PASSWORD in .env`: see above. Set it in
  `~/nook/shared/<repo>/.env`, then `nk rm try-it` and `nk -b try-it`.
- `Conflict. The container name "/plane-db" is already in use`: a
  `docker compose` ran without the workspace's `.env`, from another folder
  or with `--env-file`. Run it in the workspace folder, where
  `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME` come from `.env`.
- More services than ports: a workspace has ten. The services that did not
  get one are not started, and the report lists them.
- `nk hooks test` says remove left a volume behind: something created it
  outside the workspace's project, usually a script with its own
  `docker` command. Make remove undo it, or keep that step out of create.
