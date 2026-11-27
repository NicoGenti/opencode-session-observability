import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "../core/types.ts";
import { AuthProvider, useAuth } from "./providers/AuthProvider.tsx";
import { SettingsProvider, useSettings } from "./providers/SettingsProvider.tsx";
import { ThemeProvider, useTheme } from "./providers/ThemeProvider.tsx";
import { TokenPromptDialog } from "./components/TokenPromptDialog.tsx";
import { Shell } from "./components/Shell.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Topbar } from "./components/Topbar.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { ShortcutsDialog } from "./components/ShortcutsDialog.tsx";
import { ConfirmDialog, useConfirmController } from "./components/ConfirmDialog.tsx";
import { CompareModal } from "./components/CompareModal.tsx";
import { BenchmarkView } from "./components/BenchmarkView.tsx";
import { RevealBanner } from "./components/RevealBanner.tsx";
import { Toast } from "./components/Toast.tsx";
import { type ExportKind } from "./lib/copy.ts";
import { useTokenPrompt } from "./hooks/useTokenPrompt.ts";
import { useSessions } from "./hooks/useSessions.ts";
import { useExport } from "./hooks/useExport.ts";
import { useLivePoll } from "./hooks/useLivePoll.ts";
import { useReveal, type RevealState } from "./hooks/useReveal.ts";
import { ToastController } from "./lib/toast.ts";
import {
  useKeyboardShortcuts,
  type ShortcutCommand,
} from "./hooks/useKeyboardShortcuts.ts";
import {
  applyFilterShortcut,
  emptyFilters,
  filtersActive,
  type EventFilters,
} from "./lib/event-filters.ts";
import { ApiError, createApiClient } from "./lib/api.ts";
import { parseBenchmarkFilters } from "./lib/benchmark.ts";
import {
  benchmarkFragment,
  readRoute,
  withRoute,
  writeSessionRoute,
  type Route,
  type SessionView,
} from "./lib/hash.ts";
import {
  TrajectoryView,
  type TrajectoryHandle,
} from "./components/TrajectoryView.tsx";
import { StatisticsView } from "./components/StatisticsView.tsx";

const TABS: readonly { id: SessionView; label: string }[] = Object.freeze([
  Object.freeze({ id: "trajectory", label: "Trajectory" }),
  Object.freeze({ id: "statistics", label: "Statistics" }),
]);

type Overlay = "settings" | "shortcuts" | null;

function currentHash(): string {
  return typeof globalThis.location?.hash === "string" ? globalThis.location.hash : "";
}

