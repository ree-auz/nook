import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { makeRepo, nk, sh, tempDir, write } from "./helpers.mjs";

// A stand-in for the docker CLI: volumes and containers kept in a JSON file.
const fakeDocker = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_DOCKER_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { volumes: [], containers: [] };
const args = process.argv.slice(2);
const [kind, verb] = args;
const has = (name) => state.containers.some((c) => c.name === name);
const print = (lines) => lines.length && console.log(lines.join("\\n"));
if (kind === "volume" && verb === "create") state.volumes.push(args[2]);
else if (kind === "volume" && verb === "rm") state.volumes = state.volumes.filter((v) => v !== args.at(-1));
else if (kind === "volume" && verb === "ls") print(state.volumes);
else if (kind === "run") {
  const name = args[args.indexOf("--name") + 1];
  if (has(name)) process.exitCode = 125;
  else state.containers.push({ name, args });
} else if (kind === "container" && verb === "inspect") process.exitCode = has(args[2]) ? 0 : 1;
else if (kind === "inspect") has(args.at(-1)) ? console.log("healthy") : (process.exitCode = 1);
else if (kind === "rm") state.containers = state.containers.filter((c) => c.name !== args.at(-1));
else if (kind === "container" && verb === "ls" && !args.some((a) => a.includes("working_dir"))) print(state.containers.map((c) => c.name + "\\t" + c.name));
else if (kind === "compose") {
  const project = args[args.indexOf("--project-name") + 1];
  const rest = args.slice(args.indexOf("--project-name") + 2);
  if (rest[0] === "up") {
    for (const service of rest.filter((a) => !a.startsWith("-")).slice(1)) {
      const name = project + "-" + service + "-1";
      if (!has(name)) state.containers.push({ name, args, env: { API_PORT: process.env.API_PORT } });
    }
  } else if (rest[0] === "down") state.containers = state.containers.filter((c) => !c.name.startsWith(project + "-"));
}
writeFileSync(file, JSON.stringify(state));
`;

const dockerHook = (verb) =>
  `import { spawnSync } from "node:child_process";\nconst r = spawnSync("docker volume ${verb} " + process.env.NOOK_WORKSPACE + "-db", { stdio: "inherit", shell: true });\nprocess.exit(r.status ?? 1);\n`;

function setup(t, hooks) {
  const root = tempDir(t);
  const home = join(root, "nook-home");
  const bin = join(root, "bin");
  write(bin, {
    "docker.mjs": fakeDocker,
    docker: `#!/bin/sh\nexec node "$(dirname "$0")/docker.mjs" "$@"\n`,
    "docker.cmd": '@echo off\r\nnode "%~dp0docker.mjs" %*\r\n',
  });
  if (process.platform !== "win32") chmodSync(join(bin, "docker"), 0o755);
  const repo = makeRepo(join(root, "demo"), hooks);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: join(root, "docker.json") };
  const run = (args) => nk(args, { cwd: repo, home, env });
  assert.equal(run(["init", "--yes", "--allow-hooks"]).status, 0);
  return { root, home, repo, run, state: () => JSON.parse(readFileSync(env.FAKE_DOCKER_STATE, "utf8")) };
}

test("check passes when remove undoes create, and records the hooks", (t) => {
  const { home, run, state } = setup(t, { ".nook/create.mjs": dockerHook("create"), ".nook/remove.mjs": dockerHook("rm") });
  assert.match(run(["doctor"]).out, /not tested since changed/);
  assert.match(run(["hooks"]).out, /create .nook\/create\.mjs {2}allowed, not tested since it changed/);
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /The hooks passed/);
  assert.deepEqual(state().volumes, []);
  const config = parse(readFileSync(join(home, "config.toml"), "utf8"));
  assert.deepEqual(Object.keys(config.repos.demo.checked).sort(), ["create.mjs", "remove.mjs"]);
  assert.doesNotMatch(run(["doctor"]).out, /not tested since changed/);
  assert.match(run(["hooks"]).out, /remove .nook\/remove\.mjs {2}allowed, tested/);
  assert.ok(!existsSync(join(home, "workspace", "demo", "nook-hooks-test")));
});

