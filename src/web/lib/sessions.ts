/**
 * The sidebar's data surface as pure functions: search matching, project
 * grouping and parent/child nesting, ported from `src/ui/app.js:957-1019` and
 * `:1073-1117`.
 *
 * Everything here is deterministic: the same sessions and options always yield
 * the same groups, in the same order. The only ordering rules are the legacy
 * ones — groups keep the server's newest-first order, roots sort by
 * `timeUpdated` (falling back to `timeCreated`) and then by id, children sort by
 * `timeCreated` and then by id.
 */

import type { SessionSummary } from "../../core/types.ts";

export interface SessionNode {
  session: SessionSummary;
  children: SessionNode[];
  depth: number;
}

export interface SessionGroup {
  /** The `directory`, then `projectID`, then `(no project)`; empty when ungrouped. */
  key: string;
  sessions: SessionSummary[];
  nodes: SessionNode[];
  count: number;
  /** False when grouping is off, so the sidebar renders no project header. */
  showHeader: boolean;
  /** True while searching (every branch auto-expands) or once the user opened it. */
  expanded: boolean;
}

export interface GroupOptions {
  groupByProject: boolean;
  sessionTree: boolean;
  expandedProjects: ReadonlySet<string>;
  /** The raw search box value; matching is case-insensitive. */
  query: string;
}

export function sessionMatchesQuery(
  session: SessionSummary,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    session.title,
    session.id,
    session.slug,
    session.agent,
    session.directory,
    session.projectID,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

export function projectKey(session: SessionSummary): string {
  return session.directory || session.projectID || "(no project)";
}

export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  return sessions.filter((session) => sessionMatchesQuery(session, query));
}

/** Parent/child nodes from the flat list already loaded (`app.js:976-1019`). */
export function buildSessionTree(
  sessions: readonly SessionSummary[],
): SessionNode[] {
  const nodes = new Map<string, SessionNode>(
    sessions.map((session) => [
      session.id,
      { session, children: [], depth: 0 },
    ]),
  );
  const roots: SessionNode[] = [];
  for (const node of nodes.values()) {
    let parent = node.session.parentID
      ? nodes.get(node.session.parentID) ?? null
      : null;
    // A self-reference or a cycle must not hide sessions from the list.
    const seen = new Set<string>([node.session.id]);
    let cursor = parent;
    while (cursor) {
      if (seen.has(cursor.session.id)) {
        parent = null;
        break;
      }
      seen.add(cursor.session.id);
      cursor = cursor.session.parentID
        ? nodes.get(cursor.session.parentID) ?? null
        : null;
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (list: SessionNode[]): SessionNode[] =>
    [...list].sort(
      (a, b) =>
        (a.session.timeCreated ?? 0) - (b.session.timeCreated ?? 0) ||
        String(a.session.id).localeCompare(String(b.session.id)),
    );
  const assignDepth = (node: SessionNode, depth: number): void => {
    node.depth = depth;
    node.children = sortNodes(node.children);
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  roots.sort(
    (a, b) =>
      (b.session.timeUpdated ?? b.session.timeCreated ?? 0) -
        (a.session.timeUpdated ?? a.session.timeCreated ?? 0) ||
      String(a.session.id).localeCompare(String(b.session.id)),
  );
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

export function groupSessions(
  sessions: readonly SessionSummary[],
  options: GroupOptions,
): SessionGroup[] {
  const query = options.query.trim();
  const searching = query.length > 0;
  const visible = filterSessions(sessions, query);
  const buckets = new Map<string, SessionSummary[]>();
  for (const session of visible) {
    const key = options.groupByProject ? projectKey(session) : "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session);
    else buckets.set(key, [session]);
  }
  const groups: SessionGroup[] = [];
  for (const [key, groupSessions] of buckets) {
    groups.push({
      key,
      sessions: groupSessions,
      nodes: options.sessionTree ? buildSessionTree(groupSessions) : [],
      count: groupSessions.length,
      showHeader: options.groupByProject,
      expanded:
        !options.groupByProject || searching || options.expandedProjects.has(key),
    });
  }
  return groups;
}