function ViewTabs({
  active,
  onSelect,
}: {
  active: Route["view"];
  onSelect(view: SessionView): void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Session views"
      className="flex items-center gap-1 border-b border-border bg-surface px-4 py-1"
    >
      {TABS.map((tab) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="view"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={
              selected
                ? "rounded-sm border-b-2 border-accent px-2 py-1 text-[12.5px] text-text"
                : "rounded-sm border-b-2 border-transparent px-2 py-1 text-[12.5px] text-text-2 hover:text-text"
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function NoSession() {
  return (
    <div className="grid gap-1">
      <h2 className="m-0 text-[13px] font-semibold text-text">No session selected</h2>
      <p className="m-0 text-[12.5px] text-text-2">Choose a session from the sidebar.</p>
    </div>
  );
}

function AppShell() {
  const auth = useAuth();
  const settings = useSettings();
  const theme = useTheme();
  const tokenPrompt = useTokenPrompt();
  const confirm = useConfirmController();

  const toastRef = useRef<ToastController | null>(null);
  if (toastRef.current === null) toastRef.current = new ToastController();
  const toast = toastRef.current;

  const initial = useMemo(() => readRoute(currentHash()), []);
  const [route, setRoute] = useState<Route>(initial);
  const [overlay, setOverlayState] = useState<Overlay>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filters, setFilters] = useState<EventFilters>(emptyFilters);
  const [ledgerState, setLedgerState] = useState({ eventCount: 0, cursorIndex: -1 });
  const [notice, setNotice] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  /**
   * Bumped by the live heavy pass, the reveal toggle and the Refresh button:
   * views re-request. `forceRefresh` is true only for the mount the Refresh
   * button produced, so only that analysis request carries `refresh: 1`.
   */
  const [dataEpoch, setDataEpoch] = useState(0);
  /** One-shot: the next view mount is the manual Refresh pass. */
  const forcePending = useRef(false);
  /** Session data (not only the sidebar list) is loading: the live poll pauses. */
  const [dataLoading, setDataLoading] = useState(false);
  /**
   * Bumped only when the effective database changes. The benchmark view keys its
   * request on this, so a DB switch refetches it without subscribing to the
   * unrelated `dataEpoch` bumps (Refresh, live heavy pass, reveal).
   */
  const [dbEpoch, setDbEpoch] = useState(0);

  const bumpData = useCallback(() => {
    setDataEpoch((epoch) => epoch + 1);
  }, []);
  const consumeForce = useCallback(() => {
    forcePending.current = false;
  }, []);

  const routeRef = useRef(route);
  const overlayRef = useRef<Overlay>(overlay);
  const trajectory = useRef<TrajectoryHandle | null>(null);
  const analysisRef = useRef<Analysis | null>(null);
  const compareOpener = useRef<HTMLElement | null>(null);

  // The api client reads reveal on every request, so the toggle takes effect on
  // the very next call; the React state below mirrors it for rendering.
  const revealRef = useRef<RevealState>({ allowed: false, reveal: false });
  // The api client is built before `useReveal`; this ref lets its shared sinks
  // reach the reveal controller without a dependency cycle.
  const revealSink = useRef<{
    forbid(): void;
    syncAllowed(allowed: boolean): void;
  } | null>(null);
  // The api client is also built before `handleDatabaseChanged`; this ref lets
  // the invalid_db self-heal reach the same clear + refetch path the dialog
  // uses, without moving the client below the handler.
  const databaseChangedSink = useRef<(() => void) | null>(null);

  /** The one request-error sink: `reveal_disabled` turns reveal off anywhere. */
  const handleRequestError = useCallback((error: ApiError) => {
    if (error.code === "reveal_disabled") revealSink.current?.forbid();
  }, []);

  const api = useMemo(
    () =>
      createApiClient({
        token: () => auth.token,
        revealAllowed: () => revealRef.current.allowed,
        reveal: () => revealRef.current.reveal,
        requestToken: () => tokenPrompt.requestToken(),
        acceptToken: auth.acceptToken,
        clearToken: auth.forgetToken,
        // Every JSON payload that carries the policy syncs the toggle, and every
        // handled failure runs the reveal recovery (`app.js:353-357`).
        onError: handleRequestError,
        onRevealAllowed: (allowed) => revealSink.current?.syncAllowed(allowed),
        // A 400 invalid_db self-heal cleared the stored key: clear the selected
        // session and refetch against the startup database, exactly like a
        // dialog-driven switch.
        onDatabaseKeyCleared: () => databaseChangedSink.current?.(),
      }),
    [auth, handleRequestError, tokenPrompt.requestToken],
  );

  const reveal = useReveal({
    api,
    confirm,
    toast,
    state: revealRef,
    onChanged: () => {
      forcePending.current = false;
      bumpData();
    },
    onServerTheme: theme.applyServerTheme,
  });
  revealSink.current = {
    forbid: reveal.forbid,
    syncAllowed: reveal.syncAllowed,
  };

  const sessions = useSessions({
    api,
    groupByProject: settings.groupByProject,
    sessionTree: settings.sessionTree,
  });
  const sessionsReload = sessions.reload;

  const exporter = useExport({
    api,
    toast,
    confirm,
    sessions: sessions.sessions,
    sessionID: route.sessionID,
    token: () => auth.token,
    reveal: () => revealRef.current.reveal,
    onError: (message, error) => {
      // The export path bypasses `api()` for its text response, so it reports
      // into the same sink: `reveal_disabled` goes off and the next request is
      // redacted (`app.js:353-357`).
      if (error instanceof ApiError) handleRequestError(error);
      setNotice(message);
    },
  });

  // The manual Refresh is legacy `refreshCurrent({ force: true })`: reload the
  // session list and re-request the session data, with `refresh: 1` on the
  // analysis so the server drops its dataset cache (`app.js:601-638`).
  const manualRefresh = useCallback(() => {
    const current = routeRef.current;
    // Only a mounted session view can carry the forced analysis request.
    forcePending.current =
      current.sessionID !== null && current.view !== "benchmark";
    sessionsReload();
    bumpData();
  }, [bumpData, sessionsReload]);

  // The live heavy pass is the same re-request without the force; it also
  // refreshes the sidebar so sessions created since the last load appear.
  const heavyRefresh = useCallback(() => {
    forcePending.current = false;
    sessionsReload();
    bumpData();
  }, [bumpData, sessionsReload]);

  const lastSeenOrderKey = useCallback((): string | null => {
    const events = analysisRef.current?.events ?? [];
    return events.length > 0 ? (events[events.length - 1]?.orderKey ?? null) : null;
  }, []);

  const live = useLivePoll({
    api,
    sessionID: route.sessionID,
    enabled: liveEnabled,
    // Legacy paused on `state.loading || state.refreshing` (`app.js:4106`): the
    // sidebar list and the session data are both part of the guard.
    paused: dataLoading || sessions.status === "loading",
    lastSeenOrderKey,
    onHeavyRefresh: heavyRefresh,
  });

  // Legacy `enterBenchmark()` stops the poll and unchecks the toggle
  // (`app.js:4171-4172`): a comparison is a standalone page, not a session frame.
  useEffect(() => {
    if (route.view === "benchmark" && liveEnabled) setLiveEnabled(false);
  }, [liveEnabled, route.view]);

  const setOverlay = useCallback((next: Overlay) => {
    overlayRef.current = next;
    setOverlayState(next);
  }, []);

  const navigate = useCallback((patch: Partial<Omit<Route, "kind">>) => {
    const next = withRoute(routeRef.current, patch);
    routeRef.current = next;
    setRoute(next);
    writeSessionRoute(globalThis.history, currentHash(), next);
  }, []);

  useEffect(() => {
    const onHashChange = (): void => {
      const next = readRoute(currentHash());
      routeRef.current = next;
      setRoute(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectSession = useCallback(
    (sessionID: string) => {
      // Legacy `selectSession()`: the session keeps the current view, and a
      // benchmark route falls back to Trajectory; `?event=` is cleared.
      const view: SessionView =
        routeRef.current.view === "statistics" ? "statistics" : "trajectory";
      // Legacy reset the filters, the cursor and the drawer before the new
      // session's first request (`app.js:424-432`), not after it.
      setFilters(emptyFilters());
      setLedgerState({ eventCount: 0, cursorIndex: -1 });
      navigate({ sessionID, view, eventID: null });
      setSidebarOpen(false);
    },
    [navigate],
  );

  // A database switch invalidates the selected session: its id belongs to the
  // old database. Clear the route first (detail/events/live stop targeting it),
  // then drive the same refresh path the Refresh button uses. The store write
  // happened before this callback, so the refetch reads the NEW key.
  const handleDatabaseChanged = useCallback(() => {
    navigate({ sessionID: null, eventID: null });
    const current = routeRef.current;
    // `writeSessionRoute` intentionally no-ops without a session; rewrite the
    // fragment so a reload cannot resurrect an id from the old database, while
    // keeping a benchmark route's filter query.
    try {
      globalThis.history.replaceState(
        null,
        "",
        current.view === "benchmark"
          ? benchmarkFragment(current.benchmarkQuery)
          : "#/",
      );
    } catch {
      // The address bar is cosmetic; the app state is already cleared.
    }
    analysisRef.current = null;
    setCompareOpen(false);
    setFilters(emptyFilters());
    setLedgerState({ eventCount: 0, cursorIndex: -1 });
    setDbEpoch((epoch) => epoch + 1);
    manualRefresh();
  }, [manualRefresh, navigate]);
  databaseChangedSink.current = handleDatabaseChanged;

  // A session switch clears the filters and the cursor, exactly as
  // `selectSession` did (`app.js:424-432`). The view is keyed by session, so its
  // own cursor state is discarded as well; this covers a hand-edited hash too.
  const lastSession = useRef(route.sessionID);
  useEffect(() => {
    if (lastSession.current === route.sessionID) return;
    lastSession.current = route.sessionID;
    setFilters((previous) => (filtersActive(previous) ? emptyFilters() : previous));
    setLedgerState({ eventCount: 0, cursorIndex: -1 });
  }, [route.sessionID]);

  // Legacy `clearError()` ran at the start of every session load
  // (`app.js:458`), so a new session or a fresh data epoch (Refresh, live heavy
  // pass, reveal toggle) starts from a clean banner instead of keeping the last
  // request error. The deps only change when a load starts, never per render.
  useEffect(() => {
    setNotice(null);
  }, [route.sessionID, dataEpoch]);

  const onLedgerState = useCallback(
    (state: { eventCount: number; cursorIndex: number }) => {
      setLedgerState((previous) =>
        previous.eventCount === state.eventCount &&
        previous.cursorIndex === state.cursorIndex
          ? previous
          : state,
      );
    },
    [],
  );

  const onAnalysis = useCallback((analysis: Analysis | null) => {
    analysisRef.current = analysis;
  }, []);

  const openEvent = useCallback(
    (eventID: string | null) => {
      navigate({ eventID, view: "trajectory" });
    },
    [navigate],
  );

  const onCommand = useCallback(
    (command: ShortcutCommand) => {
      switch (command.type) {
        case "close-sidebar":
          setSidebarOpen(false);
          break;
        case "toggle-shortcuts":
          setOverlay(overlayRef.current === "shortcuts" ? null : "shortcuts");
          break;
        case "close-shortcuts":
          setOverlay(null);
          break;
        case "focus-search":
          // The search field lives in the Trajectory filter bar; switching views
          // mounts it, so the focus is applied after the route has rendered.
          navigate({ view: "trajectory", eventID: null });
          requestAnimationFrame(() => trajectory.current?.focusSearch());
          break;
        case "set-view":
          // The detail drawer is Trajectory-scoped in this phase, so leaving the
          // view closes it instead of leaving a hidden dialog suppressing keys.
          navigate({ view: command.view, eventID: null });
          break;
        case "toggle-filter":
          setFilters((previous) => applyFilterShortcut(previous, command.filter));
          navigate({ view: "trajectory" });
          break;
        case "select-event":
          trajectory.current?.selectEvent(command.index);
          break;
        case "open-selected":
          trajectory.current?.openCursor();
          break;
        case "scroll":
          trajectory.current?.scrollTo(command.to);
          break;
      }
    },
    [navigate, setOverlay],
  );

  useKeyboardShortcuts(
    () => ({
      view: routeRef.current.view,
      overlay: routeRef.current.eventID
        ? "drawer"
        : compareOpen
          ? "dialog"
          : overlayRef.current === "shortcuts"
            ? "shortcuts"
            : overlayRef.current === "settings"
              ? "dialog"
              : null,
      selectedIndex: ledgerState.cursorIndex,
      eventCount: ledgerState.eventCount,
    }),
    onCommand,
  );

  const onExport = useCallback(
    (kind: ExportKind) => {
      void exporter.exportSession(kind);
    },
    [exporter],
  );

  const openCompare = useCallback(() => {
    const active = globalThis.document?.activeElement;
    compareOpener.current = active instanceof HTMLElement ? active : null;
    setCompareOpen(true);
  }, []);

  const restoreCompareFocus = useCallback(() => {
    const opener = compareOpener.current;
    compareOpener.current = null;
    opener?.focus();
  }, []);

  const benchmarkFilters = useMemo(
    () => parseBenchmarkFilters(route.benchmarkQuery),
    [route.benchmarkQuery],
  );
  const benchmarkOwned = useCallback(
    () => routeRef.current.view === "benchmark",
    [],
  );

  const activeTab: SessionView | null =
    route.view === "statistics"
      ? "statistics"
      : route.view === "trajectory"
        ? "trajectory"
        : null;

  // A heavy live pass or a reveal change re-mounts the view, which re-requests
  // the analysis, the events, the diagnostics and the guardrails sibling under
  // the current reveal state.
  const viewKey = `${route.sessionID ?? "none"}:${dataEpoch}`;

  return (
    <>
      <Shell
        sidebarOpen={sidebarOpen}
        labelledBy={activeTab ? `tab-${activeTab}` : undefined}
        sidebar={
          <Sidebar
            groups={sessions.groups}
            status={sessions.status}
            error={sessions.error}
            query={sessions.query}
            selectedSessionID={route.sessionID}
            expandedParents={sessions.expandedParents}
            onQueryChange={sessions.setQuery}
            onSelect={selectSession}
            onToggleProject={sessions.toggleProject}
            onToggleParent={sessions.toggleParent}
          />
        }
        topbar={
          <Topbar
            viewMode={settings.viewMode}
            onViewModeChange={(mode) => settings.setViewMode(mode)}
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
            onRefresh={manualRefresh}
            refreshing={sessions.status === "loading"}
            onSettings={() => setOverlay("settings")}
            onShortcuts={() => setOverlay("shortcuts")}
            onExport={onExport}
            live={liveEnabled}
            onToggleLive={setLiveEnabled}
            revealAllowed={reveal.allowed}
            reveal={reveal.reveal}
            onToggleReveal={() => void reveal.toggle()}
            canCompare={Boolean(route.sessionID)}
            onCompare={openCompare}
          />
        }
        banner={
          <>
            <RevealBanner reveal={reveal.reveal} />
            {notice ? (
              <div
                role="alert"
                className="border-b border-critical bg-surface-2 px-4 py-1.5 text-[12px] text-text"
              >
                {notice}
              </div>
            ) : null}
          </>
        }
        tabs={
          route.sessionID ? (
            <ViewTabs
              active={route.view}
              onSelect={(view) => navigate({ view, eventID: null })}
            />
          ) : null
        }
        view={
          route.view === "benchmark" ? (
            <BenchmarkView
              api={api}
              filters={benchmarkFilters}
              routeOwned={benchmarkOwned}
              dbEpoch={dbEpoch}
            />
          ) : route.sessionID && route.view === "trajectory" ? (
            <TrajectoryView
              key={viewKey}
              api={api}
              sessionID={route.sessionID}
              eventID={route.eventID}
              filters={filters}
              onFiltersChange={setFilters}
              onOpenEvent={openEvent}
              onLedgerState={onLedgerState}
              onError={setNotice}
              onOpenSession={selectSession}
              controller={trajectory}
              live={
                liveEnabled
                  ? { frame: live.frame, error: live.error }
                  : undefined
              }
              onAnalysis={onAnalysis}
              forceRefresh={forcePending.current}
              onForceConsumed={consumeForce}
              onDataLoading={setDataLoading}
              onCopyText={(text, success) => void exporter.copy(text, success)}
              onCopyMetrics={(event) => void exporter.copyMetrics(event)}
              onCopyTurnChain={(event) =>
                void exporter.copyTurnChain(event, analysisRef.current?.events ?? [])
              }
            />
          ) : route.sessionID && route.view === "statistics" ? (
            <StatisticsView
              key={viewKey}
              api={api}
              sessionID={route.sessionID}
              viewMode={settings.viewMode}
              onDrill={openEvent}
              onOpenSession={selectSession}
              forceRefresh={forcePending.current}
              onForceConsumed={consumeForce}
              onDataLoading={setDataLoading}
              onCopyAction={(action) =>
                void exporter.copyDigest({ prompt: action.id === "review" })
              }
            />
          ) : (
            <NoSession />
          )
        }
      />

      <SettingsDialog
        open={overlay === "settings"}
        onOpenChange={(open) => setOverlay(open ? "settings" : null)}
        onDatabaseChanged={handleDatabaseChanged}
      />
      <ShortcutsDialog
        open={overlay === "shortcuts"}
        onOpenChange={(open) => setOverlay(open ? "shortcuts" : null)}
      />
      <ConfirmDialog controller={confirm} />
      <CompareModal
        open={compareOpen}
        onOpenChange={setCompareOpen}
        api={api}
        sessionID={route.sessionID}
        onRestoreFocus={restoreCompareFocus}
        onError={setNotice}
      />
      <TokenPromptDialog
        open={tokenPrompt.open}
        onOpenChange={tokenPrompt.onOpenChange}
        onSubmit={tokenPrompt.onSubmit}
        copy={tokenPrompt.copy}
      />
      <Toast controller={toast} />
    </>
  );
}

/**
 * The provider order is the token contract: `AuthProvider` sits above the
 * router, and its `useState` initializer runs `consumeTokenFromLocation` before
 * any route can render. `ThemeProvider` and `SettingsProvider` apply their
 * persisted state in effects, so a StrictMode second pass is harmless.
 */
export function App() {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
