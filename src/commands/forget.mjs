import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NookError } from "../errors.mjs";
import { exists, isInside } from "../home.mjs";
import { resolveRepo } from "../context.mjs";
import { createPrompter } from "../prompt.mjs";
import { dockerCli, findComposeProjects, removeComposeProject } from "../compose.mjs";
import { deleteFolder } from "./rm.mjs";

/**
 * nk forget [<short-name>]: nk stops knowing a repository. Its registration
 * and shared files go; the repository folder and backups stay. Workspaces are
 * removed first with nk rm, which backs up their work, unless the repository
 * folder itself is gone: then git cannot remove them and they go with it.
 */
export async function forgetRepo(ctx, { name: input, yes = false, prompter = createPrompter(), docker = dockerCli } = {}) {
  const { name, repo } = resolveRepo(ctx, input);
  const workspaces = Object.keys(repo.workspaces);
  const present = exists(repo.path);
  if (workspaces.length && present)
    throw new NookError(`${name} still has workspaces: ${workspaces.join(", ")}\nRemove them first, which backs up their work: nk rm ${workspaces.join(" ")} --repo ${name}`);

  const shared = join(ctx.paths.shared, name);
  const dir = join(ctx.paths.workspaces, name);
  const leftovers = exists(dir) ? readdirSync(dir).map((entry) => join(dir, entry)) : [];
  ctx.info(`Forgetting ${name} (${repo.path}${present ? "" : ", which no longer exists"})`);
  if (exists(shared)) ctx.warn(`Deletes the shared files ${shared}, with the values you filled in`);
  if (leftovers.length) {
    ctx.warn(`Deletes what is left in ${dir}${present ? "" : " (git cannot remove these without the repository)"}:`);
    for (const path of leftovers) ctx.item(path);
  }
  ctx.info(`Keeps the repository folder${exists(join(ctx.paths.backup, name)) ? ` and the backups in ${join(ctx.paths.backup, name)}` : ""}`);
  if (!yes) {
    let ok;
    try {
      ok = await prompter.confirm(`Forget ${name}?`, false);
    } catch {
      throw new NookError("Confirmation needs a terminal; pass -y to forget without asking");
    }
    if (!ok) throw new NookError("Nothing was changed");
  }

  // What was started from those folders goes with them: Compose projects (containers, volumes, networks,
  // built images) and the service containers generated hooks start (labelled with their workspace).
  if (exists(dir)) {
    for (const project of findComposeProjects(dir, docker).projects) removeComposeProject(project, docker);
    const labelled = docker(["container", "ls", "-a", "--filter", "label=dev.nook.workspace", "--format", '{{.ID}}\t{{.Label "dev.nook.workspace"}}']);
    const ids = labelled.ok ? labelled.out.split(/\r?\n/).filter(Boolean).map((row) => row.split("\t")).filter(([, path]) => path && isInside(path, dir)).map(([id]) => id) : [];
    if (ids.length) docker(["container", "rm", "-f", "-v", ...ids]);
  }
  deleteFolder(dir);
  deleteFolder(shared);
  delete ctx.config.repos[name];
  ctx.save();
  ctx.ok(`Forgot ${name}. Register it again with nk init`);
  return 0;
}
