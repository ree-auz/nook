import { spawnSync } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { which } from "./agents.mjs";
import { isInside, realPath } from "./home.mjs";

function add(found, pid, name, reason) {
  const current = found.get(pid);
  if (current) {
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
  } else found.set(pid, { pid, name, reasons: [reason] });
}

function linuxScan(root) {
  const found = new Map();
  let inaccessible = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let name = entry;
    try {
      name = readlinkSync(`/proc/${entry}/exe`).split("/").pop();
    } catch {
      /* Name is best effort. */
    }
    try {
      if (isInside(readlinkSync(`/proc/${entry}/cwd`), root, "linux")) add(found, pid, name, "working directory");
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        try {
          const target = readlinkSync(`/proc/${entry}/fd/${fd}`);
          if (target.startsWith("/") && isInside(target, root, "linux")) add(found, pid, name, "open file");
        } catch {
          /* A descriptor can close while we look. */
        }
      }
    } catch {
      inaccessible++;
    }
  }
  return { processes: [...found.values()], inaccessible };
}

/** Parses `lsof -F pcfn` output and keeps entries below `root`. */
export function parseLsof(text, root, platform = "darwin") {
  const found = new Map();
  let pid = 0;
  let name = "";
  let fd = "";
  for (const line of text.split(/\r?\n/)) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      name = "";
    } else if (tag === "c") name = value;
    else if (tag === "f") fd = value;
    else if (tag === "n" && pid && pid !== process.pid && value.startsWith("/") && isInside(value, root, platform))
      add(found, pid, name || String(pid), fd === "cwd" ? "working directory" : "open file");
  }
  return [...found.values()];
}

function lsofScan(root, platform) {
  const lsof = which("lsof") ?? (["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => which(p)) || null);
  if (!lsof) return { processes: [], unsupported: "lsof not found" };
  const result = spawnSync(lsof, ["-n", "-P", "-w", "-F", "pcfn"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error) return { processes: [], unsupported: result.error.message };
  return { processes: parseLsof(result.stdout, root, platform) };
}

function windowsScan(root) {
  const script = fileURLToPath(new URL("./occupancy-windows.ps1", import.meta.url));
  const shell = which("pwsh") ?? "powershell.exe";
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Root", root], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    return { processes: [], unsupported: (result.stderr || result.error?.message || "scan failed").trim().split(/\r?\n/)[0] };
  const data = JSON.parse(result.stdout);
  const list = Array.isArray(data.processes) ? data.processes : data.processes ? [data.processes] : [];
  return {
    processes: list.filter((item) => item.pid !== process.pid).map((item) => ({ pid: item.pid, name: item.name, reasons: [].concat(item.reasons) })),
    inaccessible: data.inaccessible,
  };
}

/**
 * Processes whose working directory is inside `root` or that hold a file
 * below it. Windows reads each process's current directory and asks Restart
 * Manager about open files; macOS and Linux use lsof and /proc.
 */
export function findOccupants(root, platform = process.platform) {
  const target = realPath(root);
  if (platform === "linux") return linuxScan(target);
  if (platform === "win32") return windowsScan(target);
  return lsofScan(target, platform);
}

export function describeOccupants(processes) {
  return processes.map((item) => `  ${item.name} (PID ${item.pid}): ${item.reasons.join(", ")}`).join("\n");
}
