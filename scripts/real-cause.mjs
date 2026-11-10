/**
 * Whose failure a failed step of the full run (scripts/real-run.mjs) is, so the
 * weekly report separates what needs a fix in nk from what the repository or
 * the runner did:
 *
 *   nk          a check of isolation or cleanup failed, or nk itself crashed.
 *               Always a defect, in a repository nk knows and in a new one.
 *   repository  a command of the repository's own setup failed inside a hook
 *               (an install, a build, a service that did not become healthy):
 *               the pinned commit against today's runner and registries. nk may
 *               still have chosen a command it should not have; the command is
 *               named so that can be judged.
 *   runner      the checkout failed before nk ran.
 *   unknown     anything else; treated as nk's until someone has looked.
 */

// Steps that check what nk promises whatever the repository does.
const PROMISES = [/is clean in git$/, /\.env uses its own ports$/, /share nothing$/, /stays in try1$/, /leaves try2 and the main checkout alone$/, /^nothing left behind/, /^nk rm /, /^nk init$/, /^allow hooks$/, /^nk hooks write$/];
// A JavaScript error with a stack trace out of nk's own source: nk reports its own refusals without one.
const CRASH = /\b(TypeError|ReferenceError|RangeError|SyntaxError|AssertionError)\b[^\n]*\n\s+at .*[\\/]src[\\/]/;
const HOOK_COMMAND = /Failed \(exit (\d+)\): ([^\n]+)/;

export function failureCause(step, output = "") {
  if (!step) return null;
  if (CRASH.test(output)) return { cause: "nk", why: "nk crashed" };
  if (step === "clone") return { cause: "runner", why: "the checkout failed before nk ran" };
  if (PROMISES.some((pattern) => pattern.test(step))) return { cause: "nk", why: `${step} is nk's to get right` };
  const command = HOOK_COMMAND.exec(output);
  if (command) return { cause: "repository", why: `its own setup command failed (exit ${command[1]}): ${command[2].trim()}`, command: command[2].trim() };
  return { cause: "unknown", why: "no setup command of the repository is named as failed" };
}
