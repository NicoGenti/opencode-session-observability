import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiFn } from "../lib/api.ts";
import { guardrailParams, type ViewMode } from "../lib/settings.ts";
import { useSettings } from "../providers/SettingsProvider.tsx";
import { useSessionAnalysis, useSessionDiagnostics } from "../hooks/useEvents.ts";
import { formatTime } from "../lib/format.ts";
import {
  unattachedEvents,
  type CopyActionModel,
  type StatsTab,
} from "../lib/statistics.ts";
import { StatisticsBasic } from "./StatisticsBasic.tsx";
import { StatisticsAdvanced } from "./StatisticsAdvanced.tsx";
import { GuardrailsSection } from "./GuardrailsSection.tsx";
import { DiagnosticsSection } from "./DiagnosticsSection.tsx";
import { CompactionCards } from "./CompactionCards.tsx";

export interface StatisticsViewProps {
  api: ApiFn;
  sessionID: string | null;
  viewMode: ViewMode;
  /** Drill: sets `?event=` and reveals that row in Trajectory. */
  onDrill(eventID: string): void;
  onOpenSession(sessionID: string): void;
  /** The Advanced copy actions (`review` → review prompt, `digest` → digest). */
  onCopyAction(action: CopyActionModel): void;
  /** This mount carries the manual `refresh: 1` analysis request. */
  forceRefresh?: boolean;
  /** Clears the one-shot force after the first analysis request is issued. */
  onForceConsumed?(): void;
  /** Reports the session-data load, which pauses the live poll. */
  onDataLoading?(loading: boolean): void;
}

/**
 * The Statistics view (`renderStatistics`, `app.js:2293`) wired to the Phase 3
 * analysis hook. The `Basic`/`Advanced` split, the Table/Charts sub-tab and the
 * health panel are renderer state, exactly as legacy: none of them is a route,
 * so a `location.hash` change never switches them.
 *
 * The analysis request carries the six `gr.*` budgets, in the documented order,
 * from the settings store; the renderer preferences (`contextBasis`,
 * `responseLimit`, `showEventRows`) are applied here, not sent. Guardrails stay
 * app-wide above the active pane, in both modes.
 */
