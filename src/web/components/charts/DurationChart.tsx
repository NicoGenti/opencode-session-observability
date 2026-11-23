import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  type BarShapeProps,
  type XAxisTickContentProps,
  type YAxisTickContentProps,
} from "recharts";
import {
  durationDataRows,
  durationMax,
  durationNotes,
  durationTotal,
  sentenceCase,
  type ChartDataRow,
  type ChartDrillKind,
  type DurationPoint,
  type DurationSeries,
} from "../../lib/chart-data.ts";
import { basisMark } from "../../lib/diagnostics.ts";
import {
  CHART_BASELINE,
  CHART_HEIGHT,
  CHART_LEGEND,
  CHART_PAD,
  CHART_WIDTH,
  DURATION_SEGMENTS,
  NOT_RECORDED_LABEL,
  axisTicks,
  barSize,
  chartA11y,
  chartDomainMax,
  formatAxisValue,
  swatchClass,
  tickEvery,
  toneClass,
} from "../../lib/chart-config.ts";
import { formatDuration } from "../../lib/format.ts";
import { ChartDataList } from "./ChartDataList.tsx";

export interface DurationChartProps {
  series: DurationSeries;
  onDrill(eventID: string): void;
}

interface DurationDatum extends DurationPoint {
  tick: string;
  slot: number;
}

interface UnrecordedSlotProps {
  left: number;
  width: number;
  label: string;
  anchor: string | null;
  kind: ChartDrillKind;
  onDrill(eventID: string): void;
}

/** The dashed "Not recorded" slot, identical to the other chart cues. */
function UnrecordedSlot({ left, width, label, anchor, kind, onDrill }: UnrecordedSlotProps) {
  const slotWidth = Math.max(width, 12);
  const slotLeft = left + width / 2 - slotWidth / 2;
  const centreX = slotLeft + slotWidth / 2;
  const centreY = (CHART_PAD.top + CHART_BASELINE) / 2;
  const drill = anchor
    ? {
        ...(kind === "step" ? { "data-jump-step": anchor } : { "data-event-id": anchor }),
        onClick: () => onDrill(anchor),
      }
    : {};
  return (
    <g className="chart-unavailable" aria-label={label} {...drill}>
      <rect
        className="chart-unavailable-slot"
        x={slotLeft}
        y={CHART_PAD.top}
        width={slotWidth}
        height={CHART_BASELINE - CHART_PAD.top}
        rx={3}
      />
      <text
        className="chart-unavailable-label"
        x={centreX}
        y={centreY}
        textAnchor="middle"
        transform={`rotate(-90 ${centreX} ${centreY})`}
      >
        {NOT_RECORDED_LABEL}
      </text>
    </g>
  );
}

/**
 * Per-step model/tool/residual stacks. A segment the analysis did not record
 * is omitted, so a partial step draws a shorter stack; a recorded zero keeps a
 * visible tick; a step with none of the three draws the dashed slot. The axis
 * is the legacy duration formatter, so every tick keeps its unit.
 */
export function DurationChart({ series, onDrill }: DurationChartProps) {
  const data: readonly DurationDatum[] = series.points.map((point) => ({
    ...point,
    tick: point.label,
    slot: point.available ? Math.max(durationTotal(point), 1) : 1,
  }));
  const max = durationMax(series);
  const every = tickEvery(data.length);
  const ticks = axisTicks(max);
  const rows: ChartDataRow[] = durationDataRows(series);
  const notes = durationNotes(series);

  if (series.empty) {
    return <p className="chart-empty">{sentenceCase(series.reason)}</p>;
  }

  const renderBar = (props: BarShapeProps): ReactNode => {
    const datum = data[props.index] ?? data[props.originalDataIndex];
    if (!datum) return null;
    const anchor = datum.anchor;
    const drill = anchor
      ? { "data-jump-step": anchor, onClick: () => onDrill(anchor) }
      : {};
    const width = Math.max(4, props.width);
    const present = DURATION_SEGMENTS.filter((segment) => datum[segment.key]);

    if (present.length === 0) {
      return (
        <UnrecordedSlot
          left={props.x}
          width={width}
          label={`Step ${datum.label}, durations not recorded (—)`}
          anchor={anchor}
          kind="step"
          onDrill={onDrill}
        />
      );
    }

    const total = durationTotal(datum);
    const scale = total > 0 && props.height > 0 ? props.height / total : 0;
    let cursor = CHART_BASELINE;
    const rects: ReactNode[] = [];
    for (const segment of present) {
      const metric = datum[segment.key];
      if (!metric) continue;
      const value = metric.value ?? 0;
      if (!(value > 0)) {
        rects.push(
          <rect
            key={segment.key}
            className={`${toneClass(segment.tone)}${anchor ? " chart-datum-link" : ""}`}
            x={props.x}
            y={cursor - 2}
            width={width}
            height={2}
            aria-label={`Step ${datum.label}, ${segment.label.toLowerCase()} 0 ms (${basisMark(
              metric.basis,
            )})${anchor ? "" : ", no event to open"}`}
            {...drill}
          />,
        );
        continue;
      }
      const height = Math.max(2, value * scale);
      const y = cursor - height;
      rects.push(
        <rect
          key={segment.key}
          className={`${toneClass(segment.tone)}${anchor ? " chart-datum-link" : ""}`}
          x={props.x}
          y={y}
          width={width}
          height={height}
          aria-label={`Step ${datum.label}, ${segment.label.toLowerCase()} ${formatDuration(
            value,
          )} (${basisMark(metric.basis)})${anchor ? "" : ", no event to open"}`}
          {...drill}
        />,
      );
      cursor = y;
    }
    return <g>{rects}</g>;
  };

  const renderTick = (props: XAxisTickContentProps): ReactNode => {
    if (props.index % every !== 0) return null;
    return (
      <text x={props.x} y={props.y} textAnchor="middle" className="chart-axis-label">
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
      {formatAxisValue("duration", Number(props.payload.value))}
    </text>
  );

  return (
    <>
      <div className="chart-scroll">
        <BarChart
          {...chartA11y("duration")}
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          data={data}
          className="chart-canvas"
          margin={{ top: CHART_PAD.top, right: CHART_PAD.right, bottom: 0, left: 0 }}
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
          <Bar
            dataKey="slot"
            barSize={barSize(data.length)}
            shape={renderBar}
            isAnimationActive={false}
          />
        </BarChart>
      </div>
      <div className="chart-legend">
        {DURATION_SEGMENTS.map((segment) => (
          <span key={segment.key} className="chart-legend-item">
            <span className={swatchClass(segment.tone)} />
            {segment.label}
          </span>
        ))}
        {series.unavailableCount > 0 ? (
          <span className="chart-legend-item">
            <span className="chart-swatch chart-swatch-unavailable" />
            {CHART_LEGEND.notRecorded}
          </span>
        ) : null}
      </div>
      {notes.length > 0 ? (
        <p className="chart-note">{notes.map(sentenceCase).join(" ")}</p>
      ) : null}
      <ChartDataList rows={rows} onDrill={onDrill} />
    </>
  );
}
