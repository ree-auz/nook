# Python with uv

**HumanSignal/label-studio** at `aefbf0b5c4fdf022e846fa831a3ca5404eedf822`
(corpus name `label-studio`). A Django app installed with uv. CI tests it
against a PostgreSQL service container; the repository also has a Compose
file, which builds and runs the whole app.

## The files that matter

The `pgsql-migrations` job of `.github/workflows/test_migrations.yml`:

```yaml
services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: postgres
    options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    ports:
      - 5432:5432
steps:
  - uses: hmarr/debug-action@v3.0.0
  - uses: actions/checkout@v7
  - uses: astral-sh/setup-uv@v10.3.3
    with:
      python-version: '3.14'
  - name: Install OS dependencies
    run: |
      sudo apt-get update
      sudo apt-get install libsasl2-dev python3-dev libldap2-dev libssl-dev libxml2-dev libxslt-dev
  - name: Install dependencies
    run: uv sync --frozen
  - name: Test migrations
    run: uv run --no-sync python label_studio/manage.py makemigrations
```

`docker-compose.yml` has three services: `nginx` and `app`, both built from
the repository, and `db` with the image `pgautoupgrade/pgautoupgrade:17-alpine`.

## What nk hooks write makes of it

<!-- corpus: label-studio -->
```
source: .github/workflows/test_migrations.yml › pgsql-migrations + docker-compose.yml
tools: uv, python@3.14
create: uv sync --frozen
ci service: postgres postgres:17 5432:5432
compose start: -
compose not started: nginx (built from this repository)
compose not started: app (built from this repository)
compose not started: db (pgautoupgrade/pgautoupgrade:17-alpine is not a database or similar service)
left out: hmarr/debug-action@v3.0.0: uses the action hmarr/debug-action@v3.0.0
left out: Install OS dependencies: not a dependency install; CI runs it on a throwaway machine, so check what it touches before adding it
```

- **tools**: `astral-sh/setup-uv` with `python-version` becomes two checks.
  create stops when uv is missing, and only warns when Python is another
  version: `python: CI uses 3.14, this machine has Python 3.12.4`. uv installs the
  Python the project asks for on its own, so the warning is often all there
  is to it.
- **create** runs `uv sync --frozen`, in the workspace. Each workspace gets
  its own `.venv`; uv's cache is shared between them, so the second one is
  quick.
- **CI services win over the Compose file.** The chosen job has a service
  of its own, so nk starts that one and nothing from Compose: the same
  database is not started twice. Nothing in the Compose file would have been
  started here anyway: two services are the app itself, and the third image
  is not one nk knows as a plain database.
- **ci service**: create runs one container, `nook-label-studio-<workspace>-postgres`,
  with CI's image, environment and health check, on the workspace's first
  port bound to `127.0.0.1`, and waits until it is healthy. open starts it
  again. remove deletes it with its volumes.
- The eleven `env:` values of the workflow and the job are added to the
  workspace's `.env` where it does not have them.

## What is left for you

- **Nothing tells the app where the database is.** CI publishes PostgreSQL
  on 5432 and the app's settings default to that, so no `env:` value names
  the port, and nk has nothing to point at the workspace's port. In a
  workspace the database listens on its first port (create prints it:
  `postgres: localhost:20020`). Set the variable the project's settings read
  for the port, in create, from `NOOK_PORT`. This is the one edit this
  repository needs; an agent finds the variable's name in the settings file.
- **`Install OS dependencies`** is `sudo apt-get install ...`. nk never
  copies it: on CI it changes a throwaway machine, here it would change
  yours. Install the libraries once by hand, with your system's package
  manager.
- **`CI=true`** is among the values added to `.env`. Tools read it as "do
  not ask, do not watch". Remove it from the plan in create if you work in
  the workspace by hand.

## Try it

```
nk init
nk hooks write                 # then edit create: the database port, see above
nk hooks test
nk -b try-it
cd "$(nk switch try-it)"
docker ps --filter name=nook-label-studio-try-it
uv run --no-sync python label_studio/manage.py migrate
nk rm try-it
```

It passes when the migration runs against the workspace's container and not
against a PostgreSQL on 5432, a second workspace gets a second container on
another port, and after `nk rm` `docker ps -a` has none with the workspace's name.

## When it fails

- `uv is not installed`: install uv, then `nk rm try-it` and `nk -b try-it`.
- `Service nook-label-studio-try-it-postgres did not become ready`: the
  container exited or stayed unhealthy; `docker logs` on that name says why.
  Most often the image could not be pulled.
- `uv sync` fails building a package: one of the system libraries from
  `Install OS dependencies` is missing.
- The migration changes the wrong database: the port variable is not set, so
  the app fell back to 5432. Stop, and fix create before going on.
