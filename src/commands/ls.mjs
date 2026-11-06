import { exists } from "../home.mjs";
import { gitTry } from "../git.mjs";

function changes(path) {
  if (!exists(path)) return "missing";
  const status = gitTry(["status", "--porcelain", "--untracked-files=normal"], { cwd: path });
  if (!status.ok) return "unknown";
  const count = status.out ? status.out.split(/\r?\n/).length : 0;
  return count ? `${count} changed` : "clean";
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ")).join("\n");
}

/** nk ls */
export function listWorkspaces(ctx, { repo: repoFlag } = {}) {
  const rows = [["NAME", "REPO", "PORTS", "CHANGES", "PATH"]];
  for (const [repoName, repo] of Object.entries(ctx.config.repos)) {
    if (repoFlag && repoName !== repoFlag) continue;
    for (const [name, ws] of Object.entries(repo.workspaces)) {
      const ports = Number.isInteger(ws.port) ? `${ws.port}-${ws.port + 9}` : "-";
      rows.push([name, repoName, ports, changes(ws.path), ws.path]);
    }
  }
  if (rows.length === 1) {
    ctx.info("No workspaces. Create one with: nk -b <name>");
    return 0;
  }
  ctx.print(table(rows));
  return 0;
}
