import type { Basis, Metric, Turn, TurnStatus } from "../../../core/types.ts";
import {
  basisMark,
  formatCompact,
  formatCost,
  formatDuration,
  formatPercent,
} from "../../../core/format.ts";
import { statusSymbol } from "./status.ts";

/**
 * Pure column model for the native statistics table.
 *
 * This module owns the breakpoints, the ordered column sets and the cell
 * formatting. It has no JSX, no SDK import and no terminal state: the view only
 * pads/joins the strings returned here.
 */

export type ColumnId =
  | "turn"
  | "steps"
  | "tokIn"
  | "tokOut"
  | "reasoning"
  | "cacheRead"
  | "cacheWrite"
  | "cacheHit"
  | "modelMs"
  | "toolMs"
  | "residual"
  | "cost"
  | "status"
  | "tokens";

export type LayoutMode = "full" | "mid" | "compact";

/**
 * Width thresholds from the plan card. `wideMid`, `mid` and `narrowMid` all
 * report mode `"mid"`; their column sets degrade progressively.
 */
export const BREAKPOINTS = {
  full: 120,
  wideMid: 100,
  mid: 90,
  narrowMid: 81,
  compact: 80,
} as const;

export interface StatisticsLayout {
  /** Coerced integer width; never negative. */
  readonly width: number;
  readonly mode: LayoutMode;
  readonly columns: readonly ColumnId[];
}

const FULL_COLUMNS: readonly ColumnId[] = [
  "turn",
  "steps",
  "tokIn",
  "tokOut",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "cacheHit",
  "modelMs",
  "toolMs",
  "residual",
  "cost",
  "status",
];

const WIDE_MID_COLUMNS: readonly ColumnId[] = FULL_COLUMNS.filter(
  (id) => id !== "reasoning",
);

const MID_COLUMNS: readonly ColumnId[] = WIDE_MID_COLUMNS.filter(
  (id) => id !== "cacheWrite",
);

const NARROW_MID_COLUMNS: readonly ColumnId[] = [
  "turn",
  "steps",
  "tokIn",
  "tokOut",
  "cost",
  "status",
];

const COMPACT_COLUMNS: readonly ColumnId[] = [
  "turn",
  "tokens",
  "cost",
  "status",
];

export const COLUMN_LABELS: Readonly<Record<ColumnId, string>> = {
  turn: "#",
  steps: "Steps",
  tokIn: "In",
  tokOut: "Out",
  reasoning: "Reason",
  cacheRead: "CacheR",
  cacheWrite: "CacheW",
  cacheHit: "Hit",
  modelMs: "Model",
  toolMs: "Tool",
  residual: "Resid",
  cost: "Cost",
  status: "Status",
  tokens: "Tokens",
};

/**
 * Fixed cell widths keep the table monospace-aligned without relying on layout
 * alignment inside a single text node. Status is the only left-aligned column.
 */
export const COLUMN_WIDTHS: Readonly<Record<ColumnId, number>> = {
  turn: 4,
  steps: 5,
  tokIn: 8,
  tokOut: 8,
  reasoning: 7,
  cacheRead: 8,
  cacheWrite: 8,
  cacheHit: 8,
  modelMs: 9,
  toolMs: 9,
  residual: 9,
  cost: 10,
  status: 6,
  tokens: 17,
};

export function resolveLayout(width: number): StatisticsLayout {
  const safe = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
  if (safe >= BREAKPOINTS.full) {
    return { width: safe, mode: "full", columns: FULL_COLUMNS };
  }
  if (safe >= BREAKPOINTS.wideMid) {
    return { width: safe, mode: "mid", columns: WIDE_MID_COLUMNS };
  }
  if (safe >= BREAKPOINTS.mid) {
    return { width: safe, mode: "mid", columns: MID_COLUMNS };
  }
  if (safe >= BREAKPOINTS.narrowMid) {
    return { width: safe, mode: "mid", columns: NARROW_MID_COLUMNS };
  }
  return { width: safe, mode: "compact", columns: COMPACT_COLUMNS };
}

/** Alias used by callers that only need a pure width decision. */
export const layout: (width: number) => StatisticsLayout = resolveLayout;

export function columnLabel(id: ColumnId): string {
  return COLUMN_LABELS[id];
}

export function columnWidth(id: ColumnId): number {
  return COLUMN_WIDTHS[id];
}

