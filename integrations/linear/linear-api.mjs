/**
 * Reads Linear through its GraphQL API with a personal API key. nkl only
 * reads: issue states change through Linear's GitHub integration.
 */
import { FULL_FIELDS, LIST_FIELDS } from "./issues.mjs";

export const ENDPOINT = "https://api.linear.app/graphql";
export const KEY_HELP =
  "Create a personal API key in Linear (Settings > Security & access > Personal API keys; read access is enough) and put it in LINEAR_API_KEY.\n" +
  "PowerShell, once: setx LINEAR_API_KEY \"lin_api_...\" (then open a new terminal)";

export class LinearError extends Error {}

/**
 * A client for one API key. `fetch` can be swapped in tests.
 * @param {{ key?: string, fetch?: typeof globalThis.fetch }} options
 */
export function createLinear({ key, fetch = globalThis.fetch }) {
  if (!key) throw new LinearError(`LINEAR_API_KEY is not set.\n${KEY_HELP}`);

  async function query(text, variables = {}) {
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        // A personal API key goes in Authorization as it is, without "Bearer".
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query: text, variables }),
      });
    } catch (error) {
      throw new LinearError(`Could not reach Linear: ${error.message}`);
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || body.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR"))
      throw new LinearError(`Linear did not accept LINEAR_API_KEY.\n${KEY_HELP}`);
    if (body.errors?.length) throw new LinearError(`Linear: ${body.errors.map((e) => e.message).join("; ")}`);
    if (!response.ok) throw new LinearError(`Linear answered ${response.status}`);
    return body.data;
  }

  return {
    query,

    /** One issue by identifier (REE-292), with everything nkl show and the prompt need. */
    async issue(identifier) {
      try {
        const data = await query(`query($id: String!) { issue(id: $id) { ${FULL_FIELDS} } }`, { id: identifier });
        if (!data.issue) throw new LinearError(`No issue ${identifier} in Linear`);
        return data.issue;
      } catch (error) {
        if (error instanceof LinearError && /not found|entity/i.test(error.message)) throw new LinearError(`No issue ${identifier} in Linear`);
        throw error;
      }
    },

    /** Several issues by identifier in one request; missing ones are left out. */
    async issuesById(identifiers) {
      if (!identifiers.length) return new Map();
      const parts = identifiers.map((id, i) => `i${i}: issue(id: ${JSON.stringify(id)}) { identifier title url ${"state { name type }"} }`);
      // One missing issue would fail the whole request, so each is asked for alone when that happens.
      try {
        const data = await query(`query { ${parts.join("\n")} }`);
        return new Map(Object.values(data).filter(Boolean).map((issue) => [issue.identifier, issue]));
      } catch (error) {
        if (!(error instanceof LinearError) || /LINEAR_API_KEY|reach/.test(error.message)) throw error;
        const found = new Map();
        for (const part of parts) {
          const data = await query(`query { ${part} }`).catch(() => null);
          const issue = data && Object.values(data)[0];
          if (issue) found.set(issue.identifier, issue);
        }
        return found;
      }
    },

    /**
     * Unfinished issues. mine: only those assigned to you. team: a team key
     * (REE). cycle: only the current cycle. project, label: by name.
     */
    async issues({ mine = true, team, cycle = false, project, label } = {}) {
      const filter = { state: { type: { nin: ["completed", "canceled"] } } };
      if (mine) filter.assignee = { isMe: { eq: true } };
      if (team) filter.team = { key: { eqIgnoreCase: team } };
      if (cycle) filter.cycle = { isActive: { eq: true } };
      if (project) filter.project = { name: { containsIgnoreCase: project } };
      if (label) filter.labels = { some: { name: { eqIgnoreCase: label } } };
      return collect((after) =>
        query(`query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) { nodes { ${LIST_FIELDS} } pageInfo { hasNextPage endCursor } } }`, {
          filter,
          after,
        }).then((data) => data.issues),
      );
    },

    /** The unfinished issues of a custom view you saved in Linear, by name. */
    async viewIssues(name) {
      const views = await query(`query($name: String!) { customViews(filter: { name: { eqIgnoreCase: $name } }, first: 5) { nodes { id name } } }`, { name });
      const view = views.customViews.nodes[0];
      if (!view) throw new LinearError(`No custom view named "${name}" in Linear`);
      const issues = await collect((after) =>
        query(`query($id: String!, $after: String) { customView(id: $id) { issues(first: 100, after: $after) { nodes { ${LIST_FIELDS} } pageInfo { hasNextPage endCursor } } } }`, {
          id: view.id,
          after,
        }).then((data) => data.customView.issues),
      );
      return issues.filter((issue) => !["completed", "canceled"].includes(issue.state?.type));
    },
  };
}

/** Every page of a connection, up to 500 nodes. */
async function collect(page) {
  const nodes = [];
  let after = null;
  for (let i = 0; i < 5; i++) {
    const connection = await page(after);
    nodes.push(...connection.nodes);
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return nodes;
}
