/**
 * Moves an issue to its team's first started status, through Linear's API,
 * when the launcher starts work on it. Linear's own "move issue to started
 * status" setting does not cover custom scripts. Needs a personal API key:
 * LINEAR_API_KEY, or "linear": { "apiKey" } in the config.
 */
const API = "https://api.linear.app/graphql";

/** The API key: the environment wins over the config file. */
export function apiKey(config = {}, env = process.env) {
  return env.LINEAR_API_KEY || config.linear?.apiKey || null;
}

async function graphql(key, query, variables, fetchImpl) {
  const response = await fetchImpl(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.[0]?.message ?? `HTTP ${response.status}`);
  return body.data;
}

const READ = `query($id: String!) {
  viewer { id }
  issue(id: $id) { id state { type name } assignee { id } team { states { nodes { id name type position } } } }
}`;
const UPDATE = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;

/**
 * Starts the issue `id` (REE-302): its team's first started status, unless it
 * has started, finished or been canceled already. With assign, an issue
 * nobody has gets assigned to the key's owner. Returns a line to print.
 */
export async function startIssue({ id, key, assign = false, fetch: fetchImpl = globalThis.fetch }) {
  const { viewer, issue } = await graphql(key, READ, { id }, fetchImpl);
  if (!issue) return `${id}: not found in Linear`;
  const input = {};
  const unstarted = ["triage", "backlog", "unstarted"].includes(issue.state?.type);
  const started = issue.team.states.nodes.filter((state) => state.type === "started").sort((a, b) => a.position - b.position)[0];
  if (unstarted && started) input.stateId = started.id;
  if (assign && !issue.assignee) input.assigneeId = viewer.id;
  if (!Object.keys(input).length) return `${id}: already ${issue.state?.name ?? "started"}`;
  await graphql(key, UPDATE, { id: issue.id, input }, fetchImpl);
  return [input.stateId && `${id}: ${issue.state.name} → ${started.name}`, input.assigneeId && "assigned to you"].filter(Boolean).join(", ");
}
