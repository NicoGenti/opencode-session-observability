import type { Analysis } from "../../core/types.ts";
import type { SessionHealth } from "../../core/health.ts";
import {
  ADVANCED_COLUMNS,
  buildAdvancedRows,
  buildRecordedLegend,
  buildStatTiles,
  buildTotalsRow,
  type StatsTab,
} from "../lib/statistics.ts";
import { StatTile } from "./StatTile.tsx";
import { StatsTable } from "./StatsTable.tsx";
import { BasisLegend, StatsToolbar, type StatsToolbarProps } from "./StatsToolbar.tsx";
import { HealthBreakdown } from "./HealthSection.tsx";
import { AttributionSection } from "./AttributionSection.tsx";
import { RecommendationsSection } from "./RecommendationsSection.tsx";
import { ChartsPane } from "./charts/ChartsPane.tsx";

export interface StatisticsAdvancedProps {
  analysis: Analysis;
  health: SessionHealth | null | undefined;
  healthOpen: boolean;
  statsTab: StatsTab;
  contextBasis: string;
  showEventRows: boolean;
  expandedTurns: ReadonlySet<string>;
  expandedSteps: ReadonlySet<string>;
  responseLimit: number;
  onToggleTurn(turnID: string): void;
  onToggleStep(turnID: string, stepID: string): void;
  onToggleAll(): void;
  onDrill(eventID: string): void;
  onOpenSession(sessionID: string): void;
  toolbar: Omit<StatsToolbarProps, "mode" | "analysis">;
}

/**
 * Advanced Statistics (`renderStatistics`, `app.js:2293-2447`): the 19-column
 * table (or the honest Charts placeholder), the health breakdown, attribution,
 * recommendations, the basis legend and the recorded-by-OpenCode comparison.
 * Diagnostics, compactions and unattached events stay in `StatisticsView`
 * because both modes share them.
 */
export function StatisticsAdvanced({
  analysis,
  health,
  healthOpen,
  statsTab,
  contextBasis,
  showEventRows,
  expandedTurns,
  expandedSteps,
  responseLimit,
  onToggleTurn,
  onToggleStep,
  onToggleAll,
  onDrill,
  onOpenSession,
  toolbar,
}: StatisticsAdvancedProps) {
  const rows = buildAdvancedRows(analysis, {
    expandedTurns,
    expandedSteps,
    contextBasis,
    showEventRows,
  });
  const recorded = buildRecordedLegend(analysis);
  return (
    <div className="grid gap-2.5">
      <StatsToolbar mode="advanced" analysis={analysis} {...toolbar} />
      {healthOpen ? (
        <HealthBreakdown health={health} turns={analysis.turns} onDrill={onDrill} />
      ) : null}
      <div className="grid grid-cols-4 gap-1.5 max-[700px]:grid-cols-2">
        {buildStatTiles(analysis, "advanced").map((tile) => (
          <StatTile key={tile.id} tile={tile} />
        ))}
      </div>

      {statsTab === "charts" ? (
        <ChartsPane analysis={analysis} contextBasis={contextBasis} onDrill={onDrill} />
      ) : (
        <StatsTable
          columns={ADVANCED_COLUMNS}
          rows={rows}
          totals={buildTotalsRow(analysis, "advanced")}
          responseLimit={responseLimit}
          onToggleTurn={onToggleTurn}
          onToggleStep={onToggleStep}
          onDrill={onDrill}
          onOpenSession={onOpenSession}
        />
      )}

      <AttributionSection
        attribution={analysis.attribution}
        onDrill={onDrill}
        onOpenSession={onOpenSession}
      />
      <RecommendationsSection recommendations={analysis.recommendations} onDrill={onDrill} />
      <BasisLegend />
      {recorded ? (
        <div className="flex flex-wrap items-baseline gap-2 text-[11.5px] text-text-2">
          <span>{recorded.text}</span>
          <span className="text-muted">{recorded.note}</span>
        </div>
      ) : null}
    </div>
  );
}
