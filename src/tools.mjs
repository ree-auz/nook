import spawn from "cross-spawn";
import { which } from "./agents.mjs";

function run(command, args) {
  const result = spawn.sync(command, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
  return { ok: !result.error && result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** gh and docker are optional helpers; this only reports their state. */
export function toolStatus(env = process.env) {
  const status = {};
  const gh = which("gh", env);
  status.gh = !gh ? "not installed" : run(gh, ["auth", "status"]).ok ? "logged in" : "not logged in";
  const docker = which("docker", env);
  status.docker = !docker ? "not installed" : run(docker, ["info", "--format", "{{.ServerVersion}}"]).ok ? "running" : "not running";
  return status;
}

export function gitVersion() {
  const result = run("git", ["--version"]);
  const match = /(\d+)\.(\d+)/.exec(result.out);
  return result.ok && match ? { text: result.out, major: Number(match[1]), minor: Number(match[2]) } : null;
}
