/**
 * Linear issues as nkl reads them: the fields asked for, which issues are
 * ready, the order of the list, and the prompt an agent gets. Nothing here
 * talks to Linear or runs anything, so it is easy to test.
 */

const STATE = "state { name type }";
const BRIEF = `identifier title url ${STATE}`;

/** The fields of an issue in the list. */
export const LIST_FIELDS = `
  id identifier title url branchName priority priorityLabel sortOrder
  ${STATE}
  team { key }
  cycle { number isActive }
  labels { nodes { name parent { name } } }
  inverseRelations(first: 50) { nodes { type issue { ${BRIEF} } } }
`;

/** The fields of one issue, for nkl show and the agent's prompt. */
export const FULL_FIELDS = `
  ${LIST_FIELDS}
  description createdAt
  assignee { name }
  project { name }
  parent { ${BRIEF} }
  children(first: 50) { nodes { ${BRIEF} } }
  relations(first: 50) { nodes { type relatedIssue { ${BRIEF} } } }
  comments(first: 50) { nodes { body createdAt user { name } } }
`;

/** Done or canceled: nothing left to do on it. */
export const isClosed = (issue) => ["completed", "canceled"].includes(issue?.state?.type);

/** The unfinished issues that block `issue` (Linear's "blocked by"). */
export function blockers(issue) {
  return (issue.inverseRelations?.nodes ?? []).filter((rel) => rel.type === "blocks" && !isClosed(rel.issue)).map((rel) => rel.issue);
}

/** The issues `issue` blocks. */
export function blocking(issue) {
  return (issue.relations?.nodes ?? []).filter((rel) => rel.type === "blocks").map((rel) => rel.relatedIssue);
}

/** Other relations (related, duplicate, similar), in both directions. */
function related(issue) {
  const out = (issue.relations?.nodes ?? []).filter((rel) => rel.type !== "blocks").map((rel) => ({ type: rel.type, issue: rel.relatedIssue }));
  const back = (issue.inverseRelations?.nodes ?? []).filter((rel) => rel.type !== "blocks").map((rel) => ({ type: rel.type, issue: rel.issue }));
  return [...out, ...back];
}

// Started work first, then what is planned, then the backlog.
const STATE_ORDER = { started: 0, unstarted: 1, backlog: 2, triage: 3 };
// Linear: 1 urgent, 2 high, 3 medium, 4 low, 0 no priority.
const priorityRank = (priority) => (priority ? priority : 5);

/**
 * The order of the list: issues nothing blocks first; then started before
 * planned before backlog, the current cycle first, higher priority first,
 * and Linear's own manual order last.
 */
