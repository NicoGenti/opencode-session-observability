/**
 * The Chart series and drill-row models, a pure port of
 * `src/ui/charts-data.js` (`:84`, `:149`, `:202`, `:263`, `:304`) plus the
 * row/note builders from `src/ui/charts.js` (`:277-330`, `:415-444`, `:553-591`,
 * `:677-698`, `:800-818`).
 *
 * Every builder projects an already-loaded `Analysis`; nothing is fetched,
 * paged, or invented. A missing metric keeps `value: null` with
 * `available: false` and a `"unavailable"` basis, so a gap is never a zero.
 * Drill anchors are only the event IDs the analysis actually records, and the
 * "Chart data" rows are the same values the graphic shows.
 *
 * The legacy module produced HTML strings. The React port keeps this layer to
 * plain data: components own the markup, so a recorded string can never become
 * markup and there is no escaping step to forget.
 */

import type {
  Analysis,
  Basis,
  CompactionTransaction,
  Coverage,
  Metric,
  Step,
  Turn,
} from "../../core/types.ts";
import { formatCost, formatDuration, formatNumber } from "./format.ts";
import { basisMark } from "./diagnostics.ts";
import {
  DURATION_SEGMENTS,
  TOKEN_SEGMENTS,
  type DurationSegmentKey,
  type TokenSegmentKey,
} from "./chart-config.ts";

const EMPTY_TURNS_REASON = "no turns in this analysis";
const EMPTY_STEPS_REASON = "no steps recorded in this analysis";

/* ------------------------------------------------------------------ metrics */

export interface ChartMetricPoint {
  value: number | null;
  basis: Basis;
  available: boolean;
}

/** A finite number, or null for anything else (never zero-filled). */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function metricPoint(metric: Metric | null | undefined): ChartMetricPoint {
  const value = finiteOrNull(metric?.value);
  return {
    value,
    basis: value === null ? "unavailable" : (metric?.basis ?? "unavailable"),
    available: value !== null,
  };
}

/** Turn drill anchor: the trigger event, then any turn event, else null. */
export function turnAnchor(
  turn: Pick<Turn, "trigger" | "eventIDs"> | null | undefined,
): string | null {
  return turn?.trigger?.eventID ?? turn?.eventIDs?.[0] ?? null;
}

/** Step drill anchor: the step's first event, else null. */
export function stepAnchor(step: Pick<Step, "eventIDs"> | null | undefined): string | null {
  return step?.eventIDs?.[0] ?? null;
}

/* ---------------------------------------------------------- context growth */

const CONTEXT_BASES = ["latest", "cumulative"] as const;

export type ContextBasis = (typeof CONTEXT_BASES)[number];

export function normalizeContextBasis(basis: unknown): ContextBasis {
  return basis === "cumulative" ? "cumulative" : "latest";
}

export interface ContextPoint extends ChartMetricPoint {
  turnIndex: number;
  anchor: string | null;
}

export interface CompactionMarker {
  eventID: string;
  turnIndex: number;
  removedTokens: ChartMetricPoint;
  label: string;
}

export interface ContextGrowthSeries {
  basis: ContextBasis;
  empty: boolean;
  reason?: string;
  points: ContextPoint[];
  markers: CompactionMarker[];
  unplaced: number;
  unavailableCount: number;
}

/**
 * Index of the turn a compaction belongs to, or null when it cannot be placed.
 *
 * A recorded `turnID` is authoritative: an id that does not resolve is
 * unplaceable, never re-derived from timestamps. Only a compaction without a
 * turn id falls back to the last turn starting at or before its timestamp.
 */
function compactionTurnIndex(
  turns: readonly Turn[],
  compaction: CompactionTransaction,
): number | null {
  if (compaction.turnID !== null && compaction.turnID !== undefined) {
    const match = turns.find((turn) => turn.id === compaction.turnID);
    return match ? match.index : null;
  }
  const timestamp = finiteOrNull(compaction.timestamp);
  if (timestamp === null) return null;
  let placed: number | null = null;
  for (const turn of turns) {
    const startTime = finiteOrNull(turn.startTime);
    if (startTime !== null && startTime <= timestamp) placed = turn.index;
  }
  return placed;
}

