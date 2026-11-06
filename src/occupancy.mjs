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
    } catch {
      inaccessible++;
    }
  }
  return { processes: [...found.values()], inaccessible };
}

/** Parses `lsof -d cwd -F pcfn` output and keeps working directories below `root`. */
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
      fd === "cwd" && add(found, pid, name || String(pid), "working directory");
  }
  return [...found.values()];
}

function lsofScan(root, platform) {
  const lsof = which("lsof") ?? (["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => which(p)) || null);
  if (!lsof) return { processes: [], unsupported: "lsof not found" };
  const result = spawnSync(lsof, ["-n", "-P", "-w", "-d", "cwd", "-F", "pcfn"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
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
 * Processes whose working directory is inside `root`: terminals, dev servers
 * and agents started there. Like worktrunk's `--reap`, open files are not
 * scanned: that is slow and editors usually keep their directory elsewhere.
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

/**
 * Ends the processes and their children. Windows uses taskkill /T /F; macOS and
 * Linux send SIGTERM, then SIGKILL to what is still running after 3 seconds.
 */
export async function stopProcesses(processes, platform = process.platform) {
  if (platform === "win32") {
    for (const { pid } of processes) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const { pid } of processes) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* Already gone. */
    }
  }
  for (let waited = 0; waited < 3000 && processes.some(({ pid }) => alive(pid)); waited += 100)
    await new Promise((done) => setTimeout(done, 100));
  for (const { pid } of processes) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already gone. */
    }
  }
}
