import type { ReactNode } from "react";
import type { Analysis } from "../../../core/types.ts";
import {
  buildContextGrowthSeries,
  buildCostSeries,
  buildDurationSeries,
  buildTokenSeries,
  chartWindowCaption,
} from "../../lib/chart-data.ts";
import { CHART_SECTIONS, type ChartSectionID } from "../../lib/chart-config.ts";
import { ContextGrowthChart } from "./ContextGrowthChart.tsx";
import { CostChart } from "./CostChart.tsx";
import { DurationChart } from "./DurationChart.tsx";
import { TokenChart } from "./TokenChart.tsx";

export interface ChartsPaneProps {
  /** The same loaded analysis the Table sub-tab renders; no fetch of its own. */
  analysis: Analysis;
  contextBasis: string;
  onDrill(eventID: string): void;
}

interface ChartSectionProps {
  id: ChartSectionID;
  title: string;
  caption: string;
  children: ReactNode;
}

/** The legacy `.chart-section` wrapper (`charts.js:286-299`). */
function ChartSection({ id, title, caption, children }: ChartSectionProps) {
  const headingID = `chart-${id}-title`;
  return (
    <section className="chart-section" id={`chart-${id}`} aria-labelledby={headingID}>
      <div className="chart-section-head">
        <h3 className="chart-title" id={headingID}>
          {title}
        </h3>
        <span className="chart-caption">{caption}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * The Charts sub-tab: four sections in the documented order, all projected
 * from the `analysis` prop the Statistics view already loaded. There is no
 * effect, no request and no hook here — switching Table/Charts re-renders this
 * pure tree, so the analysis identity is the only data path.
 */
export function ChartsPane({ analysis, contextBasis, onDrill }: ChartsPaneProps) {
  const caption = chartWindowCaption(analysis);
  const context = buildContextGrowthSeries(analysis, contextBasis);
  const tokens = buildTokenSeries(analysis);
  const cost = buildCostSeries(analysis);
  const duration = buildDurationSeries(analysis);

  return (
    <div className="charts-pane">
      {CHART_SECTIONS.map((section) => (
        <ChartSection
          key={section.id}
          id={section.id}
          title={section.title}
          caption={caption}
        >
          {section.id === "context" ? (
            <ContextGrowthChart series={context} onDrill={onDrill} />
          ) : section.id === "tokens" ? (
            <TokenChart series={tokens} onDrill={onDrill} />
          ) : section.id === "cost" ? (
            <CostChart series={cost} onDrill={onDrill} />
          ) : (
            <DurationChart series={duration} onDrill={onDrill} />
          )}
        </ChartSection>
      ))}
    </div>
  );
}
