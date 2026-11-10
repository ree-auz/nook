// @ts-check
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";

/** Nook keeps everything in one folder. Only NOOK_HOME can move it. */
export function nookHome(env = process.env) {
  return resolve(env.NOOK_HOME || join(homedir(), "nook"));
}

export function homePaths(home) {
  return {
    home,
    config: join(home, "config.toml"),
    workspaces: join(home, "workspace"),
    shared: join(home, "shared"),
    backup: join(home, "backup"),
    logs: join(home, "logs"),
  };
}

/** Resolves symlinks (macOS /var -> /private/var) when the path exists. */
export function realPath(path) {
  const full = resolve(path);
  try {
    return realpathSync.native(full);
  } catch {
    return full;
  }
}

function comparable(path, platform) {
  const full = realPath(path);
  return platform === "win32" ? full.toLowerCase() : full;
}

export function samePath(a, b, platform = process.platform) {
  return comparable(a, platform) === comparable(b, platform);
}

/** True when `child` is `parent` or anywhere below it. */
export function isInside(child, parent, platform = process.platform) {
  const rel = relative(comparable(parent, platform), comparable(child, platform));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function exists(path) {
  return existsSync(path);
}