export function StatisticsView({
  api,
  sessionID,
  viewMode,
  onDrill,
  onOpenSession,
  onCopyAction,
  forceRefresh,
  onForceConsumed,
  onDataLoading,
}: StatisticsViewProps) {
  const settings = useSettings();
  const params = useMemo(
    () => guardrailParams(settings.guardrails),
    [settings.guardrails],
  );
  const analysis = useSessionAnalysis({
    api,
    sessionID,
    params,
    refresh: forceRefresh,
  });
  const diagnostics = useSessionDiagnostics({ api, sessionID });

  useEffect(() => {
    onForceConsumed?.();
  }, [onForceConsumed]);

  useEffect(() => {
    onDataLoading?.(analysis.status === "loading");
    return () => onDataLoading?.(false);
  }, [analysis.status, onDataLoading]);

  const [statsTab, setStatsTab] = useState<StatsTab>("table");
  const [healthOpen, setHealthOpen] = useState(false);
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedSteps, setExpandedSteps] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleTurn = useCallback((turnID: string) => {
    setExpandedTurns((previous) => {
      const next = new Set(previous);
      if (next.has(turnID)) next.delete(turnID);
      else next.add(turnID);
      return next;
    });
  }, []);

  const toggleStep = useCallback((turnID: string, stepID: string) => {
    const key = `${turnID}:${stepID}`;
    setExpandedSteps((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setExpandedTurns((previous) => {
      if (previous.has(turnID)) return previous;
      const next = new Set(previous);
      next.add(turnID);
      return next;
    });
  }, []);

  const allExpanded =
    analysis.analysis !== null &&
    analysis.analysis.turns.length > 0 &&
    analysis.analysis.turns.every((turn) => expandedTurns.has(turn.id));

  const toggleAll = useCallback(() => {
    const turns = analysis.analysis?.turns ?? [];
    if (turns.length > 0 && turns.every((turn) => expandedTurns.has(turn.id))) {
      setExpandedTurns(new Set());
      setExpandedSteps(new Set());
      return;
    }
    setExpandedTurns(new Set(turns.map((turn) => turn.id)));
  }, [analysis.analysis, expandedTurns]);

  const onCopy = useCallback(
    (action: CopyActionModel) => {
      // Wired in Phase 6: `useExport` fetches the server-rendered text, copies it
      // and shows the redaction-honest toast.
      onCopyAction(action);
    },
    [onCopyAction],
  );

  const toolbar = {
    statsTab,
    onStatsTab: setStatsTab,
    contextBasis: settings.contextBasis,
    onContextBasis: settings.setContextBasis,
    showEventRows: settings.showEventRows,
    onShowEventRows: settings.setShowEventRows,
    responseLimit: settings.responseLimit,
    onResponseLimit: settings.setResponseLimit,
    allExpanded,
    onToggleAll: toggleAll,
    health: analysis.analysis?.health,
    healthOpen,
    onToggleHealth: () => setHealthOpen((open) => !open),
    onCopy,
    notice: null,
  };

  if (!sessionID) {
    return (
      <div className="grid gap-1">
        <h2 className="m-0 text-[13px] font-semibold text-text">No session selected</h2>
        <p className="m-0 text-[12.5px] text-text-2">Choose a session from the sidebar.</p>
      </div>
    );
  }

  if (analysis.status === "loading") {
    return <p className="m-0 text-[12.5px] text-text-2">Loading statistics…</p>;
  }

  if (analysis.status === "error" || !analysis.analysis) {
    return (
      <p role="status" className="m-0 text-[12.5px] text-text-2">
        Statistics unavailable — {analysis.error ?? "the analysis response was empty"}.
        Unrecorded figures are never shown as zero.
      </p>
    );
  }

  const loaded = analysis.analysis;
  const unattached =
    viewMode === "advanced" && settings.showEventRows ? unattachedEvents(loaded) : [];

  return (
    <div className="grid gap-2.5">
      <GuardrailsSection
        guardrails={analysis.guardrails}
        turns={loaded.turns}
        onDrill={onDrill}
      />

      {viewMode === "advanced" ? (
        <StatisticsAdvanced
          analysis={loaded}
          health={loaded.health}
          healthOpen={healthOpen}
          statsTab={statsTab}
          contextBasis={settings.contextBasis}
          showEventRows={settings.showEventRows}
          expandedTurns={expandedTurns}
          expandedSteps={expandedSteps}
          responseLimit={settings.responseLimit}
          onToggleTurn={toggleTurn}
          onToggleStep={toggleStep}
          onToggleAll={toggleAll}
          onDrill={onDrill}
          onOpenSession={onOpenSession}
          toolbar={toolbar}
        />
      ) : (
        <StatisticsBasic
          analysis={loaded}
          expandedTurns={expandedTurns}
          expandedSteps={expandedSteps}
          responseLimit={settings.responseLimit}
          onToggleTurn={toggleTurn}
          onToggleStep={toggleStep}
          onToggleAll={toggleAll}
          onDrill={onDrill}
          onOpenSession={onOpenSession}
          toolbar={toolbar}
        />
      )}

      <DiagnosticsSection
        incidents={diagnostics.incidents}
        status={diagnostics.status}
        error={diagnostics.error}
        onDrill={onDrill}
      />

      <CompactionCards compactions={loaded.compactions} onDrill={onDrill} />

      {unattached.length > 0 ? (
        <section aria-label="Unattached events" className="mt-2.5">
          <h2 className="m-0 mb-1.5 text-[13px] font-semibold text-text">
            Unattached events
          </h2>
          <div className="overflow-auto rounded-lg border border-border bg-surface">
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr>
                  <th className="border-b border-border bg-surface-2 px-2 py-1.5 text-left text-[11px] text-text-2">
                    Time
                  </th>
                  <th className="border-b border-border bg-surface-2 px-2 py-1.5 text-left text-[11px] text-text-2">
                    Kind
                  </th>
                  <th className="border-b border-border bg-surface-2 px-2 py-1.5 text-left text-[11px] text-text-2">
                    Event
                  </th>
                </tr>
              </thead>
              <tbody>
                {unattached.map((event) => (
                  <tr
                    key={event.id}
                    className="cursor-pointer hover:bg-surface-2"
                    onClick={() => onDrill(event.id)}
                  >
                    <td className="border-b border-border px-2 py-1 font-mono text-[11px] text-muted">
                      {formatTime(event.timestamp)}
                    </td>
                    <td className="border-b border-border px-2 py-1 text-text-2">{event.kind}</td>
                    <td className="border-b border-border px-2 py-1 text-text-2">
                      {event.title}{" "}
                      <span className="text-muted">(no turn attribution)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