/** Context growth per turn, with placed compaction markers. */
export function buildContextGrowthSeries(
  analysis: Analysis,
  basis?: string | null,
): ContextGrowthSeries {
  const resolvedBasis = normalizeContextBasis(basis);
  const turns = analysis.turns ?? [];
  const markers: CompactionMarker[] = [];
  let unplaced = 0;
  let unavailableCount = 0;

  const points = turns.map((turn) => {
    const metric =
      resolvedBasis === "cumulative" ? turn.promptTokensCumulative : turn.promptTokensLatest;
    const point = metricPoint(metric);
    if (!point.available) unavailableCount += 1;
    return {
      turnIndex: turn.index,
      anchor: turnAnchor(turn),
      ...point,
    };
  });

  for (const [index, compaction] of (analysis.compactions ?? []).entries()) {
    const turnIndex = compactionTurnIndex(turns, compaction);
    if (turnIndex === null) {
      unplaced += 1;
      continue;
    }
    markers.push({
      eventID: compaction.eventID,
      turnIndex,
      removedTokens: metricPoint(compaction.removedTokens),
      label: `Compaction ${index + 1}`,
    });
  }

  if (turns.length === 0) {
    return {
      basis: resolvedBasis,
      empty: true,
      reason: EMPTY_TURNS_REASON,
      points,
      markers,
      unplaced,
      unavailableCount,
    };
  }
  return { basis: resolvedBasis, empty: false, points, markers, unplaced, unavailableCount };
}

/** Legacy chart max: the highest available point, never a zero dip. */
export function contextMax(series: ContextGrowthSeries): number {
  return series.points.reduce(
    (best, point) => (point.available && point.value !== null && point.value > best ? point.value : best),
    0,
  );
}

/* ------------------------------------------------------------------ tokens */

export type TokenStack = Record<TokenSegmentKey, number>;

export interface TokenPoint extends TokenStack {
  turnIndex: number;
  anchor: string | null;
  partial: boolean;
  basis: "measured" | "unavailable";
}

export interface TokenSeries {
  empty: boolean;
  reason?: string;
  points: TokenPoint[];
  partialCount: number;
}

export function buildTokenSeries(analysis: Analysis): TokenSeries {
  const turns = analysis.turns ?? [];
  let partialCount = 0;

  const points = turns.map((turn) => {
    const tokens = turn.tokens;
    const recorded = (turn.steps ?? []).some(
      (step) => step.tokens !== null && step.tokens !== undefined,
    );
    const partial = turn.tokensComplete === false && recorded;
    if (partial) partialCount += 1;
    return {
      turnIndex: turn.index,
      anchor: turnAnchor(turn),
      input: finiteOrNull(tokens?.input) ?? 0,
      cacheRead: finiteOrNull(tokens?.cacheRead) ?? 0,
      cacheWrite: finiteOrNull(tokens?.cacheWrite) ?? 0,
      reasoning: finiteOrNull(tokens?.reasoning) ?? 0,
      output: finiteOrNull(tokens?.output) ?? 0,
      partial,
      basis: turn.tokensComplete === true && recorded ? "measured" : "unavailable",
    } satisfies TokenPoint;
  });

  if (turns.length === 0) {
    return { empty: true, reason: EMPTY_TURNS_REASON, points, partialCount };
  }
  return { empty: false, points, partialCount };
}

export function tokenTotal(point: TokenStack): number {
  return TOKEN_SEGMENTS.reduce((sum, segment) => sum + (point[segment.key] ?? 0), 0);
}

export function tokenMax(series: TokenSeries): number {
  return series.points.reduce((best, point) => Math.max(best, tokenTotal(point)), 0);
}

/** Turns that recorded no step usage at all: the dashed "Not recorded" slots. */
export function tokenUnrecordedCount(series: TokenSeries): number {
  return series.points.filter(
    (point) => point.basis === "unavailable" && tokenTotal(point) === 0,
  ).length;
}

/* -------------------------------------------------------------------- cost */

export interface CostPoint {
  turnIndex: number;
  anchor: string | null;
  cost: ChartMetricPoint;
  modelKey: string;
  modelLabel: string;
  providerLabel: string | null;
}

export interface CostModel {
  key: string;
  label: string;
}

export interface CostSeries {
  empty: boolean;
  reason?: string;
  points: CostPoint[];
  models: CostModel[];
  max: { value: number | null; turnIndices: number[] };
  unavailableCount: number;
}

/** The last step that recorded a model: the step attribution comes from. */
function lastModelStep(turn: Turn): Step | null {
  for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
    const step = turn.steps[index];
    if (step && step.model) return step;
  }
  return null;
}

function modelLabelFor(step: Step | null): string {
  if (!step?.model) return "—";
  const { providerID, id, variant } = step.model;
  return `${providerID}/${id}${variant ? `#${variant}` : ""}`;
}

