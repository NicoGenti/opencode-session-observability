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
  costDataRows,
  costNotes,
  sentenceCase,
  type ChartDataRow,
  type ChartDrillKind,
  type CostPoint,
  type CostSeries,
} from "../../lib/chart-data.ts";
import { basisMark } from "../../lib/diagnostics.ts";
import {
  CHART_BASELINE,
  CHART_HEIGHT,
  CHART_LEGEND,
  CHART_PAD,
  CHART_WIDTH,
  NOT_RECORDED_LABEL,
  axisTicks,
  barSize,
  chartA11y,
  chartDomainMax,
  formatAxisValue,
  modelTone,
  swatchClass,
  tickEvery,
  toneClass,
} from "../../lib/chart-config.ts";
import { formatCost } from "../../lib/format.ts";
import { ChartDataList } from "./ChartDataList.tsx";

export interface CostChartProps {
  series: CostSeries;
  onDrill(eventID: string): void;
}

interface CostDatum extends CostPoint {
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

/** The dashed "Not recorded" slot, identical to the token chart's cue. */
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
 * Cost per turn grouped by the model derived from the turn's steps. Ties at
 * the highest cost each get the text mark, so the ranking never depends on
 * colour; the axis is the legacy USD formatter, and an unrecorded cost is a
 * dashed slot. The model fill follows the legacy categorical order, one accent
 * first and a quiet neutral for an unknown model.
 */
export function CostChart({ series, onDrill }: CostChartProps) {
  const models = series.models;
  const max = series.max.value;
  const maxima = new Set(series.max.turnIndices);
  const data: readonly CostDatum[] = series.points.map((point) => {
    const value = point.cost.value;
    return {
      ...point,
      tick: String(point.turnIndex),
      slot: point.cost.available && value !== null && value > 0 ? value : 1,
    };
  });
  const every = tickEvery(data.length);
  const ticks = axisTicks(max);
  const rows: ChartDataRow[] = costDataRows(series);
  const notes = costNotes(series);

  if (series.empty) {
    return <p className="chart-empty">{sentenceCase(series.reason)}</p>;
  }

  const toneFor = (modelKey: string): ReturnType<typeof modelTone> => {
    if (modelKey === "—") return "muted";
    const index = models.findIndex((model) => model.key === modelKey);
    return modelTone(index >= 0 ? index : 0);
  };

  const renderBar = (props: BarShapeProps): ReactNode => {
    const datum = data[props.index] ?? data[props.originalDataIndex];
    if (!datum) return null;
    const anchor = datum.anchor;
    const drill = anchor
      ? { "data-event-id": anchor, onClick: () => onDrill(anchor) }
      : {};
    const width = Math.max(4, props.width);

    if (!datum.cost.available) {
      return (
        <UnrecordedSlot
          left={props.x}
          width={width}
          label={`Turn ${datum.turnIndex}, cost not recorded (—), ${datum.modelLabel}`}
          anchor={anchor}
          kind="event"
          onDrill={onDrill}
        />
      );
    }

    const isHighest = maxima.has(datum.turnIndex);
    const value = datum.cost.value ?? 0;
    // A recorded zero stays a 2 px tick, never a full-height bar.
    const height = value > 0 ? Math.max(2, props.height) : 2;
    const y = CHART_BASELINE - height;
    const centre = Math.min(
      Math.max(props.x + width / 2, CHART_PAD.left + 24),
      CHART_WIDTH - CHART_PAD.right - 24,
    );
    const provider = datum.providerLabel ? `, provider ${datum.providerLabel}` : "";
    return (
      <g>
        <rect
          className={`${toneClass(toneFor(datum.modelKey))}${anchor ? " chart-datum-link" : ""}`}
          x={props.x}
          y={y}
          width={width}
          height={height}
          aria-label={`Turn ${datum.turnIndex}, cost ${formatCost(datum.cost.value)} (${basisMark(
            datum.cost.basis,
          )}), ${datum.modelLabel}${provider}${isHighest ? ", highest cost" : ""}`}
          {...drill}
        />
        {isHighest ? (
          <text
            className="chart-highest"
            x={centre}
            y={Math.max(CHART_PAD.top + 10, y - 6)}
            textAnchor="middle"
          >
            Highest cost
          </text>
        ) : null}
      </g>
    );
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
      {formatAxisValue("cost", Number(props.payload.value))}
    </text>
  );

  return (
    <>
      <div className="chart-scroll">
        <BarChart
          {...chartA11y("cost")}
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
        {models.map((model) => (
          <span key={model.key} className="chart-legend-item">
            <span className={swatchClass(toneFor(model.key))} />
            {model.label}
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