test("check fails and names what remove left behind", (t) => {
  const { run } = setup(t, { ".nook/create.mjs": dockerHook("create") });
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /remove left a Docker volume: nook-hooks-test-db/);
});

test("check fails when open cannot run twice", (t) => {
  const { run } = setup(t, {
    ".nook/open.mjs": 'import { writeFileSync } from "node:fs";\nwriteFileSync("started.txt", "", { flag: "wx" });\n',
    ".gitignore": "started.txt\n",
  });
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /open, run a second time, failed/);
});

test("check runs the hooks of the folder it runs in, such as an agent's branch", (t) => {
  const { root, home, run } = setup(t, {});
  assert.equal(run(["-b", "setup-hooks"]).status, 0);
  const ws = join(home, "workspace", "demo", "setup-hooks");
  write(ws, { ".nook/create.mjs": "console.log('branch hook ran')\n" });
  sh("git", ["add", "-A"], ws);
  sh("git", ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "hooks"], ws);
  const r = nk(["hooks", "test"], { cwd: ws, home, env: { PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: join(root, "docker.json") } });
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /branch hook ran/);
});

const workflow = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ["5432:5432"]
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/app
      DB_PORT: 5432
      API_TOKEN: \${{ secrets.TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install --no-audit --no-fund
      - run: npm test
      - run: node -e "console.log('ci cleanup')"
        if: always()
`;

// Generated hooks call docker without a shell, as a real docker.exe needs. Windows
// cannot run the stand-in docker.cmd that way, so there the CI has no services.
const services = process.platform !== "win32";
const ciWorkflow = services ? workflow : workflow.replace(/^    services:[^]*?(?=^    env:)/m, "");

test("hooks write turns CI into hooks that pass hooks test; a CI change then stops nk -b", (t) => {
  const workflow = ciWorkflow;
  const { home, repo, run, state } = setup(t, { ".github/workflows/ci.yml": workflow, "package.json": '{"name":"demo","private":true}\n', ".gitignore": "package-lock.json\nnode_modules\n" });
  let r = run(["hooks", "write"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, services ? /Wrote \.nook\/create\.mjs, \.nook\/open\.mjs, \.nook\/remove\.mjs from \.github\/workflows\/ci\.yml \(job test\)/ : /Wrote \.nook\/create\.mjs from/);
  assert.match(r.err, /API_TOKEN comes from a CI expression/);
  assert.match(r.err, /Left out 2 CI-only steps/);
  assert.match(r.err, /Not added; review these[^]*ci cleanup[^]*not a dependency install/);

  r = run(["hooks", "test"]);
  assert.equal(r.status, 0, r.all);
  if (services) assert.deepEqual(state().containers, [], "remove deleted the service container");

  assert.equal(run(["init", "--yes", "--allow-hooks"]).status, 0, "allow the new hooks");
  // A template's own database user would not match the container started from CI's service.
  write(join(home, "shared", "demo"), { ".env": "DATABASE_URL=postgres://user:pass@localhost:5432/app\nKEEP=1\n" });
  r = run(["-b", "feat"]);
  assert.equal(r.status, 0, r.all);
  const ws = join(home, "workspace", "demo", "feat");
  assert.ok(existsSync(join(ws, "package-lock.json")), "create ran npm install in the workspace");
  // The repository does not ignore .env. With services, create writes one and adds it to git's local
  // exclude list, so it stays out of git status (and later workspaces get the shared copy).
  if (services) {
    assert.match(readFileSync(join(ws, ".env"), "utf8"), /^KEEP=1$/m);
    assert.equal(sh("git", ["status", "--porcelain", "--untracked-files=all"], ws).trim(), "");
  }
  const port = parse(readFileSync(join(home, "config.toml"), "utf8")).repos.demo.workspaces.feat.port;
  if (services) {
    assert.match(r.all, /Set DATABASE_URL in \.env from CI/);
    const env = readFileSync(join(ws, ".env"), "utf8");
    assert.match(env, new RegExp(`^DATABASE_URL=postgres://postgres:postgres@localhost:${port}/app$`, "m"), "CI's user and password, this workspace's port");
    assert.doesNotMatch(env, /user:pass/);
    assert.match(env, new RegExp(`^DB_PORT=${port}$`, "m"), "a bare port CI sets moves too (invoiceninja's DB_PORT)");
    assert.ok(state().containers[0].args.join(" ").includes(`-p 127.0.0.1:${port}:5432`));
  }

  write(repo, { ".github/workflows/ci.yml": workflow.replace("node-version: 22", "node-version: 24") });
  sh("git", ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qam", "newer postgres"], repo);
  r = run(["-b", "second"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /the CI configuration changed since nk hooks test last passed/);
  assert.equal(run(["-b", "second", "--untested"]).status, 0);
});

test("generated hooks check go with go version, and tell a broken tool from a missing one", { skip: process.platform === "win32" && "a stand-in go needs sh" }, (t) => {
  const goWorkflow = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-go@v5\n        with: { go-version: '1.25' }\n      - run: go test ./...\n";
  const { root, run } = setup(t, { ".github/workflows/ci.yml": goWorkflow });
  // Like the real go: "version" works, --version is an unknown flag.
  write(join(root, "bin"), { go: '#!/bin/sh\nif [ "$1" = version ]; then echo "go version go1.25.3 linux/amd64"; exit 0; fi\necho "flag provided but not defined: -version" >&2; exit 2\n' });
  chmodSync(join(root, "bin", "go"), 0o755);
  assert.equal(run(["hooks", "write"]).status, 0);
  let r = run(["hooks", "test"]);
  assert.equal(r.status, 0, r.all);
  assert.doesNotMatch(r.all, /go is not installed/);

  write(join(root, "bin"), { go: "#!/bin/sh\necho 'go: cannot find GOROOT' >&2\nexit 1\n" });
  r = run(["hooks", "test"]);
  assert.equal(r.status, 1);
  assert.match(r.all, /go version failed: go: cannot find GOROOT/);
});

test("hooks write never replaces hooks written by hand", (t) => {
  const { run } = setup(t, { ".github/workflows/ci.yml": ciWorkflow, ".nook/create.mjs": "console.log('mine')\n" });
  const r = run(["hooks", "write"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /already has hooks written by hand: create\.mjs/);
});

test("hooks write <agent> writes the hooks and starts the agent in the folder it runs in", (t) => {
  const { home, repo, run } = setup(t, { ".github/workflows/ci.yml": ciWorkflow, ".gitignore": "agent.json\n" });
  const agent = "require('fs').writeFileSync('agent.json', JSON.stringify({ prompt: process.argv.at(-1), hooks: require('fs').existsSync('.nook/create.mjs') }))";
  const r = run(["hooks", "write", "node", "--", "-e", agent]);
  assert.equal(r.status, 0, r.all);
  const seen = JSON.parse(readFileSync(join(repo, "agent.json"), "utf8"));
  assert.ok(seen.hooks, "the agent starts after the hooks are written");
  assert.match(seen.prompt, /nk already wrote \.nook\/create\.mjs/);
  assert.match(seen.prompt, /API_TOKEN comes from a CI expression/);
  assert.ok(!existsSync(join(home, "workspace", "demo", "nook-hooks")), "no workspace is created");
});

const composeFile = `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set it in .env}
  cache:
    image: redis:7
    container_name: demo-cache
    ports: ["6379:6379"]
  api:
    build: .
    ports: ["127.0.0.1:\${API_PORT:-3001}:3001"]
volumes:
  pgdata: { name: demo-pgdata }
`;

test("hooks write starts the repository's Compose services in each workspace's own project, on its own ports", { skip: !services && "generated hooks call docker without a shell" }, (t) => {
  const { home, repo, run, state } = setup(t, { "docker-compose.yml": composeFile, ".gitignore": ".env\n" });
  // The shared .env every workspace gets, here with the main checkout's own project name in it.
  // It also points the app at the main checkout's cache, on the port the Compose file publishes.
  write(join(home, "shared", "demo"), { ".env": "POSTGRES_PASSWORD=dev\nCOMPOSE_PROJECT_NAME=demo\nCACHE_URL=redis://localhost:6379/0\nCACHE_PORT=6379\nINSIDE=redis://cache:6379\n" });
  let r = run(["hooks", "write"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /Wrote \.nook\/create\.mjs, \.nook\/open\.mjs, \.nook\/remove\.mjs from docker-compose\.yml/);
  assert.match(r.err, /Starts from docker-compose\.yml in each workspace's own Compose project: db/);
  assert.match(r.err, /own ports in \.env: API_PORT/);
  assert.match(r.err, /api \(built from this repository\)/);
  assert.match(r.err, /Moves fixed host ports to each workspace's own: cache 6379/);

  r = run(["hooks", "test"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(state().containers, [], "remove took the Compose project down");

  assert.equal(run(["init", "--yes", "--allow-hooks"]).status, 0, "allow the new hooks");
  r = run(["-b", "feat"]);
  assert.equal(r.status, 0, r.all);
  const ws = join(home, "workspace", "demo", "feat");
  const port = parse(readFileSync(join(home, "config.toml"), "utf8")).repos.demo.workspaces.feat.port;
  const env = readFileSync(join(ws, ".env"), "utf8");
  assert.match(env, /^COMPOSE_PROJECT_NAME=nook-demo-feat$/m, "never the main checkout's project");
  assert.doesNotMatch(env, /COMPOSE_PROJECT_NAME=demo/);
  assert.match(env, new RegExp(`^CACHE_URL=redis://localhost:${port + 1}/0$`, "m"), "the app reaches this workspace's cache, not the main checkout's");
  assert.match(env, new RegExp(`^CACHE_PORT=${port + 1}$`, "m"));
  assert.match(env, /^INSIDE=redis:\/\/cache:6379$/m, "an address inside Docker stays");
  assert.match(env, new RegExp(`^API_PORT=${port}$`, "m"));
  assert.deepEqual(state().containers.map((c) => c.name), ["nook-demo-feat-db-1", "nook-demo-feat-cache-1"]);
  // cache's fixed 6379 moves to this workspace's port, in a file outside the working tree.
  const moved = join(repo, ".git", "worktrees", "feat", "nook-compose.yaml");
  // Its fixed container name gets this workspace's prefix, so a second workspace can start one too (plane).
  assert.match(readFileSync(moved, "utf8"), new RegExp(`"cache":\\n    container_name: "nook-demo-feat-cache"\\n    ports: !override\\n      - "127\\.0\\.0\\.1:${port + 1}:6379"`));
  assert.match(readFileSync(moved, "utf8"), /^volumes:\n  "pgdata":\n    name: "nook-demo-feat_pgdata"$/m, "a volume with a fixed name gets this workspace's own: no shared data");
  assert.ok(env.includes(`COMPOSE_FILE=${join(ws, "docker-compose.yml")}${delimiter}${moved}`), "docker compose run by hand there uses it too");
  assert.equal(sh("git", ["status", "--porcelain"], ws), "", "nothing new in the working tree");

  r = run(["rm", "feat", "-y"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(state().containers, []);
});

test("a generated create stops when the Compose file needs a value .env does not have", { skip: !services && "generated hooks call docker without a shell" }, (t) => {
  const { run, state } = setup(t, { "docker-compose.yml": composeFile });
  assert.equal(run(["hooks", "write"]).status, 0);
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /needs POSTGRES_PASSWORD in \.env/);
  assert.deepEqual(state().containers ?? [], []);
});

test("env files the repository commits get the workspace's ports without showing up in git", { skip: !services && "generated hooks call docker without a shell" }, (t) => {
  const { home, run } = setup(t, {
    "docker-compose.yml": composeFile,
    ".env": "POSTGRES_PASSWORD=changethis\nCACHE_URL=redis://localhost:6379/0\n",
    // Loaded after .env in development and tests, so it must point at the workspace too.
    ".env.development": "# dev\r\nCACHE_URL=redis://127.0.0.1:6379\r\nLOG_LEVEL=debug\r\n",
    ".env.sample": "CACHE_URL=redis://localhost:6379\n",
  });
  assert.equal(run(["hooks", "write"]).status, 0);
  let r = run(["hooks", "test"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /\.env is committed in this repository/);

  assert.equal(run(["init", "--yes", "--allow-hooks"]).status, 0, "allow the new hooks");
  assert.equal(run(["-b", "feat"]).status, 0);
  const ws = join(home, "workspace", "demo", "feat");
  assert.match(readFileSync(join(ws, ".env"), "utf8"), /^COMPOSE_PROJECT_NAME=nook-demo-feat$/m);
  const port = parse(readFileSync(join(home, "config.toml"), "utf8")).repos.demo.workspaces.feat.port;
  assert.equal(readFileSync(join(ws, ".env.development"), "utf8"), `# dev\r\nCACHE_URL=redis://127.0.0.1:${port + 1}\r\nLOG_LEVEL=debug\r\n`, "only the address changes, line endings too stay");
  assert.equal(readFileSync(join(ws, ".env.sample"), "utf8"), "CACHE_URL=redis://localhost:6379\n", "a template stays as it is");
  assert.equal(sh("git", ["status", "--porcelain"], ws), "", "the workspace's ports never reach a commit");
  r = run(["rm", "feat", "-y"]);
  assert.equal(r.status, 0, r.all);
});

test("a CI service on an odd host port still moves its usual port, which .env names", { skip: !services && "generated hooks call docker without a shell" }, (t) => {
  // invoiceninja: CI publishes mariadb's 3306 on 32768, .env.example says DB_PORT=3306.
  const ci = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    services:\n      mariadb: { image: 'mariadb:10.6', ports: ['32768:3306'] }\n    steps:\n      - run: npm test\n";
  const { home, run } = setup(t, { ".github/workflows/ci.yml": ci, ".gitignore": ".env\n" });
  write(join(home, "shared", "demo"), { ".env": "DB_PORT=3306\nDB_URL=mysql://root@127.0.0.1:3306/app\n" });
  assert.equal(run(["hooks", "write"]).status, 0);
  assert.equal(run(["init", "--yes", "--allow-hooks"]).status, 0, "allow the new hooks");
  const r = run(["-b", "feat"]);
  assert.equal(r.status, 0, r.all);
  const port = parse(readFileSync(join(home, "config.toml"), "utf8")).repos.demo.workspaces.feat.port;
  const env = readFileSync(join(home, "workspace", "demo", "feat", ".env"), "utf8");
  assert.match(env, new RegExp(`^DB_PORT=${port}$`, "m"));
  assert.match(env, new RegExp(`^DB_URL=mysql://root@127\\.0\\.0\\.1:${port}/app$`, "m"));
});

test("check fails when the hooks change files git tracks", (t) => {
  const { run } = setup(t, { ".nook/create.mjs": 'import { appendFileSync } from "node:fs";\nappendFileSync("README.md", "changed\\n");\n' });
  const r = run(["hooks", "test"]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /changed files in the workspace that git would commit/);
  assert.match(r.all, /M README\.md/);
});
