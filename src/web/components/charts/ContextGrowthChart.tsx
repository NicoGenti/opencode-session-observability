import type { ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
  type DotItemDotProps,
  type XAxisTickContentProps,
  type YAxisTickContentProps,
} from "recharts";
import type { Analysis } from "../../../core/types.ts";
import {
  buildContextGrowthSeries,
  contextDataRows,
  contextMax,
  contextNotes,
  sentenceCase,
  type ChartDataRow,
  type ContextGrowthSeries,
  type ContextPoint,
} from "../../lib/chart-data.ts";
import {
  CHART_BASELINE,
  CHART_HEIGHT,
  CHART_LEGEND,
  CHART_PAD,
  CHART_WIDTH,
  chartA11y,
  formatAxisValue,
  swatchClass,
  tickEvery,
  toneClass,
  axisTicks,
  chartDomainMax,
} from "../../lib/chart-config.ts";
import { formatNumber } from "../../lib/format.ts";
import { ChartDataList } from "./ChartDataList.tsx";

export interface ContextGrowthChartProps {
  series: ContextGrowthSeries;
  onDrill(eventID: string): void;
}

interface ContextDatum extends ContextPoint {
  tick: string;
}

/**
 * Context growth: one point per turn on a gapped polyline, a dashed tick for
 * an unavailable turn, and a dashed vertical marker per placed compaction.
 *
 * The line never bridges a null point (`connectNulls={false}`), and every
 * datum anchor is the event the builder recorded — there is no hover tooltip,
 * only the click-to-drill the legacy chart offered and the `Chart data` list.
 */
export function ContextGrowthChart({ series, onDrill }: ContextGrowthChartProps) {
  const points = series.points;
  const data: readonly ContextDatum[] = points.map((point) => ({
    ...point,
    tick: String(point.turnIndex),
  }));
  const max = contextMax(series);
  const every = tickEvery(data.length);
  const ticks = axisTicks(max);
  const rows: ChartDataRow[] = contextDataRows(series);
  const notes = contextNotes(series);

  if (series.empty) {
    return <p className="chart-empty">{sentenceCase(series.reason)}</p>;
  }

  const renderTick = (props: XAxisTickContentProps): ReactNode => {
    if (props.index % every !== 0) return null;
    return (
      <text
        x={props.x}
        y={props.y}
        textAnchor="middle"
        className="chart-axis-label"
      >
        {String(props.payload.value ?? "")}
      </text>
    );
  };

  const renderValueTick = (props: YAxisTickContentProps): ReactNode => (
    <text
      x={props.x}
      y={props.y}
      textAnchor="end"
      dominantBaseline="central"
      className="chart-axis-label"
    >
      {formatAxisValue("compact", Number(props.payload.value))}
    </text>
  );

  const renderDot = (props: DotItemDotProps): ReactNode => {
    const point = points[props.index];
    if (!point) return null;
    const anchor = point.anchor;
    const drill = anchor
      ? {
          "data-event-id": anchor,
          onClick: () => onDrill(anchor),
        }
      : {};
    if (!point.available) {
      if (typeof props.cx !== "number") return null;
      return (
        <g
          className="chart-unavailable"
          aria-label={`Turn ${point.turnIndex}, context not recorded (—)`}
          {...drill}
        >
          <rect
            className="chart-unavailable-slot"
            x={props.cx - 5}
            y={CHART_BASELINE - 12}
            width={10}
            height={10}
            rx={2}
          />
        </g>
      );
    }
    return (
      <circle
        className={`${toneClass("accent")}${anchor ? " chart-datum-link" : ""}`}
        cx={props.cx}
        cy={props.cy}
        r={4}
        aria-label={`Turn ${point.turnIndex}, context ${formatNumber(point.value)} (M)`}
        {...drill}
      />
    );
  };

  return (
    <>
      <div className="chart-scroll">
        <LineChart
          {...chartA11y("context", series.basis)}
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          data={data}
          className="chart-canvas"
          margin={{
            top: CHART_PAD.top,
            right: CHART_PAD.right,
            bottom: 0,
            left: 0,
          }}
          accessibilityLayer={false}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="tick"
            type="category"
            interval={0}
            height={CHART_PAD.bottom}
            tick={renderTick}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            width={CHART_PAD.left}
            interval={0}
            domain={[0, chartDomainMax(max)]}
            ticks={[...ticks]}
            tick={renderValueTick}
            axisLine={false}
            tickLine={false}
          />
          <Line
            type="linear"
            dataKey="value"
            className="chart-series-accent"
            strokeWidth={2}
            dot={renderDot}
            connectNulls={false}
            isAnimationActive={false}
          />
          {series.markers.map((marker) => (
            <ReferenceLine
              key={marker.eventID}
              x={String(marker.turnIndex)}
              className="chart-marker"
              label={{
                value: marker.label,
                position: "top",
                className: "chart-marker-label",
              }}
              onClick={() => onDrill(marker.eventID)}
            />
          ))}
        </LineChart>
      </div>
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className={swatchClass("accent")} />
          {`Context (${series.basis})`}
        </span>
        <span className="chart-legend-item">
          <span className="chart-swatch chart-swatch-unavailable" />
          {CHART_LEGEND.unavailableGap}
        </span>
        <span className="chart-legend-item">
          <span className="chart-swatch chart-swatch-marker" />
          {CHART_LEGEND.marker}
        </span>
      </div>
      {notes.length > 0 ? (
        <p className="chart-note">{notes.map(sentenceCase).join(" ")}</p>
      ) : null}
      <ChartDataList rows={rows} onDrill={onDrill} />
    </>
  );
}
