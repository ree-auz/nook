# Go and Rust

**temporalio/temporal** at `47409d6ee4a5f6b84e63d4e352bcb18e84c007c0` (corpus
name `temporal`) and **SeaQL/sea-orm** at
`c5dffaa1fb62f038c58361eca5a4518642c925eb` (corpus name `sea-orm`). In both
languages the build tool fetches dependencies by itself, into a cache that
every folder on the machine shares. A new workspace needs very little.

## The files that matter

temporal, the `testx` job of `.github/workflows/testx.yml`:

```yaml
defaults:
  run:
    working-directory: common/testx
steps:
  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
  - uses: actions/setup-go@4a3601121dd01d1626a1e23e37211e3254c1c06c
    with:
      go-version-file: go.mod
      cache: true
  - name: Check testx go.mod is tidy
    run: go mod tidy -diff
  - name: Test testx
    run: make test
```

sea-orm, the `compile` job of `.github/workflows/rust.yml`:

```yaml
env:
  CARGO_TERM_COLOR: always
  RUSTC_WRAPPER: sccache
  SCCACHE_GHA_ENABLED: true
  RUSTFLAGS: -C debuginfo=0
  CARGO_INCREMENTAL: 0
steps:
  - uses: actions/checkout@v4
  - uses: dtolnay/rust-toolchain@stable
  - uses: actions/cache@v5        # ~/.cargo/registry, ~/.cargo/git
  - uses: mozilla-actions/sccache-action@v0.0.9
  - if: matrix.kind == 'build'
    run: cargo build --no-default-features
```

## What nk hooks write makes of them

<!-- corpus: temporal -->
```
source: .github/workflows/testx.yml › testx
tools: go
create: -
```

<!-- corpus: sea-orm -->
```
source: .github/workflows/rust.yml › compile
tools: cargo
create: -
env: RUSTC_WRAPPER=sccache
env: SCCACHE_GHA_ENABLED=true
left out: mozilla-actions/sccache-action@v0.0.9: uses the action mozilla-actions/sccache-action@v0.0.9
```

- **One hook, one check.** Only `.nook/create.mjs` is written. It checks
  that `go` (with `go version`) or `cargo` is installed and stops with a
  plain message when it is not. There is no open and no remove: nothing is
  started, so nothing has to be started again or cleaned up.
- **No setup step.** Neither job installs anything in a `run:` step before
  its first test or build. Had the job run `go mod download` or
  `cargo fetch`, create would run it too; those two are on nk's list of
  installs.
- **What CI caches is not copied.** `actions/cache` and `cache: true` exist
  because CI starts from an empty machine every time. Yours keeps
  `~/go/pkg/mod` and `~/.cargo/registry` between workspaces already.
- **The other jobs** of both repositories do have databases (sea-orm tests
  against MySQL and PostgreSQL in its `test` jobs). nk picked these jobs by
  its rules and lists the rest in the report under "Other CI jobs not used".
  When the pick is not the job you work on, that list is where to look, and
  the hooks are yours to extend.

## What is left for you

- **sea-orm's `env:` is for CI.** The five values are added to the
  workspace's `.env`. cargo does not read `.env`, so they do nothing by
  themselves. If your shell loads `.env` (direnv, a dotenv plugin),
  `RUSTC_WRAPPER=sccache` makes every build fail on a machine without
  sccache. Either install sccache or delete those values from the plan in
  create. `SCCACHE_GHA_ENABLED` only means something on GitHub's runners.
- **A first build per workspace.** Downloaded dependencies are shared, a
  Rust build's output is not: each workspace has its own `target/`, so the
  first build there is a clean one. A shared `CARGO_TARGET_DIR` would save
  that, but then two workspaces building at once wait on each other's lock;
  nk does not set it.
- **Services for the tests you run.** If you work on sea-orm's database
  tests, the hooks from the `compile` job start no database. Look at the
  job that does (`.github/workflows/rust.yml`, the jobs with `services:`)
  and see [CI services, no Compose file](04-ci-services.md) for what those
  hooks look like.

## Try it

```
nk init
nk hooks write
nk hooks test
nk -b try-it
cd "$(nk switch try-it)"
go build ./...                 # or: cargo build
nk rm try-it
```

It passes when `nk hooks test` passes and the build runs in the workspace.
With nothing started, `nk rm` only has the folder and the branch to deal with.

## When it fails

- `go is not installed` or `cargo is not installed`: install the toolchain,
  then `nk rm try-it` and `nk -b try-it`.
- The workspaces take gigabytes: that is `target/`, once per workspace.
  nk knows it as build output: `nk rm` and `nk clean` delete it with the
  workspace and do not list it among the files that would be lost. `nk clean`
  removes every workspace whose work is merged.