export function buildCostSeries(analysis: Analysis): CostSeries {
  const turns = analysis.turns ?? [];
  const models: CostModel[] = [];
  const seenModels = new Set<string>();
  let unavailableCount = 0;

  const points = turns.map((turn) => {
    const modelStep = lastModelStep(turn);
    const label = modelLabelFor(modelStep);
    const cost = metricPoint(turn.cost);
    if (!cost.available) unavailableCount += 1;
    if (!seenModels.has(label)) {
      seenModels.add(label);
      models.push({ key: label, label });
    }
    return {
      turnIndex: turn.index,
      anchor: turnAnchor(turn),
      cost,
      modelKey: label,
      modelLabel: label,
      providerLabel: modelStep?.provider ?? null,
    };
  });

  let maxValue: number | null = null;
  for (const point of points) {
    if (!point.cost.available || point.cost.value === null) continue;
    if (maxValue === null || point.cost.value > maxValue) maxValue = point.cost.value;
  }
  const max = {
    value: maxValue,
    turnIndices:
      !(typeof maxValue === "number" && maxValue > 0)
        ? []
        : points
            .filter(
              (point) =>
                point.cost.available &&
                point.cost.value !== null &&
                point.cost.value === maxValue,
            )
            .map((point) => point.turnIndex),
  };

  if (turns.length === 0) {
    return {
      empty: true,
      reason: EMPTY_TURNS_REASON,
      points,
      models,
      max,
      unavailableCount,
    };
  }
  return { empty: false, points, models, max, unavailableCount };
}

/* ---------------------------------------------------------------- duration */

export type DurationStack = Partial<Record<DurationSegmentKey, ChartMetricPoint>>;

export interface DurationPoint extends DurationStack {
  label: string;
  turnIndex: number;
  stepIndex: number;
  anchor: string | null;
  available: boolean;
}

export interface DurationSeries {
  empty: boolean;
  reason?: string;
  points: DurationPoint[];
  unavailableCount: number;
}

export function buildDurationSeries(analysis: Analysis): DurationSeries {
  const turns = analysis.turns ?? [];
  const points: DurationPoint[] = [];
  let unavailableCount = 0;

  for (const turn of turns) {
    for (const step of turn.steps ?? []) {
      const point: DurationPoint = {
        label: `${turn.index}.${step.index}`,
        turnIndex: turn.index,
        stepIndex: step.index,
        anchor: stepAnchor(step),
        available: false,
      };
      for (const segment of DURATION_SEGMENTS) {
        const metric = metricPoint(step[segment.key]);
        if (!metric.available) continue;
        point[segment.key] = metric;
        point.available = true;
      }
      if (!point.available) unavailableCount += 1;
      points.push(point);
    }
  }

  if (points.length === 0) {
    return {
      empty: true,
      reason: turns.length === 0 ? EMPTY_TURNS_REASON : EMPTY_STEPS_REASON,
      points,
      unavailableCount,
    };
  }
  return { empty: false, points, unavailableCount };
}

/** Sum of the recorded duration segments (`charts.js:712-715`). */
export function durationTotal(point: DurationStack): number {
  return DURATION_SEGMENTS.reduce(
    (sum, segment) => sum + (point[segment.key]?.value ?? 0),
    0,
  );
}

export function durationMax(series: DurationSeries): number {
  return series.points.reduce((best, point) => Math.max(best, durationTotal(point)), 0);
}

/* ----------------------------------------------------------------- caption */

export interface ChartScopeAnalysis {
  totals?: { scope?: string } | null;
  coverage?: Partial<Coverage> | null;
}

/** `"Session total — seq 1–42"`, or the partial-window form. */
export function chartWindowCaption(analysis: ChartScopeAnalysis): string {
  const scope = analysis.totals?.scope === "window" ? "Window total" : "Session total";
  const coverage = analysis.coverage;
  if (!coverage) return scope;
  const fromSeq = finiteOrNull(coverage.fromSeq);
  const toSeq = finiteOrNull(coverage.toSeq);
  if (fromSeq === null || toSeq === null) return scope;
  const range = fromSeq === toSeq ? `seq ${fromSeq}` : `seq ${fromSeq}–${toSeq}`;
  const minSeq = finiteOrNull(coverage.minSeq);
  const maxSeq = finiteOrNull(coverage.maxSeq);
  if (coverage.complete === false && minSeq !== null && maxSeq !== null) {
    return `${scope} — ${range} of ${minSeq}–${maxSeq}`;
  }
  return `${scope} — ${range}`;
}

/* ------------------------------------------------------- drill list rows */

export type ChartDrillKind = "event" | "step";

export interface ChartDataRow {
  key: string;
  label: string;
  value: string;
  anchor: string | null;
  kind: ChartDrillKind;
}