const UNAVAILABLE: Metric = { value: null, basis: "unavailable" };

function metricOf(metric: Metric | undefined): Metric {
  return metric ?? UNAVAILABLE;
}

function numberText(value: number | null | undefined): string {
  return formatCompact(value);
}

function marked(
  metric: Metric | undefined,
  formatter: (value: number | null) => string,
): string {
  const current = metricOf(metric);
  if (current.value === null || !Number.isFinite(current.value)) return "—";
  const basis: Basis = current.basis ?? "unavailable";
  return `${formatter(current.value)} ${basisMark(basis)}`;
}

function markedCompact(metric: Metric | undefined): string {
  return marked(metric, (value) => formatCompact(value));
}

/**
 * The compact `tokens` cell keeps the latest and cumulative prompt sizes
 * adjacent, latest first, as documented for the narrow layout.
 */
export function contextPair(turn: Turn): string {
  return `${markedCompact(turn.promptTokensLatest)}/${markedCompact(
    turn.promptTokensCumulative,
  )}`;
}

export function turnTriggerLabel(turn: Turn): string {
  const label = turn.trigger?.label;
  return typeof label === "string" && label.length > 0 ? label : "—";
}

/** Primitive cell text for every column id, keyed by the column id. */
export function turnCellValues(turn: Turn): Record<ColumnId, string> {
  const tokens = turn.tokens;
  const status: TurnStatus = turn.status ?? "unknown";
  return {
    turn: String(turn.index),
    steps: String(turn.steps?.length ?? 0),
    tokIn: numberText(tokens?.input),
    tokOut: numberText(tokens?.output),
    reasoning: numberText(tokens?.reasoning),
    cacheRead: numberText(tokens?.cacheRead),
    cacheWrite: numberText(tokens?.cacheWrite),
    cacheHit: marked(turn.cacheHitRate, (value) => formatPercent(value)),
    modelMs: marked(turn.modelTime, (value) => formatDuration(value)),
    toolMs: marked(turn.toolTime, (value) => formatDuration(value)),
    residual: marked(turn.residualTime, (value) => formatDuration(value)),
    cost: marked(turn.cost, (value) => formatCost(value)),
    status: statusSymbol(status),
    tokens: contextPair(turn),
  };
}

function padCell(id: ColumnId, value: string): string {
  // Clip before padding, like the step accordion: an over-wide cell (e.g. a
  // cost at $1,000,000 is 11 characters in a width-10 column) must not push
  // the grid off by one. Shorter values keep their unchanged padding.
  const width = columnWidth(id);
  const clipped =
    value.length > width
      ? `${value.slice(0, Math.max(0, width - 1))}…`
      : value;
  if (id === "status") return clipped.padEnd(width);
  return clipped.padStart(width);
}

/** Header line for the resolved column set, aligned with `formatRow`. */
export function formatHeader(columns: readonly ColumnId[]): string {
  return `  ${columns.map((id) => padCell(id, columnLabel(id))).join(" ")}`;
}

export interface FormattedRow {
  /** Row text up to (excluding) the status column, including the selection marker. */
  readonly prefix: string;
  /** Status cell prefixed with its separating space, so it can be colored alone. */
  readonly status: string;
}

/**
 * Formats one turn row. Status is split out because the view colors it by
 * palette key while keeping the terminal-safe symbol in the same cell.
 *
 * When `expanded` is provided the two-character selection marker becomes the
 * selection glyph plus the accordion marker (`+` collapsed, `-` expanded, or a
 * blank for turns without steps). Omitting it keeps the phase-2 output.
 */
export function formatRow(
  turn: Turn,
  columns: readonly ColumnId[],
  selected: boolean,
  expanded?: boolean,
): FormattedRow {
  const values = turnCellValues(turn);
  const selection = selected ? ">" : " ";
  const marker =
    expanded === undefined
      ? `${selection} `
      : `${selection}${
          (turn.steps?.length ?? 0) === 0 ? " " : expanded ? "-" : "+"
        }`;
  const cells: string[] = [];
  let status = "";
  for (const id of columns) {
    const cell = padCell(id, values[id]);
    if (id === "status") {
      status = ` ${cell}`;
      continue;
    }
    cells.push(cell);
  }
  return { prefix: `${marker}${cells.join(" ")}`, status };
}
