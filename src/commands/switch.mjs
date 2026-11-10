// @ts-check
import { basename } from "node:path";
import { NookError } from "../errors.mjs";
import { githubPrs } from "../forge.mjs";
import { remoteUrl } from "../git.mjs";
import { exists } from "../home.mjs";
import { normalizeName } from "../names.mjs";
import { pick } from "../select.mjs";
import { unicodeSupported, useColor } from "../ui.mjs";
import { repoFromCwd, repoWorkspaces, resolveWorkspace } from "../context.mjs";
import { changesText, collect, commitsText, markOf, prText } from "./ls.mjs";

/** The workspace called `name`: in the repository you are in (or --repo), else in the one registered repository that has it. */
function byName(ctx, name, repoFlag) {
  if (repoFlag || repoFromCwd(ctx)) return resolveWorkspace(ctx, name, repoFlag);
  const hits = Object.entries(ctx.config.repos).flatMap(([repoName, repo]) => {
    const items = repoWorkspaces(repoName, repo);
    return items.find((item) => item.name === name) ?? items.find((item) => normalizeName(basename(item.ws.path)) === name) ?? [];
  });
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new NookError(`No workspace named "${name}" in any registered repository\nRun nk ls to see them`);
  throw new NookError(`"${name}" is in several repositories: ${hits.map((hit) => hit.repoName).join(", ")}\nPass one: nk switch ${name} --repo <short-name>`);
}

/**
 * nk switch [<name>] [--repo <short-name>]
 *
 * Prints the folder of a workspace on stdout and does nothing else: no hook
 * runs, nothing starts. Without a name it shows the list to choose from, on
 * stderr. A program cannot change the folder of the shell that started it,
 * so the shell does that with the path: cd "$(nk switch)".
 *
 * Returns 0 with the path printed; 1 after Esc and 130 after Ctrl+C, with nothing printed.
 *
 * @param {ReturnType<typeof import("../context.mjs").createContext>} ctx
 * @param {{ name?: string, repo?: string, input?: any, prs?: Function | false }} [options]
 */
export async function switchWorkspace(ctx, { name, repo: repoFlag, input = process.stdin, prs: lookup = githubPrs } = {}) {
  if (name) {
    const target = byName(ctx, normalizeName(name), repoFlag);
    if (!exists(target.ws.path)) throw new NookError(`${target.ws.path} is missing. Run nk doctor`);
    ctx.print(target.ws.path);
    return 0;
  }
  if (!input.isTTY || !ctx.err.isTTY) throw new NookError("nk switch shows a list to choose from, which needs a terminal\nPass the name instead: nk switch <name>");

  // The list comes from git alone, so it is there at once; GitHub's answer is added when it comes.
  const { items: all } = await collect(ctx, { repo: repoFlag, prs: false });
  const items = all.filter((item) => exists(item.ws.path));
  if (!items.length) throw new NookError("No repositories yet. Run nk init inside one");
  const repos = [...new Set(items.map((item) => item.repoName))];
  const several = repos.length > 1;
  const details = (item) => [changesText(item.changes, item.ws.path), commitsText(item.commits), prText(item.pr)].filter(Boolean).join(" · ");
  const label = (item) => (item.ws.locked ? `${item.name} (locked)` : item.name);

  const picker = pick({
    input,
    output: ctx.err,
    title: `nk switch · ${several ? "all repositories" : repos[0]}`,
    items,
    cells: (item) => [markOf(ctx, items, item), label(item), ...(several ? [item.repoName] : []), details(item)],
    // Typing looks in the names only: "clean" would otherwise match nearly every row.
    text: (item) => `${item.name} ${item.branch ?? ""} ${item.repoName}`,
    // Where you are is the one place not worth switching to.
    start: items.find((item) => markOf(ctx, items, item) !== "@"),
    color: useColor(ctx.err, ctx.env),
    unicode: unicodeSupported(ctx.env),
  });

  const stop = new AbortController();
  if (lookup)
    for (const repoName of repos) {
      const { repo } = items.find((item) => item.repoName === repoName);
      if (!remoteUrl(repo.path)) continue;
      // Without an answer the list stays as it is: choosing a folder does not need GitHub.
      Promise.resolve(lookup(repo.path, ctx.env, { signal: stop.signal }))
        .then(({ prs }) => {
          if (!prs) return;
          for (const item of items) if (item.repoName === repoName && !item.main && item.branch) item.pr = prs.get(item.branch) ?? null;
          picker.redraw();
        })
        .catch(() => {});
    }

  const chosen = await picker.result;
  stop.abort();
  if ("cancelled" in chosen) return chosen.cancelled === "interrupt" ? 130 : 1;
  ctx.print(chosen.item.ws.path);
  return 0;
}
