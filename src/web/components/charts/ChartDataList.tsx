import type { ChartDataRow, ChartDrillKind } from "../../lib/chart-data.ts";
import { CHART_DATA_SUMMARY } from "../../lib/chart-config.ts";

export interface ChartDataListProps {
  rows: readonly ChartDataRow[];
  onDrill(eventID: string): void;
}

interface DrillAttrs {
  "data-event-id"?: string;
  "data-jump-step"?: string;
  onClick?: () => void;
}

/** The legacy anchor attribute: a step anchor is `data-jump-step`. */
function drillAttrs(
  anchor: string | null,
  kind: ChartDrillKind,
  onDrill: (eventID: string) => void,
): DrillAttrs {
  if (!anchor) return {};
  const attrs: DrillAttrs =
    kind === "step" ? { "data-jump-step": anchor } : { "data-event-id": anchor };
  attrs.onClick = () => onDrill(anchor);
  return attrs;
}

/**
 * The keyboard path to the chart: a native collapsing `<details>` whose rows
 * are real buttons. Each button drills with the same anchor and the same
 * `onDrill` wiring the other Statistics sections use, so an SVG datum is never
 * the only way to reach a turn, step or compaction.
 */
export function ChartDataList({ rows, onDrill }: ChartDataListProps) {
  if (rows.length === 0) return null;
  return (
    <details className="chart-data">
      <summary>{CHART_DATA_SUMMARY}</summary>
      <ul>
        {rows.map((row) => {
          const label = row.anchor
            ? `${row.label}, ${row.value}`
            : `${row.label}, ${row.value}, no event to open`;
          return (
            <li key={row.key}>
              <button
                type="button"
                className="chart-data-row"
                aria-label={label}
                {...drillAttrs(row.anchor, row.kind, onDrill)}
              >
                <span className="chart-data-label">{row.label}</span>
                <span className="chart-data-value">{row.value}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
