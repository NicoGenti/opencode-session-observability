import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { ApiFn } from "../lib/api.ts";
import type { LiveFrame } from "../lib/live.ts";
import type { NormalizedEvent, Analysis } from "../../core/types.ts";
import {
  applyAdvancedValues,
  buildFacets,
  emptyFilters,
  filtersActive,
  type EventFilters,
} from "../lib/event-filters.ts";
import {
  buildLedgerRows,
  clampCursor,
  type LedgerRow,
} from "../lib/ledger.ts";
import { failureHighlight } from "../lib/diagnostics.ts";
import { formatNumber } from "../lib/format.ts";
import { consumeLedgerScroll, pendingLedgerScroll } from "../lib/ledger-scroll.ts";
import { guardrailParams } from "../lib/settings.ts";
import { useSettings } from "../providers/SettingsProvider.tsx";
import {
  useEvents,
  useSessionAnalysis,
  useSessionDiagnostics,
} from "../hooks/useEvents.ts";
import { Badge } from "./Badge.tsx";
import { DiagnosticsSection } from "./DiagnosticsSection.tsx";
import { EventDrawer } from "./EventDrawer.tsx";
import { EventFiltersBar } from "./EventFilters.tsx";
import { AdvancedFiltersDialog } from "./AdvancedFiltersDialog.tsx";
import { GuardrailsSection } from "./GuardrailsSection.tsx";
import { Ledger, type LedgerHandle } from "./Ledger.tsx";
import { LiveBadge } from "./LiveBadge.tsx";
import { LiveWarnings } from "./LiveWarnings.tsx";

export interface TrajectoryHandle {
  /** Moves the keyboard cursor to an event index (0-based). */
  selectEvent(index: number): void;
  /** Opens the cursor event in the drawer. */
  openCursor(): void;
  scrollTo(where: "top" | "bottom"): void;
  /** Focuses the event search field (`/`). */
  focusSearch(): void;
  /** Focuses the cursor row (drawer close). */
  focusCursor(): void;
  /** Scrolls to an event row without opening it. */
  revealEvent(eventID: string): void;
}

export interface TrajectoryViewProps {
  api: ApiFn;
  sessionID: string;
  eventID: string | null;
  filters: EventFilters;
  onFiltersChange(next: EventFilters): void;
  onOpenEvent(eventID: string | null): void;
  onLedgerState(state: { eventCount: number; cursorIndex: number }): void;
  onError(message: string): void;
  onOpenSession(sessionID: string): void;
  controller: MutableRefObject<TrajectoryHandle | null>;
  /** The live frame and first-poll failure, owned by the app's single poller. */
  live?: { frame: LiveFrame | null; error: string | null };
  /** Drawer copy actions (`app.js:2801-2863`). */
  onCopyText?(text: string, success: string): void;
  onCopyMetrics?(event: NormalizedEvent): void;
  onCopyTurnChain?(event: NormalizedEvent): void;
  /**
   * The loaded analysis, so the live poller can seed its `since` cursor from the
   * last event the page already holds (`app.js:4028-4043`).
   */
  onAnalysis?(analysis: Analysis | null): void;
  /** This mount carries the manual `refresh: 1` analysis request. */
  forceRefresh?: boolean;
  /** Clears the one-shot force after the first analysis request is issued. */
  onForceConsumed?(): void;
  /** Reports the session-data load, which pauses the live poll. */
  onDataLoading?(loading: boolean): void;
}

/** Focuses an already-rendered ledger row by its event id. */
function focusEventRow(eventID: string): boolean {
  const scroller = globalThis.document?.getElementById("ledger-scroll");
  if (!scroller) return false;
  for (const row of scroller.querySelectorAll<HTMLElement>("[data-event-id]")) {
    if (row.dataset.eventId === eventID) {
      row.focus();
      return true;
    }
  }
  return false;
}

