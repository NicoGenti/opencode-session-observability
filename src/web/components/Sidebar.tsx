import { ChevronDown, ChevronRight } from "lucide-react";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import clsx from "clsx";
import type { SessionSummary } from "../../core/types.ts";
import { formatCompact, formatCost, formatRelative } from "../lib/format.ts";
import type { SessionGroup, SessionNode } from "../lib/sessions.ts";
import type { SessionsStatus } from "../hooks/useSessions.ts";

export interface SidebarProps {
  groups: readonly SessionGroup[];
  status: SessionsStatus;
  error: string | null;
  query: string;
  selectedSessionID: string | null;
  expandedParents: ReadonlySet<string>;
  onQueryChange(query: string): void;
  onSelect(sessionID: string): void;
  onToggleProject(key: string): void;
  onToggleParent(sessionID: string): void;
}

function SessionButton({
  session,
  selected,
  onSelect,
}: {
  session: SessionSummary;
  selected: boolean;
  onSelect(sessionID: string): void;
}) {
  const totalIn =
    (session.tokens?.input ?? 0) +
    (session.tokens?.cacheRead ?? 0) +
    (session.tokens?.cacheWrite ?? 0);
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      aria-current={selected ? "true" : undefined}
      className={clsx(
        "flex w-full flex-col gap-0.5 border-l-[3px] px-3 py-1.5 text-left",
        selected
          ? "border-accent bg-accent-weak"
          : "border-transparent hover:bg-surface-2",
      )}
    >
      <span className="flex items-baseline gap-1 text-[12.5px] text-text">
        <span className="truncate">{session.title || session.id}</span>
        {selected ? <VisuallyHidden.Root>Current session</VisuallyHidden.Root> : null}
      </span>
      <span className="flex items-baseline gap-2 text-[11px] text-muted">
        <span className="truncate">{session.agent || "—"}</span>
        <span className="truncate">
          {session.model ? `${session.model.providerID}/${session.model.id}` : "—"}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {formatRelative(session.timeUpdated ?? session.timeCreated)}
        </span>
      </span>
      <span className="text-[11px] text-text-2 tabular-nums">
        {formatCompact(totalIn)} in · {formatCompact(session.tokens?.output)} out
        {session.cost !== undefined ? ` · ${formatCost(session.cost)}` : ""}
        {session.parentID ? " · subagent" : ""}
      </span>
    </button>
  );
}

function SessionNodes({
  nodes,
  expandedParents,
  searching,
  selectedSessionID,
  onSelect,
  onToggleParent,
}: {
  nodes: readonly SessionNode[];
  expandedParents: ReadonlySet<string>;
  searching: boolean;
  selectedSessionID: string | null;
  onSelect(sessionID: string): void;
  onToggleParent(sessionID: string): void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const expanded = searching || expandedParents.has(node.session.id);
        const label = node.session.title || node.session.id;
        return (
          <div key={node.session.id} className="flex flex-col">
            <div
              className="flex items-stretch"
              style={{ paddingLeft: `${node.depth * 14}px` }}
            >
              {hasChildren && !searching ? (
                <button
                  type="button"
                  onClick={() => onToggleParent(node.session.id)}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${label} children`}
                  title={`${expanded ? "Collapse" : "Expand"} children`}
                  className="mt-1 ml-1 self-start rounded-sm p-0.5 text-muted hover:text-text"
                >
                  {expanded ? (
                    <ChevronDown size={12} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" />
                  )}
                </button>
              ) : (
                <span aria-hidden="true" className="w-[21px] shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <SessionButton
                  session={node.session}
                  selected={node.session.id === selectedSessionID}
                  onSelect={onSelect}
                />
              </div>
            </div>
            {hasChildren && expanded ? (
              <SessionNodes
                nodes={node.children}
                expandedParents={expandedParents}
                searching={searching}
                selectedSessionID={selectedSessionID}
                onSelect={onSelect}
                onToggleParent={onToggleParent}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * The session list (`docs/UI.md:33-35`): search over the loaded page, project
 * groups that start collapsed, child sessions nested under their parent, and
 * every branch auto-expanded while searching.
 *
 * Selection is a hash concern, so this component only reports the chosen id and
 * marks the current row. The selected row carries `aria-current`, the 3 px
 * accent rule and a hidden "Current session" label, so colour is never the only
 * signal.
 */
export function Sidebar({
  groups,
  status,
  error,
  query,
  selectedSessionID,
  expandedParents,
  onQueryChange,
  onSelect,
  onToggleProject,
  onToggleParent,
}: SidebarProps) {
  const searching = query.trim().length > 0;
  const empty = status === "ready" && groups.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span
          aria-hidden="true"
          className="grid size-5 place-items-center rounded-sm border border-border-strong text-accent"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <span className="text-[13px] font-semibold text-text">Session Observability</span>
      </div>

      <div className="px-3 py-2">
        <label className="sr-only" htmlFor="session-search">
          Search sessions
        </label>
        <input
          id="session-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search sessions…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="w-full rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12.5px] text-text placeholder:text-muted"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {status === "loading" && groups.length === 0 ? (
          <p className="m-0 px-4 py-3 text-[12.5px] text-text-2">Loading sessions…</p>
        ) : null}
        {error ? (
          <p role="alert" className="m-0 px-4 py-3 text-[12.5px] text-critical">
            {error}
          </p>
        ) : null}
        {empty ? (
          <p className="m-0 px-4 py-3 text-[12.5px] text-text-2">No sessions found.</p>
        ) : null}
        {groups.map((group) => (
          <section key={group.key || "ungrouped"} className="mt-1">
            {group.showHeader ? (
              searching ? (
                <div className="flex items-center gap-1.5 px-3 py-1 text-[11.5px] font-semibold text-muted">
                  <ChevronDown size={12} aria-hidden="true" />
                  <span className="truncate" title={group.key}>
                    {group.key}
                  </span>
                  <span className="ml-auto tabular-nums">{group.count}</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onToggleProject(group.key)}
                  aria-expanded={group.expanded}
                  title={group.key}
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11.5px] font-semibold text-muted hover:text-text"
                >
                  {group.expanded ? (
                    <ChevronDown size={12} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" />
                  )}
                  <span className="truncate">{group.key}</span>
                  <span className="ml-auto tabular-nums">{group.count}</span>
                </button>
              )
            ) : null}
            {group.expanded ? (
              <div>
                {group.nodes.length > 0 ? (
                  <SessionNodes
                    nodes={group.nodes}
                    expandedParents={expandedParents}
                    searching={searching}
                    selectedSessionID={selectedSessionID}
                    onSelect={onSelect}
                    onToggleParent={onToggleParent}
                  />
                ) : (
                  group.sessions.map((session) => (
                    <SessionButton
                      key={session.id}
                      session={session}
                      selected={session.id === selectedSessionID}
                      onSelect={onSelect}
                    />
                  ))
                )}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
