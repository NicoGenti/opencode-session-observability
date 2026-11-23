import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../core/types.ts";
import { ApiError, type ApiFn } from "../lib/api.ts";
import { groupSessions, type SessionGroup } from "../lib/sessions.ts";
import { get, onSettingsReset, set } from "../lib/settings.ts";

/** The legacy sidebar page size (`app.js:406`). */
export const SESSION_LIMIT = 300;
/** The legacy search debounce (`app.js:4312`). */
export const SEARCH_DEBOUNCE_MS = 220;

export interface SessionsResponse {
  sessions?: SessionSummary[];
  revealAllowed?: boolean;
}

export type SessionsStatus = "loading" | "ready" | "error";

export interface UseSessionsOptions {
  api: ApiFn;
  groupByProject: boolean;
  sessionTree: boolean;
}

export interface SessionsController {
  sessions: SessionSummary[];
  groups: SessionGroup[];
  status: SessionsStatus;
  error: string | null;
  query: string;
  expandedProjects: ReadonlySet<string>;
  expandedParents: ReadonlySet<string>;
  setQuery(query: string): void;
  reload(): void;
  toggleProject(key: string): void;
  toggleParent(id: string): void;
}

function storedList(key: "expandedProjects" | "expandedParents"): Set<string> {
  const value = get(key);
  return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * `GET /api/sessions?limit=300`, client-side grouping and search, and the two
 * persisted disclosure sets (`observability-expandedProjects` /
 * `observability-expandedParents`). Selection stays outside: the hash owns the
 * selected session, so the caller passes it to the sidebar.
 *
 * StrictMode runs the mount effect twice; the first request is aborted in the
 * cleanup and a sequence guard drops any late response.
 */
export function useSessions(options: UseSessionsOptions): SessionsController {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<SessionsStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [query, setQueryState] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(
    () => storedList("expandedProjects"),
  );
  const [expandedParents, setExpandedParents] = useState<ReadonlySet<string>>(
    () => storedList("expandedParents"),
  );

  const queryRef = useRef(query);
  const projectsRef = useRef(expandedProjects);
  const parentsRef = useRef(expandedParents);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (nextQuery: string): Promise<void> => {
      const request = ++sequence.current;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setStatus("loading");
      try {
        const data = await options.api<SessionsResponse>(
          "/api/sessions",
          // The server owns the search; the raw text is sent (`app.js:406`).
          // Trimming is a display concern in `groupSessions`.
          { q: nextQuery || undefined, limit: SESSION_LIMIT },
          { signal: controller.signal },
        );
        if (request !== sequence.current) return;
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        setError(null);
        setStatus("ready");
      } catch (failure) {
        if (request !== sequence.current || controller.signal.aborted) return;
        setError(errorMessage(failure));
        setStatus("error");
      }
    },
    [options.api],
  );

  useEffect(() => {
    void load(queryRef.current);
    return () => {
      active.current?.abort();
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [load]);

  const setQuery = useCallback(
    (next: string) => {
      setQueryState(next);
      queryRef.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void load(next);
      }, SEARCH_DEBOUNCE_MS);
    },
    [load],
  );

  const reload = useCallback(() => {
    void load(queryRef.current);
  }, [load]);

  // A settings reset clears the persisted disclosure keys; the in-memory sets
  // must clear too, or the next toggle would write the stale entries back.
  useEffect(
    () =>
      onSettingsReset(() => {
        projectsRef.current = new Set();
        parentsRef.current = new Set();
        setExpandedProjects(new Set());
        setExpandedParents(new Set());
      }),
    [],
  );

  const toggleProject = useCallback((key: string) => {
    const next = new Set(projectsRef.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    projectsRef.current = next;
    set("expandedProjects", [...next]);
    setExpandedProjects(next);
  }, []);

  const toggleParent = useCallback((id: string) => {
    const next = new Set(parentsRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    parentsRef.current = next;
    set("expandedParents", [...next]);
    setExpandedParents(next);
  }, []);

  const groups = useMemo(
    () =>
      groupSessions(sessions, {
        groupByProject: options.groupByProject,
        sessionTree: options.sessionTree,
        expandedProjects,
        query,
      }),
    [sessions, options.groupByProject, options.sessionTree, expandedProjects, query],
  );

  return {
    sessions,
    groups,
    status,
    error,
    query,
    expandedProjects,
    expandedParents,
    setQuery,
    reload,
    toggleProject,
    toggleParent,
  };
}