/**
 * Every row the legacy list rendered: one per point, plus one per placed
 * compaction marker. The legacy chart lists have no cap (only the health and
 * attribution evidence lists cap at `MAX_EVENT_LINKS`), so neither does this.
 */
export function contextDataRows(series: ContextGrowthSeries): ChartDataRow[] {
  const rows: ChartDataRow[] = series.points.map((point) => ({
    key: `turn-${point.turnIndex}`,
    label: `Turn ${point.turnIndex}`,
    value: point.available
      ? `context ${formatNumber(point.value)} (${basisMark(point.basis)})`
      : "context not recorded (—)",
    anchor: point.anchor,
    kind: "event",
  }));
  for (const marker of series.markers) {
    rows.push({
      key: `compaction-${marker.eventID}`,
      label: marker.label,
      value: marker.removedTokens.available
        ? `turn ${marker.turnIndex}, removed ${formatNumber(
            marker.removedTokens.value,
          )} tokens (${basisMark(marker.removedTokens.basis)})`
        : `turn ${marker.turnIndex}, removed tokens not recorded (—)`,
      anchor: marker.eventID,
      kind: "event",
    });
  }
  return rows;
}

export function tokenDataRows(series: TokenSeries): ChartDataRow[] {
  return series.points.map((point) => ({
    key: `turn-${point.turnIndex}`,
    label: `Turn ${point.turnIndex}`,
    value:
      tokenTotal(point) === 0 && point.basis === "unavailable"
        ? "tokens not recorded (—)"
        : `${TOKEN_SEGMENTS.map(
            (segment) => `${segment.label.toLowerCase()} ${formatNumber(point[segment.key] ?? 0)}`,
          ).join(", ")} tokens (${basisMark(point.basis)})${
            point.partial ? ", partial: recorded subset only" : ""
          }`,
    anchor: point.anchor,
    kind: "event",
  }));
}

export function costDataRows(series: CostSeries): ChartDataRow[] {
  const maxima = new Set(series.max.turnIndices);
  return series.points.map((point) => ({
    key: `turn-${point.turnIndex}`,
    label: `Turn ${point.turnIndex}`,
    value: point.cost.available
      ? `${formatCost(point.cost.value)} (${basisMark(point.cost.basis)}), ${
          point.modelLabel
        }${point.providerLabel ? `, provider ${point.providerLabel}` : ""}${
          maxima.has(point.turnIndex) ? ", highest cost" : ""
        }`
      : `cost not recorded (—), ${point.modelLabel}`,
    anchor: point.anchor,
    kind: "event",
  }));
}

export function durationDataRows(series: DurationSeries): ChartDataRow[] {
  return series.points.map((point) => {
    const present = DURATION_SEGMENTS.filter((segment) => point[segment.key]);
    return {
      key: `step-${point.label}`,
      label: `Step ${point.label}`,
      value:
        present.length === 0
          ? "durations not recorded (—)"
          : present
              .map((segment) => {
                const metric = point[segment.key];
                return `${segment.label.toLowerCase()} ${formatDuration(
                  metric?.value,
                )} (${basisMark(metric?.basis ?? "unavailable")})`;
              })
              .join(", "),
      anchor: point.anchor,
      kind: "step",
    };
  });
}

/* ---------------------------------------------------------------- notes */

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Sentence-case "nothing to draw" copy, never an empty chart frame. */
export function sentenceCase(text: string | null | undefined): string {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "No chart data.";
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export function contextNotes(series: ContextGrowthSeries): string[] {
  const notes: string[] = [];
  if (series.unavailableCount > 0) {
    notes.push(
      `${plural(series.unavailableCount, "turn")} ${
        series.unavailableCount === 1 ? "has" : "have"
      } no context recorded`,
    );
  }
  if (series.unplaced > 0) {
    notes.push(`${plural(series.unplaced, "compaction")} could not be placed on a turn`);
  }
  return notes;
}

export function tokenNotes(series: TokenSeries): string[] {
  const notes: string[] = [];
  const unrecorded = tokenUnrecordedCount(series);
  if (series.partialCount > 0) {
    notes.push(`${plural(series.partialCount, "turn")} recorded only part of its tokens`);
  }
  if (unrecorded > 0) {
    notes.push(`${plural(unrecorded, "turn")} recorded no step tokens`);
  }
  return notes;
}

export function costNotes(series: CostSeries): string[] {
  return series.unavailableCount > 0
    ? [`${plural(series.unavailableCount, "turn")} recorded no cost`]
    : [];
}

export function durationNotes(series: DurationSeries): string[] {
  return series.unavailableCount > 0
    ? [`${plural(series.unavailableCount, "step")} recorded no durations`]
    : [];
}
