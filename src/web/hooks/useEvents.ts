import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Analysis, EventPage, NormalizedEvent } from "../../core/types.ts";
import type { DiagnosticIncident, Diagnostics } from "../../core/diagnostics.ts";
import type { Guardrails } from "../../core/guardrails.ts";
import { ApiError, withRefresh, type ApiFn, type ApiParams } from "../lib/api.ts";
import { eventsQueryParams, filtersKey, type EventFilters } from "../lib/event-filters.ts";
import { mergePages, type PageDirection } from "../lib/paging.ts";

/** The legacy events page (`EventPage`, served by the events route). */
export type PageMeta = EventPage["page"];

export type EventsStatus = "loading" | "ready" | "error";
export type LoadOp = "reset" | "earlier" | "later" | "around";

interface EventsState {
  events: NormalizedEvent[];
  page: PageMeta | null;
  status: EventsStatus;
  error: string | null;
  op: LoadOp | null;
  revision: number;
}

interface EventsResponse {
  events?: NormalizedEvent[];
  page: PageMeta;
  revealAllowed?: boolean;
}

export interface LoadResult {
  ok: boolean;
  /** Whether `around` ended up inside the returned page. */
  found: boolean;
}

export interface UseEventsOptions {
  api: ApiFn;
  sessionID: string | null;
  filters: EventFilters;
}

export interface UseEventsResult extends EventsState {
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loadEarlier(): void;
  loadNewer(): void;
  jumpToLatest(): void;
  /**
   * Loads the page centred on `eventID`. Pass `filtersOverride` when the caller
   * is about to clear the filters: the load then uses the new filters directly,
   * and the effect that follows the filter state change sees the same key and
   * does not issue a second, uncentred request.
   */
  loadAround(eventID: string, filtersOverride?: EventFilters): Promise<boolean>;
}

const EMPTY_STATE: EventsState = Object.freeze({
  events: Object.freeze([]) as unknown as NormalizedEvent[],
  page: null,
  status: "ready",
  error: null,
  op: null,
  revision: 0,
});

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function requestKey(sessionID: string, filters: EventFilters): string {
  return `${sessionID}\u0000${filtersKey(filters)}`;
}

/**
 * The paged events controller. It ports `loadEvents` (`app.js:508-582`),
 * including the page carry-over rules:
 *
 * - reset replaces the list and the page cursor;
 * - "earlier" merges backwards (prepend, dedupe, sort by `orderKey`) and keeps
 *   `after` / `hasMoreAfter` from the previous page, setting `hasMoreAfter` true
 *   when the merge added rows;
 * - "later" merges forwards and keeps `before` / `hasMoreBefore`;
 * - "around" behaves like a reset centred on the requested event.
 *
 * Every request is guarded by a sequence number plus an `AbortController`, the
 * Phase 2 discipline: StrictMode's double mount aborts the first request and a
 * late response can never overwrite a newer page.
 */