export function rank(issues) {
  const key = (issue) => [
    blockers(issue).length ? 1 : 0,
    STATE_ORDER[issue.state?.type] ?? 4,
    issue.cycle?.isActive ? 0 : 1,
    priorityRank(issue.priority),
    issue.sortOrder ?? 0,
  ];
  return [...issues].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

/** The first issue that is ready: nothing blocks it and it has no workspace yet. */
export function next(issues, hasWorkspace = () => false) {
  return rank(issues).find((issue) => !blockers(issue).length && !hasWorkspace(issue)) ?? null;
}

/** The columns of an issue in the list. */
export function cells(issue, { hasWorkspace = false, unicode = true } = {}) {
  const blocked = blockers(issue);
  const mark = blocked.length ? (unicode ? "⛔" : "B") : hasWorkspace ? (unicode ? "●" : "*") : " ";
  const note = blocked.length ? `  (blocked by ${blocked.map((b) => b.identifier).join(", ")})` : "";
  return [mark, issue.identifier, issue.state?.name ?? "", issue.priority ? issue.priorityLabel : "", `${issue.title}${note}`];
}

/** What typing filters on in the list. */
export const searchText = (issue) => [issue.identifier, issue.title, issue.state?.name, issue.priorityLabel, ...labelNames(issue)].join(" ");

/** Labels as Linear shows them: "Group › Name", or the name alone. */
function labelNames(issue) {
  return (issue.labels?.nodes ?? []).map((label) => (label.parent?.name ? `${label.parent.name} › ${label.name}` : label.name));
}

/**
 * The agent named by a label of the group `group`: with group "Agent", an
 * issue labelled "Agent › Claude" gets `claude`.
 */
export function agentFromIssue(issue, group) {
  if (!group) return null;
  const label = (issue.labels?.nodes ?? []).find((node) => node.parent?.name === group);
  return label ? label.name.trim().toLowerCase().replace(/\s+/g, "-") : null;
}

/** Issue identifiers like REE-292 in a branch name such as ree-auz/ree-292-fix. */
export function identifierFromBranch(branch) {
  const match = /(?:^|[/_-])([a-z][a-z0-9]{0,9})-(\d+)(?=$|[/_-])/i.exec(branch ?? "");
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

/** An identifier the way Linear writes it, or null: "ree-292" -> "REE-292". */
export function normalizeIdentifier(text) {
  const match = /^([a-z][a-z0-9]{0,9})-(\d+)$/i.exec(String(text ?? "").trim());
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

const brief = (issue) => `${issue.identifier} ${issue.title} (${issue.state?.name ?? "?"})`;
const day = (iso) => String(iso ?? "").slice(0, 10);

/** The recent comments, oldest first. */
function recentComments(issue, count) {
  const all = [...(issue.comments?.nodes ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return all.slice(-count);
}

/**
 * The prompt the agent starts with: everything it would otherwise look up in
 * Linear, so it can begin at once.
 */
export function promptFor(issue, { comments = 5 } = {}) {
  const parts = [`Work on Linear issue ${issue.identifier}: ${issue.title}`, issue.url, ""];
  const facts = [
    ["Status", issue.state?.name],
    ["Priority", issue.priority ? issue.priorityLabel : ""],
    ["Project", issue.project?.name],
    ["Labels", labelNames(issue).join(", ")],
    ["Branch", issue.branchName],
  ].filter(([, value]) => value);
  for (const [name, value] of facts) parts.push(`- ${name}: ${value}`);
  if (issue.parent) parts.push(`- Parent: ${brief(issue.parent)}`);
  parts.push("", "## Description", "", issue.description?.trim() || "(no description)");
  const sections = [
    ["Blocked by (unfinished)", blockers(issue).map(brief)],
    ["Blocks", blocking(issue).map(brief)],
    ["Sub-issues", (issue.children?.nodes ?? []).map(brief)],
    ["Related", related(issue).map((rel) => `${rel.type}: ${brief(rel.issue)}`)],
  ];
  for (const [title, items] of sections) if (items.length) parts.push("", `## ${title}`, "", ...items.map((item) => `- ${item}`));
  const recent = recentComments(issue, comments);
  if (recent.length) {
    parts.push("", `## Latest comments`);
    for (const comment of recent) parts.push("", `**${comment.user?.name ?? "someone"}** (${day(comment.createdAt)}):`, "", comment.body.trim());
  }
  return `${parts.join("\n")}\n`;
}

/** nkl show: the issue's state and its relations, as lines. */
export function showLines(issue) {
  const lines = [`${issue.identifier}  ${issue.title}`, issue.url, ""];
  const facts = [
    ["Status", issue.state?.name],
    ["Assignee", issue.assignee?.name ?? "nobody"],
    ["Priority", issue.priority ? issue.priorityLabel : "none"],
    ["Cycle", issue.cycle ? `${issue.cycle.number}${issue.cycle.isActive ? " (current)" : ""}` : ""],
    ["Project", issue.project?.name],
    ["Labels", labelNames(issue).join(", ")],
    ["Branch", issue.branchName],
    ["Parent", issue.parent ? brief(issue.parent) : ""],
  ].filter(([, value]) => value);
  const pad = Math.max(...facts.map(([name]) => name.length));
  for (const [name, value] of facts) lines.push(`${name.padEnd(pad)}  ${value}`);
  const allBlockers = (issue.inverseRelations?.nodes ?? []).filter((rel) => rel.type === "blocks").map((rel) => rel.issue);
  const groups = [
    ["Blocked by", allBlockers.map((b) => `${isClosed(b) ? "  " : "! "}${brief(b)}`)],
    ["Blocks", blocking(issue).map((b) => `  ${brief(b)}`)],
    ["Sub-issues", (issue.children?.nodes ?? []).map((c) => `  ${brief(c)}`)],
    ["Related", related(issue).map((rel) => `  ${rel.type}: ${brief(rel.issue)}`)],
  ];
  for (const [title, items] of groups) if (items.length) lines.push("", `${title}:`, ...items);
  return lines;
}