/**
 * The Trajectory view: filter bar, legend, recovery map, the virtualised ledger,
 * its footer, the advanced dialog and the detail drawer.
 *
 * Data flow mirrors `loadSessionData` (`app.js:454-503`): the analysis supplies
 * the turn/step headers and the compaction transactions, the events route the
 * paged ledger, and the diagnostics route the recovery map. The `?event=` route
 * is the single source of truth for "which drawer is open"; the view ensures the
 * containing page is loaded (clearing filters first, exactly like
 * `ensureEventLoaded`), scrolls the row into view and lets the drawer fetch the
 * detail.
 */
export function TrajectoryView({
  api,
  sessionID,
  eventID,
  filters,
  onFiltersChange,
  onOpenEvent,
  onLedgerState,
  onError,
  onOpenSession,
  controller,
  live,
  onCopyText,
  onCopyMetrics,
  onCopyTurnChain,
  onAnalysis,
  forceRefresh,
  onForceConsumed,
  onDataLoading,
}: TrajectoryViewProps) {
  const settings = useSettings();
  const analysisParams = useMemo(
    () => guardrailParams(settings.guardrails),
    [settings.guardrails],
  );
  const analysis = useSessionAnalysis({
    api,
    sessionID,
    params: analysisParams,
    refresh: forceRefresh,
  });
  const diagnostics = useSessionDiagnostics({ api, sessionID });
  const events = useEvents({ api, sessionID, filters });

  // The analysis effect above has issued the one forced request; later mounts
  // (session switch, reveal, live pass) must not repeat it.
  useEffect(() => {
    onForceConsumed?.();
  }, [onForceConsumed]);

  // The live poll pauses while session data is in flight, not only while the
  // sidebar list reloads (legacy `state.loading`, `app.js:4106`).
  useEffect(() => {
    onDataLoading?.(
      analysis.status === "loading" || events.status === "loading",
    );
    return () => onDataLoading?.(false);
  }, [analysis.status, events.status, onDataLoading]);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cursorEventID, setCursorEventID] = useState<string | null>(null);
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set());

  const ledgerRef = useRef<LedgerHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const advancedOpener = useRef<HTMLElement | null>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const eventsRef = useRef(events.events);
  const cursorRef = useRef(cursorEventID);
  eventsRef.current = events.events;
  cursorRef.current = cursorEventID;

  const rows = useMemo<LedgerRow[]>(
    () => buildLedgerRows(events.events, analysis.analysis?.turns ?? []),
    [events.events, analysis.analysis],
  );
  const facets = useMemo(
    () => buildFacets(analysis.analysis?.events ?? []),
    [analysis.analysis],
  );
  const knownEventIDs = useMemo(
    () => new Set((analysis.analysis?.events ?? []).map((event) => event.id)),
    [analysis.analysis],
  );
  const cursorIndex = cursorEventID
    ? events.events.findIndex((event) => event.id === cursorEventID)
    : -1;

  useEffect(() => {
    onLedgerState({ eventCount: events.events.length, cursorIndex });
  }, [events.events.length, cursorIndex, onLedgerState]);

  // The live `since` cursor falls back to the last event the page already holds.
  useEffect(() => {
    onAnalysis?.(analysis.analysis);
  }, [analysis.analysis, onAnalysis]);

  // DR-4/DR-10: the opened event rebuilds the incident highlight from the stored
  // DTO; closing the drawer leaves the highlight in place.
  useEffect(() => {
    if (!eventID) return;
    setHighlight(new Set(failureHighlight(diagnostics.incidents, eventID, knownEventIDs)));
  }, [eventID, diagnostics.incidents, knownEventIDs]);

  const openRow = useCallback(
    (id: string) => {
      // The drawer is opened programmatically (route change), so Radix has no
      // Dialog.Trigger to restore. Remember the opener here and put focus back
      // on it — or on the ledger cursor — when the drawer closes.
      const active = globalThis.document?.activeElement;
      if (!eventID && active instanceof HTMLElement) {
        drawerOpener.current = active;
      }
      setCursorEventID(id);
      onOpenEvent(id);
    },
    [eventID, onOpenEvent],
  );

  const closeDrawer = useCallback(() => {
    onOpenEvent(null);
  }, [onOpenEvent]);

  /**
   * Radix runs this from `onCloseAutoFocus` on the content's unmount. It is the
   * only deterministic moment to restore the opener: a programmatic dialog has
   * no `Dialog.Trigger`, so Radix's own restore targets nothing.
   */
  const restoreDrawerFocus = useCallback(() => {
    const opener = drawerOpener.current;
    drawerOpener.current = null;
    if (opener?.isConnected) {
      opener.focus();
      return;
    }
    const id = cursorRef.current;
    if (id && focusEventRow(id)) return;
    const index = id
      ? eventsRef.current.findIndex((event) => event.id === id)
      : -1;
    if (index >= 0 && ledgerRef.current) {
      ledgerRef.current.focusIndex(index);
      return;
    }
    globalThis.document?.getElementById("ledger-scroll")?.focus();
  }, []);

  const openAdvanced = useCallback(() => {
    const active = globalThis.document?.activeElement;
    advancedOpener.current =
      active instanceof HTMLElement
        ? active
        : globalThis.document?.getElementById("advanced-filters-btn") ?? null;
    setAdvancedOpen(true);
  }, []);

  const changeAdvanced = useCallback((open: boolean) => {
    setAdvancedOpen(open);
  }, []);

  const restoreAdvancedFocus = useCallback(() => {
    const opener =
      advancedOpener.current ??
      globalThis.document?.getElementById("advanced-filters-btn") ??
      null;
    advancedOpener.current = null;
    opener?.focus();
  }, []);

  // A reveal toggle and a live heavy pass re-key the view (`App.tsx`), which
  // destroys the ledger scroller. The offset to put back is read once, before
  // the new scroller exists; the ledger applies it as soon as the first page has
  // height (`app.js:638`). `pendingLedgerScroll` is pure; the caller consumes the
  // record in this initializer so no render path mutates module state.
  const [restoreTop] = useState<number | null>(() => {
    const top = pendingLedgerScroll(sessionID, eventID);
    consumeLedgerScroll();
    return top;
  });
  const restoreConsumed = useRef(false);

  // `?event=` deep link: load the containing page if it is not in the current
  // window, scroll to it, then let the drawer fetch the detail. A route change
  // to the same event after a close re-arms the effect.
  const handledDeepLink = useRef<string | null>(null);
  useEffect(() => {
    if (!eventID) handledDeepLink.current = null;
  }, [eventID]);

  useEffect(() => {
    // Wait for the analysis to settle: it decides whether the event exists at
    // all. When the analysis failed we still try the centred page, matching the
    // legacy drawer fetch that ran regardless of `ensureEventLoaded`'s result.
    if (!eventID || analysis.status === "loading") return;
    const marker = `${sessionID}\u0000${eventID}`;
    if (handledDeepLink.current === marker) return;
    handledDeepLink.current = marker;
    if (analysis.status === "ready" && !knownEventIDs.has(eventID)) return;
    setCursorEventID(eventID);
    if (eventsRef.current.some((event) => event.id === eventID)) {
      setPendingReveal(eventID);
      return;
    }
    // `ensureEventLoaded` cleared the filters *before* the around request
    // (`app.js:2555`), so a found-or-not result still leaves the view unfiltered.
    const override = filtersActive(filters) ? emptyFilters() : undefined;
    if (override) onFiltersChange(override);
    void (async () => {
      const found = await events.loadAround(eventID, override);
      if (!found) return;
      setPendingReveal(eventID);
    })();
  }, [eventID, sessionID, analysis.status, knownEventIDs, events, filters, onFiltersChange]);

  useEffect(() => {
    if (!pendingReveal) return;
    const index = rows.findIndex(
      (row) => row.type === "event" && row.eventID === pendingReveal,
    );
    if (index < 0) return;
    ledgerRef.current?.scrollToIndex(index);
    setPendingReveal(null);
  }, [pendingReveal, rows]);

  // Legacy reset scrolling (`renderTrajectory`): a reset without filters lands on
  // the newest event; with filters it lands on the newest matching event's page
  // top. "Jump to latest" always lands at the bottom.
  const jumpBottom = useRef(false);
  // A failed jump-to-latest must not leave the flag armed for a later reset.
  useEffect(() => {
    if (events.status === "error") jumpBottom.current = false;
  }, [events.error, events.status]);

  const lastRevision = useRef(events.revision);
  useLayoutEffect(() => {
    if (events.revision === lastRevision.current) return;
    lastRevision.current = events.revision;
    if (pendingReveal) return;
    if (events.op !== "reset") return;
    // The first reset after a re-mount belongs to the ledger's one-shot restore,
    // not to the legacy "newest page" landing (`app.js:565-567, 638`). An explicit
    // "Jump to latest" still wins.
    if (
      !jumpBottom.current &&
      restoreTop !== null &&
      !restoreConsumed.current
    ) {
      restoreConsumed.current = true;
      return;
    }
    if (jumpBottom.current || !filtersActive(filters)) {
      jumpBottom.current = false;
      ledgerRef.current?.scrollToBottom();
    } else {
      ledgerRef.current?.scrollToTop();
    }
  }, [events.revision, events.op, filters, pendingReveal, restoreTop]);

  // The cursor row is scrolled and focused once per cursor move; later page
  // changes never steal focus.
  const focusedCursor = useRef<string | null>(null);
  useEffect(() => {
    if (!cursorEventID) {
      focusedCursor.current = null;
      return;
    }
    if (focusedCursor.current === cursorEventID) return;
    const index = rows.findIndex(
      (row) => row.type === "event" && row.eventID === cursorEventID,
    );
    if (index < 0) return;
    focusedCursor.current = cursorEventID;
    ledgerRef.current?.focusIndex(index);
  }, [cursorEventID, rows]);

  const handle = useMemo<TrajectoryHandle>(
    () => ({
      selectEvent(index: number): void {
        const list = eventsRef.current;
        const next = clampCursor(index, list.length);
        const event = next >= 0 ? list[next] : null;
        if (!event) return;
        setCursorEventID(event.id);
      },
      openCursor(): void {
        const id = cursorRef.current;
        if (id) openRow(id);
      },
      scrollTo(where: "top" | "bottom"): void {
        if (where === "top") ledgerRef.current?.scrollToTop();
        else ledgerRef.current?.scrollToBottom();
      },
      focusSearch(): void {
        searchRef.current?.focus();
      },
      focusCursor(): void {
        const id = cursorRef.current;
        if (!id) return;
        const index = eventsRef.current.findIndex((event) => event.id === id);
        if (index >= 0) ledgerRef.current?.focusIndex(index);
      },
      revealEvent(id: string): void {
        setPendingReveal(id);
      },
    }),
    [openRow],
  );

  useEffect(() => {
    controller.current = handle;
    return () => {
      if (controller.current === handle) controller.current = null;
    };
  }, [controller, handle]);

  const compactions = analysis.analysis?.compactions ?? [];
  const loaded = events.events.length;
  const total = events.page?.totalMatched ?? loaded;
  const all = events.page?.totalInSession ?? total;
  const empty = events.events.length === 0 && events.status === "ready";

  const jumpToLatest = (): void => {
    jumpBottom.current = true;
    events.jumpToLatest();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
       * Live mode sits above the guardrails block and above the pane, exactly as
       * `#live-warnings` sits above `#guardrails` above `#view` in the legacy
       * document (`index.html:82-86`).
       */}
      {live && (live.frame || live.error) ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-1.5">
          <LiveBadge frame={live.frame} error={live.error} />
        </div>
      ) : null}
      {live && live.frame ? (
        <LiveWarnings warnings={live.frame.warnings ?? []} onDrill={openRow} />
      ) : null}
      <GuardrailsSection
        guardrails={analysis.guardrails}
        turns={analysis.analysis?.turns ?? []}
        onDrill={openRow}
      />
      <EventFiltersBar
        filters={filters}
        facets={facets}
        searchRef={searchRef}
        advancedOpen={advancedOpen}
        onChange={onFiltersChange}
        onOpenAdvanced={openAdvanced}
      />

      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-[11.5px] text-text-2">
        <span>
          {formatNumber(loaded)} loaded · {formatNumber(total)} matched ·{" "}
          {formatNumber(all)} in session
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <Badge label="M" /> measured
        </span>
        <span className="inline-flex items-center gap-1">
          <Badge label="D" /> derived
        </span>
        <span className="inline-flex items-center gap-1">
          <Badge label="E" /> estimated
        </span>
        <span aria-hidden="true">·</span>
        <span>
          TTFT, approvals, request headers and tool-set changes are not recorded by
          OpenCode 2.
        </span>
      </div>

      <DiagnosticsSection
        incidents={diagnostics.incidents}
        status={diagnostics.status}
        error={diagnostics.error}
        onDrill={openRow}
      />

      {empty ? (
        <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-2 border border-border bg-surface px-5 py-12 text-center text-text-2">
          <h3 className="m-0 text-[13px] font-semibold text-text">No events match</h3>
          <p className="m-0 text-[12.5px]">
            Adjust the filters or clear them to see the full session.
          </p>
          <button
            type="button"
            id="empty-clear"
            onClick={() => onFiltersChange(emptyFilters())}
            className="rounded-sm border border-border-strong bg-surface-2 px-2.5 py-1 text-[12.5px] text-text"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <Ledger
          sessionID={sessionID}
          restoreScrollTop={restoreTop}
          rows={rows}
          selectedEventID={eventID}
          cursorEventID={cursorEventID}
          highlightedEventIDs={highlight}
          revision={events.revision}
          status={events.status}
          error={events.error}
          controller={ledgerRef}
          onOpen={openRow}
        />
      )}

      <div className="flex flex-wrap items-center gap-2.5 border border-t-0 border-border bg-surface px-3 py-2 text-[12px] text-text-2">
        <span className="min-w-0 flex-1">
          {events.page
            ? `Order: recorded seq${
                events.hasMoreBefore ? " · earlier events available" : ""
              }`
            : ""}
        </span>
        <button
          type="button"
          id="load-earlier"
          disabled={!events.hasMoreBefore}
          onClick={events.loadEarlier}
          className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2 disabled:text-muted"
        >
          Load earlier
        </button>
        <button
          type="button"
          id="load-newer"
          disabled={!events.hasMoreAfter}
          onClick={events.loadNewer}
          className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2 disabled:text-muted"
        >
          Load newer
        </button>
        <button
          type="button"
          id="jump-latest"
          onClick={jumpToLatest}
          className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2"
        >
          Jump to latest
        </button>
      </div>

      <AdvancedFiltersDialog
        open={advancedOpen}
        onOpenChange={changeAdvanced}
        filters={filters}
        facets={facets}
        onApply={(values) => onFiltersChange(applyAdvancedValues(filters, values))}
        onRestoreFocus={restoreAdvancedFocus}
      />

      <EventDrawer
        api={api}
        sessionID={sessionID}
        eventID={eventID}
        compactions={compactions}
        onClose={closeDrawer}
        onRestoreFocus={restoreDrawerFocus}
        onError={onError}
        onOpenEvent={openRow}
        onOpenSession={onOpenSession}
        onCopy={(text, success) => onCopyText?.(text, success)}
        onCopyMetrics={(event) => onCopyMetrics?.(event)}
        onCopyTurnChain={(event) => onCopyTurnChain?.(event)}
      />
    </div>
  );
}