export function useEvents(options: UseEventsOptions): UseEventsResult {
  const { api, sessionID, filters } = options;
  const [state, setState] = useState<EventsState>({
    ...EMPTY_STATE,
    status: "loading",
  });

  const filtersRef = useRef(filters);
  const sessionRef = useRef(sessionID);
  const stateRef = useRef(state);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const loadedKey = useRef("");

  filtersRef.current = filters;
  sessionRef.current = sessionID;
  stateRef.current = state;

  const load = useCallback(
    async (
      op: LoadOp,
      request: { around?: string; filters?: EventFilters } = {},
    ): Promise<LoadResult> => {
      const session = sessionRef.current;
      if (!session) return { ok: false, found: false };
      const usedFilters = request.filters ?? filtersRef.current;
      const ticket = ++sequence.current;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;

      const previousPage = stateRef.current.page;
      const params = eventsQueryParams(
        usedFilters,
        op === "earlier"
          ? { before: previousPage?.before }
          : op === "later"
            ? { after: previousPage?.after }
            : op === "around"
              ? { around: request.around }
              : {},
      );

      // Claim the key before the request settles: a caller that clears the
      // filters in the same tick (the `?event=` deep link) makes the follow-up
      // effect see this key and skip its own uncentred reset.
      loadedKey.current = requestKey(session, usedFilters);
      setState((previous) => ({ ...previous, status: "loading", error: null }));

      try {
        const data = await api<EventsResponse>(
          `/api/sessions/${encodeURIComponent(session)}/events`,
          params,
          { signal: controller.signal },
        );
        if (ticket !== sequence.current) return { ok: false, found: false };

        let events: NormalizedEvent[] = data.events ?? [];
        let page: PageMeta = data.page;
        if (op === "earlier" || op === "later") {
          const direction: PageDirection = op === "later" ? "forward" : "backward";
          // `mergePages(existing, incoming, …)`: `existing` is what the ledger
          // already holds, `incoming` is the freshly loaded page.
          const merged = mergePages(
            stateRef.current.events,
            data.events ?? [],
            direction,
            (event) => event.orderKey,
          );
          events = merged.items;
          page =
            op === "later"
              ? {
                  ...data.page,
                  before: previousPage?.before ?? data.page.before,
                  hasMoreBefore: previousPage?.hasMoreBefore ?? data.page.hasMoreBefore,
                }
              : {
                  ...data.page,
                  after: previousPage?.after ?? data.page.after,
                  hasMoreBefore: data.page.hasMoreBefore,
                  hasMoreAfter: merged.added > 0 ? true : data.page.hasMoreAfter,
                };
        }

        setState((previous) => ({
          events,
          page,
          status: "ready",
          error: null,
          op,
          revision: previous.revision + 1,
        }));
        return {
          ok: true,
          found: request.around ? events.some((event) => event.id === request.around) : false,
        };
      } catch (failure) {
        if (ticket !== sequence.current || controller.signal.aborted) {
          return { ok: false, found: false };
        }
        // The page was never adopted, so the next dependency change must retry.
        loadedKey.current = "";
        setState((previous) => ({
          ...previous,
          status: "error",
          error: errorMessage(failure),
          op,
        }));
        return { ok: false, found: false };
      }
    },
    [api],
  );

  // A session or filter change resets to the first (newest) matching page. The
  // key check keeps the request issued by `loadAround` from being replayed.
  useEffect(() => {
    if (!sessionID) {
      sequence.current += 1;
      active.current?.abort();
      loadedKey.current = "";
      setState(EMPTY_STATE);
      return;
    }
    if (loadedKey.current === requestKey(sessionID, filters)) return;
    void load("reset");
  }, [sessionID, filters, load]);

  useEffect(
    () => () => {
      sequence.current += 1;
      active.current?.abort();
    },
    [],
  );

  const loadEarlier = useCallback(() => {
    if (!stateRef.current.page?.hasMoreBefore) return;
    void load("earlier");
  }, [load]);

  const loadNewer = useCallback(() => {
    if (!stateRef.current.page?.hasMoreAfter) return;
    void load("later");
  }, [load]);

  const jumpToLatest = useCallback(() => {
    void load("reset");
  }, [load]);

  const loadAround = useCallback(
    async (eventID: string, filtersOverride?: EventFilters): Promise<boolean> => {
      const result = await load("around", { around: eventID, filters: filtersOverride });
      return result.found;
    },
    [load],
  );

  return useMemo(
    () => ({
      ...state,
      hasMoreBefore: state.page?.hasMoreBefore === true,
      hasMoreAfter: state.page?.hasMoreAfter === true,
      loadEarlier,
      loadNewer,
      jumpToLatest,
      loadAround,
    }),
    [state, loadEarlier, loadNewer, jumpToLatest, loadAround],
  );
}

/* --------------------------------------------------------------- analysis */

export type AnalysisStatus = "loading" | "ready" | "error";

export interface AnalysisState {
  analysis: Analysis | null;
  /**
   * The route-level `guardrails` sibling the analysis route returns when the
   * browser sent its budgets (`http.ts:907-917`). Never an `Analysis` field.
   */
  guardrails: Guardrails | null;
  status: AnalysisStatus;
  error: string | null;
}

interface AnalysisResponse {
  analysis?: Analysis;
  guardrails?: Guardrails;
  revealAllowed?: boolean;
}

/**
 * The session analysis the ledger needs for its turn/step headers and its
 * compaction transactions, plus the guardrails sibling. `getSession` is not
 * fetched here: the header that used it lands in a later phase, and the ledger
 * never reads it.
 *
 * `params` carries the six `gr.*` budgets (`settings.guardrailParams()`), all
 * always sent in the documented order. The three renderer preferences
 * (`contextBasis`, `responseLimit`, `showEventRows`) are not request parameters
 * in the legacy request either (`app.js:463-470`); the caller applies them when
 * it renders.
 */
