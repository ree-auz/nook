# CI services, no Compose file

**maybe-finance/maybe** at `77b5469832758d1cbee1a940f3012a1ae1c74cd3`
(corpus name `maybe`). A Rails app. The only place that says how to start its
PostgreSQL and Redis is the `services:` block of the CI job. (The repository
has a `compose.example.yml` for self-hosting; nk reads `compose.yml`,
`docker-compose.yml` and their kin, not an example file.)

## The files that matter

The `test` job of `.github/workflows/ci.yml`:

```yaml
env:
  PLAID_CLIENT_ID: foo
  PLAID_SECRET: bar
  DATABASE_URL: postgres://postgres:postgres@localhost:5432
  REDIS_URL: redis://localhost:6379
  RAILS_ENV: test
services:
  postgres:
    image: postgres
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - 5432:5432
    options: --health-cmd="pg_isready" --health-interval=10s --health-timeout=5s --health-retries=3
  redis:
    image: redis
    ports:
      - 6379:6379
    options: --health-cmd="redis-cli ping" --health-interval=10s --health-timeout=5s --health-retries=3
steps:
  - name: Install packages
    run: sudo apt-get update && sudo apt-get install --no-install-recommends -y google-chrome-stable curl libvips postgresql-client libpq-dev
  - uses: actions/checkout@v4
  - uses: ruby/setup-ruby@v1
    with:
      ruby-version: .ruby-version
      bundler-cache: true
  - name: DB setup and smoke test
    run: |
      bin/rails db:create
      bin/rails db:schema:load
      bin/rails db:seed
  - name: Unit and integration tests
    run: bin/rails test
```

`.env.example` has `DB_HOST=localhost` and `DB_PORT=5432`. There are two more
templates, `.env.local.example` and `.env.test.example`.

## What nk init does

Each of the three templates starts a shared file: `.env`, `.env.local` and
`.env.test` in `~/nook/shared/maybe/`. Fill them in once; every new workspace
copies all three.

## What nk hooks write makes of it

<!-- corpus: maybe -->
```
source: .github/workflows/ci.yml › test
tools: ruby@.ruby-version
create: -
ci service: postgres postgres 5432:5432
ci service: redis redis 6379:6379
env: DATABASE_URL=postgres://postgres:postgres@localhost:5432
env: REDIS_URL=redis://localhost:6379
env: RAILS_ENV=test
left out: Install packages: not a dependency install; CI runs it on a throwaway machine, so check what it touches before adding it
```

- **ci service**: create starts two containers,
  `nook-maybe-<workspace>-postgres` and `nook-maybe-<workspace>-redis`, with
  CI's images, environment and health checks, on the workspace's first two
  ports bound to `127.0.0.1`. open starts them again, so they come back
  after a restart of the machine. remove deletes them with their volumes.
- **env**: `DATABASE_URL` and `REDIS_URL` point at CI's own services, so
  they carry those services' user and password. They are written to the
  workspace's `.env` with the workspace's ports, and they replace a value
  the copied file has for the same key. `DB_PORT=5432` from the template is
  moved too. With a first port of 20030:

  ```
  DB_PORT=20030
  DATABASE_URL=postgres://postgres:postgres@localhost:20030
  REDIS_URL=redis://localhost:20031
  ```

- **create has no setup step.** In this job the gems are installed inside
  `ruby/setup-ruby` (`bundler-cache: true`), an action, not a `run:` step,
  and the database is made by `bin/rails db:create`, which is not an
  install. nk copies neither.

## What is left for you

This kind of repository needs the most from you or an agent, since CI does
its setup in ways nk will not copy:

- **`bundle install`**, in create, after the tool check.
- **The database.** `bin/rails db:create db:schema:load` (and `db:seed` if
  you want it), in create, after the services are up. They read
  `DATABASE_URL` from the workspace's `.env`, which names the workspace's
  own container, so this is safe to add; nk leaves it out because it cannot
  know that about a command in general.
- **`RAILS_ENV=test`** comes from the test job. In `.env` it makes the
  workspace a test environment. Delete it from the plan in create unless
  that is what you want.
- **`Install packages`** (`apt-get`): install Chrome, libvips and libpq once
  on your machine.

`nk hooks write <agent>` gives an agent this list, the CI file and the keys
of the shared files (never their values), and has it finish the hooks and
run `nk hooks test` until it passes.

## Try it

```
nk init                        # fill in the three shared files
nk hooks write                 # then add bundle install and the database steps
nk hooks test
nk -b try-it
cd "$(nk switch try-it)"
docker ps --filter name=nook-maybe-try-it
bin/rails test
nk rm try-it
```

It passes when two workspaces run their tests at the same time without
touching each other's database, and `nk rm` leaves no container or volume
with the workspace's name. Removing is also how you start over: `nk rm`,
then `nk -b` gives an empty database again.

## When it fails

- `ruby: CI uses .ruby-version, this machine has ruby 3.3.4 (...)`: a warning.
  The job names a file, not a version, so nk cannot compare; your version
  manager reads the same file.
- `Service nook-maybe-try-it-postgres did not become ready`: `docker logs`
  on that name. An image that fails its health check here but not on CI is
  usually an older local copy; `docker pull postgres`.
- A container with that name already exists: an earlier create was
  interrupted. `nk rm try-it` removes it; `nk doctor --workspace try-it`
  shows what is there.
- `nk rm` reports that the remove hook failed: nothing was deleted. Fix the
  cause and run it again.
