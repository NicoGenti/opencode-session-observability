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
  sentenceCase,
  tokenDataRows,
  tokenMax,
  tokenNotes,
  tokenTotal,
  tokenUnrecordedCount,
  type ChartDataRow,
  type ChartDrillKind,
  type TokenPoint,
  type TokenSeries,
} from "../../lib/chart-data.ts";
import { basisMark } from "../../lib/diagnostics.ts";
import {
  CHART_BASELINE,
  CHART_HEIGHT,
  CHART_LEGEND,
  CHART_PAD,
  CHART_WIDTH,
  NOT_RECORDED_LABEL,
  TOKEN_SEGMENTS,
  axisTicks,
  barSize,
  chartA11y,
  chartDomainMax,
  formatAxisValue,
  swatchClass,
  tickEvery,
  toneClass,
} from "../../lib/chart-config.ts";
import { formatNumber } from "../../lib/format.ts";
import { ChartDataList } from "./ChartDataList.tsx";

export interface TokenChartProps {
  series: TokenSeries;
  onDrill(eventID: string): void;
}

interface TokenDatum extends TokenPoint {
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

/**
 * The dashed "Not recorded" slot shared by the token, cost and duration
 * charts: a full-height `--border-strong` outline with the literal label, not
 * a zero-length bar dressed as data.
 */
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
 * Five stacked token segments per turn with token-only fills. A turn that
 * recorded only part of its usage keeps the recorded subset and gets the
 * dashed partial outline; a turn with no recorded usage at all gets the
 * dashed slot instead of a zero bar.
 */
export function TokenChart({ series, onDrill }: TokenChartProps) {
  const data: readonly TokenDatum[] = series.points.map((point) => ({
    ...point,
    tick: String(point.turnIndex),
    slot: tokenTotal(point) > 0 ? tokenTotal(point) : 1,
  }));
  const max = tokenMax(series);
  const every = tickEvery(data.length);
  const ticks = axisTicks(max);
  const rows: ChartDataRow[] = tokenDataRows(series);
  const notes = tokenNotes(series);
  const unrecorded = tokenUnrecordedCount(series);

  if (series.empty) {
    return <p className="chart-empty">{sentenceCase(series.reason)}</p>;
  }

  const renderBar = (props: BarShapeProps): ReactNode => {
    const datum = data[props.index] ?? data[props.originalDataIndex];
    if (!datum) return null;
    const anchor = datum.anchor;
    const drill = anchor
      ? { "data-event-id": anchor, onClick: () => onDrill(anchor) }
      : {};
    const basis = basisMark(datum.basis);
    const partialNote = datum.partial ? ", partial: recorded subset only" : "";
    const total = tokenTotal(datum);
    const width = Math.max(4, props.width);

    if (total === 0 && datum.basis === "unavailable") {
      return (
        <UnrecordedSlot
          left={props.x}
          width={width}
          label={`Turn ${datum.turnIndex}, tokens not recorded (—)`}
          anchor={anchor}
          kind="event"
          onDrill={onDrill}
        />
      );
    }
    if (total === 0) {
      return (
        <rect
          className="chart-series-muted chart-datum"
          x={props.x}
          y={CHART_BASELINE - 2}
          width={width}
          height={2}
          aria-label={`Turn ${datum.turnIndex}, 0 tokens (${basis})`}
          {...drill}
        />
      );
    }

    const scale = props.height > 0 ? props.height / total : 0;
    let cursor = CHART_BASELINE;
    const rects: ReactNode[] = [];
    for (const segment of TOKEN_SEGMENTS) {
      const value = datum[segment.key] ?? 0;
      if (!(value > 0)) continue;
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
          aria-label={`Turn ${datum.turnIndex}, ${segment.label.toLowerCase()} ${formatNumber(
            value,
          )} tokens (${basis})${partialNote}${anchor ? "" : ", no event to open"}`}
          {...drill}
        />,
      );
      cursor = y;
    }
    if (datum.partial) {
      rects.push(
        <rect
          key="partial"
          className="chart-partial"
          x={props.x - 1}
          y={cursor - 1}
          width={width + 2}
          height={CHART_BASELINE - cursor + 2}
          rx={2}
        />,
      );
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
      {formatAxisValue("compact", Number(props.payload.value))}
    </text>
  );

  return (
    <>
      <div className="chart-scroll">
        <BarChart
          {...chartA11y("tokens")}
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
        {TOKEN_SEGMENTS.map((segment) => (
          <span key={segment.key} className="chart-legend-item">
            <span className={swatchClass(segment.tone)} />
            {segment.label}
          </span>
        ))}
        {series.partialCount > 0 ? (
          <span className="chart-legend-item">
            <span className="chart-swatch chart-swatch-partial" />
            {CHART_LEGEND.partialTurn}
          </span>
        ) : null}
        {unrecorded > 0 ? (
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