export function useSessionAnalysis(options: {
  api: ApiFn;
  sessionID: string | null;
  params?: ApiParams;
  /**
   * Set when this mount is the manual Refresh pass: the first analysis request
   * carries `refresh: 1` so the server drops its dataset cache. Later param
   * changes in the same mount never repeat the force.
   */
  refresh?: boolean;
}): AnalysisState {
  const { api, sessionID, refresh = false } = options;
  const paramsRef = useRef<ApiParams | undefined>(options.params);
  paramsRef.current = options.params;
  const paramsKey = options.params ? JSON.stringify(options.params) : "";
  const forced = useRef(false);
  const [state, setState] = useState<AnalysisState>({
    analysis: null,
    guardrails: null,
    status: "loading",
    error: null,
  });
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionID) {
      sequence.current += 1;
      active.current?.abort();
      setState({ analysis: null, guardrails: null, status: "ready", error: null });
      return;
    }
    const ticket = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ analysis: null, guardrails: null, status: "loading", error: null });
    const force = refresh && !forced.current;
    if (force) forced.current = true;
    void (async () => {
      try {
        const data = await api<AnalysisResponse>(
          `/api/sessions/${encodeURIComponent(sessionID)}/analysis`,
          withRefresh(paramsRef.current, force),
          { signal: controller.signal },
        );
        if (ticket !== sequence.current) return;
        setState({
          analysis: data.analysis ?? null,
          guardrails: data.guardrails ?? null,
          status: data.analysis ? "ready" : "error",
          error: data.analysis ? null : "The analysis response was empty",
        });
      } catch (failure) {
        if (ticket !== sequence.current || controller.signal.aborted) return;
        setState({
          analysis: null,
          guardrails: null,
          status: "error",
          error: errorMessage(failure),
        });
      }
    })();
    return () => controller.abort();
    // `refresh` is deliberately not a dependency: it is a one-shot read for this
    // mount, and the caller clears the flag after the request is issued.
  }, [api, sessionID, paramsKey]);

  return state;
}

/* ------------------------------------------------------------- diagnostics */

export type DiagnosticsStatus = "loading" | "ready" | "error";

export interface DiagnosticsState {
  diagnostics: Diagnostics | null;
  incidents: readonly DiagnosticIncident[];
  status: DiagnosticsStatus;
  error: string | null;
}

interface DiagnosticsResponse {
  diagnostics?: Diagnostics;
  revealAllowed?: boolean;
}

/**
 * `GET /api/sessions/:id/diagnostics`, the route-level diagnostics sibling
 * (never an `Analysis` rider). Same sequence/abort discipline as `useSessions`.
 */
export function useSessionDiagnostics(options: {
  api: ApiFn;
  sessionID: string | null;
}): DiagnosticsState {
  const { api, sessionID } = options;
  const [state, setState] = useState<DiagnosticsState>({
    diagnostics: null,
    incidents: [],
    status: "loading",
    error: null,
  });
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionID) {
      sequence.current += 1;
      active.current?.abort();
      setState({ diagnostics: null, incidents: [], status: "ready", error: null });
      return;
    }
    const ticket = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ diagnostics: null, incidents: [], status: "loading", error: null });
    void (async () => {
      try {
        const data = await api<DiagnosticsResponse>(
          `/api/sessions/${encodeURIComponent(sessionID)}/diagnostics`,
          {},
          { signal: controller.signal },
        );
        if (ticket !== sequence.current) return;
        const diagnostics = data.diagnostics ?? null;
        setState({
          diagnostics,
          incidents: diagnostics?.incidents ?? [],
          status: "ready",
          error: null,
        });
      } catch (failure) {
        if (ticket !== sequence.current || controller.signal.aborted) return;
        setState({
          diagnostics: null,
          incidents: [],
          status: "error",
          error: errorMessage(failure),
        });
      }
    })();
    return () => controller.abort();
  }, [api, sessionID]);

  return state;
}

/* ------------------------------------------------------------ event detail */

export type DetailStatus = "idle" | "loading" | "ready" | "error";

export interface EventDetailState {
  event: NormalizedEvent | null;
  status: DetailStatus;
  error: string | null;
}

interface EventDetailResponse {
  event?: NormalizedEvent;
  revealAllowed?: boolean;
}

/**
 * `GET /api/sessions/:id/events/:eventID` with the same request-id/sequence
 * discipline as `useSessions`: a late detail response can never replace the
 * drawer contents of a newer event or session.
 */
export function useEventDetail(options: {
  api: ApiFn;
  sessionID: string | null;
  eventID: string | null;
}): EventDetailState {
  const { api, sessionID, eventID } = options;
  const [state, setState] = useState<EventDetailState>({
    event: null,
    status: "idle",
    error: null,
  });
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionID || !eventID) {
      sequence.current += 1;
      active.current?.abort();
      setState({ event: null, status: "idle", error: null });
      return;
    }
    const ticket = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ event: null, status: "loading", error: null });
    void (async () => {
      try {
        const data = await api<EventDetailResponse>(
          `/api/sessions/${encodeURIComponent(sessionID)}/events/${encodeURIComponent(eventID)}`,
          {},
          { signal: controller.signal },
        );
        if (ticket !== sequence.current) return;
        if (!data.event) {
          setState({ event: null, status: "error", error: "Event not found" });
          return;
        }
        setState({ event: data.event, status: "ready", error: null });
      } catch (failure) {
        if (ticket !== sequence.current || controller.signal.aborted) return;
        setState({ event: null, status: "error", error: errorMessage(failure) });
      }
    })();
    return () => controller.abort();
  }, [api, sessionID, eventID]);

  return state;
}
