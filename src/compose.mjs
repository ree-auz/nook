import spawn from "cross-spawn";
import { isInside } from "./home.mjs";

/**
 * Docker Compose labels every container it starts with its project and the
 * folder it ran in (com.docker.compose.project.working_dir), and labels the
 * volumes, networks and built images of that project too. So nk can tell what
 * a workspace started without the repository writing a remove hook.
 */
const PROJECT = "com.docker.compose.project";
const WORKING_DIR = "com.docker.compose.project.working_dir";

export function dockerCli(args) {
  const result = spawn.sync("docker", args, { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (result.error) return { ok: false, out: "", err: result.error.code === "ENOENT" ? "not installed" : result.error.message };
  return { ok: result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "").trim() };
}

const rows = (text) => text.split(/\r?\n/).filter(Boolean);

/**
 * Compose projects started inside `path`. A project that also has containers
 * started from another folder is reported in `shared` and never removed: it
 * may be the main checkout's (production) project under the same name.
 */
export function findComposeProjects(path, docker = dockerCli) {
  const listed = docker(["container", "ls", "-a", "--filter", `label=${WORKING_DIR}`, "--format", `{{.ID}}\t{{.Label "${PROJECT}"}}\t{{.Label "${WORKING_DIR}"}}`]);
  if (!listed.ok) return { unavailable: listed.err || "docker is not running", projects: [], shared: [] };
  const byProject = new Map();
  for (const row of rows(listed.out)) {
    const [id, project, dir] = row.split("\t");
    if (!project) continue;
    const entry = byProject.get(project) ?? { inside: [], outside: [] };
    (dir && isInside(dir, path) ? entry.inside : entry.outside).push(id);
    byProject.set(project, entry);
  }
  const projects = [];
  const shared = [];
  for (const [name, { inside, outside }] of byProject) {
    if (!inside.length) continue;
    if (outside.length) {
      shared.push(name);
      continue;
    }
    const label = `label=${PROJECT}=${name}`;
    const ids = (kind) => {
      const result = docker([kind, "ls", "-q", "--filter", label]);
      return result.ok ? [...new Set(rows(result.out))] : [];
    };
    projects.push({ name, containers: inside, volumes: ids("volume"), networks: ids("network"), images: ids("image") });
  }
  return { projects, shared };
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeProject(project) {
  const parts = [count(project.containers.length, "container")];
  if (project.volumes.length) parts.push(count(project.volumes.length, "volume"));
  if (project.networks.length) parts.push(count(project.networks.length, "network"));
  if (project.images.length) parts.push(count(project.images.length, "built image"));
  return `Compose project ${project.name}: ${parts.join(", ")}`;
}

/** Removes containers (with their anonymous volumes), then volumes, networks and built images. */
export function removeComposeProject(project, docker = dockerCli) {
  const steps = [
    project.containers.length && ["container", "rm", "-f", "-v", ...project.containers],
    project.volumes.length && ["volume", "rm", "-f", ...project.volumes],
    project.networks.length && ["network", "rm", ...project.networks],
    project.images.length && ["image", "rm", "-f", ...project.images],
  ].filter(Boolean);
  for (const args of steps) {
    const result = docker(args);
    if (!result.ok) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${result.err}`);
  }
}

/** Compose projects started somewhere under `root` whose folder is not one of `live` any more. */
export function leftoverComposeProjects(root, live, docker = dockerCli) {
  const listed = docker(["container", "ls", "-a", "--filter", `label=${WORKING_DIR}`, "--format", `{{.Label "${PROJECT}"}}\t{{.Label "${WORKING_DIR}"}}`]);
  if (!listed.ok) return [];
  const found = new Map();
  for (const row of rows(listed.out)) {
    const [project, dir] = row.split("\t");
    if (project && dir && isInside(dir, root) && !live.some((path) => isInside(dir, path))) found.set(project, dir);
  }
  return [...found].map(([name, dir]) => ({ name, dir }));
}
