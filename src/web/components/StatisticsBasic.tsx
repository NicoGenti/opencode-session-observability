import type { Analysis } from "../../core/types.ts";
import {
  BASIC_COLUMNS,
  buildBasicRows,
  buildStatTiles,
  buildTotalsRow,
} from "../lib/statistics.ts";
import { StatTile } from "./StatTile.tsx";
import { StatsTable } from "./StatsTable.tsx";
import { BasisLegend, StatsToolbar, type StatsToolbarProps } from "./StatsToolbar.tsx";

export interface StatisticsBasicProps {
  analysis: Analysis;
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
 * Basic Statistics (`renderStatisticsBasic`, `app.js:2147-2192`): the seven
 * turn columns, the four headline tiles and the basis legend. No health,
 * attribution, recommendations, copy actions or sub-tabs — those stay behind
 * the Advanced gate.
 */
export function StatisticsBasic({
  analysis,
  expandedTurns,
  expandedSteps,
  responseLimit,
  onToggleTurn,
  onToggleStep,
  onToggleAll,
  onDrill,
  onOpenSession,
  toolbar,
}: StatisticsBasicProps) {
  const rows = buildBasicRows(analysis, expandedTurns, expandedSteps);
  return (
    <div className="grid gap-2.5">
      <StatsToolbar mode="basic" analysis={analysis} {...toolbar} />
      <div className="grid grid-cols-4 gap-1.5 max-[700px]:grid-cols-2">
        {buildStatTiles(analysis, "basic").map((tile) => (
          <StatTile key={tile.id} tile={tile} />
        ))}
      </div>
      <StatsTable
        columns={BASIC_COLUMNS}
        rows={rows}
        totals={buildTotalsRow(analysis, "basic")}
        responseLimit={responseLimit}
        onToggleTurn={onToggleTurn}
        onToggleStep={onToggleStep}
        onDrill={onDrill}
        onOpenSession={onOpenSession}
      />
      <BasisLegend />
    </div>
  );
}
