/**
 * Chart geometry, section copy and the token-name -> CSS-class table for the
 * Statistics Charts sub-tab, ported from the legacy contracts in
 * `src/ui/charts.js:32-60` and `:286-330`.
 *
 * This module is the only place a chart colour is named. It never holds a
 * colour value: a tone resolves to a `--token` name and to a class defined in
 * `src/web/styles/index.css`, and the class is what paints the SVG. That is
 * deliberate — `var()` is invalid in an SVG presentation attribute, so the
 * legacy renderer injected `style="fill: var(--token)"` and the React port
 * applies a class whose rule declares the same custom property.
 *
 * The tone order keeps the legacy semantics: accent leads (context line,
 * input tokens, model time), `good`/`serious`/`warning`/`critical` keep their
 * status meaning on series fills, and `--warning` never paints text. Model
 * grouping keeps the legacy `MODEL_COLORS` order so a single-model session is
 * the one accent series and the rest stay quiet neutrals.
 */

import { formatCompact, formatCost, formatDuration } from "./format.ts";

/* ------------------------------------------------------------------ canvas */

/** Fixed canvas, `src/ui/charts.js:32-33`. Never a responsive container. */
export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 220;

/** Recharts margins reproduce the legacy `PAD` (`charts.js:35`). */
export const CHART_PAD = Object.freeze({
  left: 56,
  right: 16,
  top: 16,
  bottom: 30,
});

export const CHART_GRID_ROWS = 4;
export const CHART_MAX_LABELS = 24;
export const CHART_BASELINE = CHART_HEIGHT - CHART_PAD.bottom;
export const CHART_PLOT_WIDTH = CHART_WIDTH - CHART_PAD.left - CHART_PAD.right;

/* ------------------------------------------------------------------- tones */

export const CHART_TONES = [
  "accent",
  "good",
  "warning",
  "serious",
  "critical",
  "muted",
] as const;

export type ChartTone = (typeof CHART_TONES)[number];

/**
 * The tone -> custom-property table. The class for a tone is the only paint
 * hook; `index.css` declares `.chart-series-<tone> { fill: var(--<token>) }`.
 */
export const CHART_TONE_TOKEN: Readonly<Record<ChartTone, string>> = Object.freeze({
  accent: "--accent",
  good: "--good",
  warning: "--warning",
  serious: "--serious",
  critical: "--critical",
  muted: "--muted",
});

export const CHART_TONE_CLASS: Readonly<Record<ChartTone, string>> = Object.freeze({
  accent: "chart-series-accent",
  good: "chart-series-good",
  warning: "chart-series-warning",
  serious: "chart-series-serious",
  critical: "chart-series-critical",
  muted: "chart-series-muted",
});

export function toneClass(tone: ChartTone): string {
  return `${CHART_TONE_CLASS[tone]} chart-datum`;
}

/** Swatch classes reuse the same tone vocabulary for the text legend. */
export function swatchClass(tone: ChartTone): string {
  return `chart-swatch chart-swatch-${tone}`;
}

/**
 * Categorical fills for the per-model cost grouping, in the legacy
 * `MODEL_COLORS` order (`charts.js:53-60`): accent first, one neutral last.
 */
export const COST_MODEL_TONES: readonly ChartTone[] = Object.freeze([
  "accent",
  "good",
  "serious",
  "warning",
  "critical",
  "muted",
]);

export function modelTone(index: number): ChartTone {
  const length = COST_MODEL_TONES.length;
  return COST_MODEL_TONES[((index % length) + length) % length] ?? "muted";
}

/* ---------------------------------------------------------------- segments */

export const TOKEN_SEGMENT_KEYS = [
  "input",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "output",
] as const;

export type TokenSegmentKey = (typeof TOKEN_SEGMENT_KEYS)[number];

export interface ChartSegment<K extends string> {
  key: K;
  label: string;
  tone: ChartTone;
}

/** Five token segments, `charts.js:38-44`; warning is a fill only. */
export const TOKEN_SEGMENTS: readonly ChartSegment<TokenSegmentKey>[] = Object.freeze([
  Object.freeze({ key: "input", label: "Input", tone: "accent" }),
  Object.freeze({ key: "cacheRead", label: "Cache read", tone: "good" }),
  Object.freeze({ key: "cacheWrite", label: "Cache write", tone: "warning" }),
  Object.freeze({ key: "reasoning", label: "Reasoning", tone: "serious" }),
  Object.freeze({ key: "output", label: "Output", tone: "muted" }),
]);

export const DURATION_SEGMENT_KEYS = ["modelTime", "toolTime", "residualTime"] as const;

export type DurationSegmentKey = (typeof DURATION_SEGMENT_KEYS)[number];

/** One leading accent series, then quiet neutrals, `charts.js:46-50`. */
export const DURATION_SEGMENTS: readonly ChartSegment<DurationSegmentKey>[] = Object.freeze([
  Object.freeze({ key: "modelTime", label: "Model time", tone: "accent" }),
  Object.freeze({ key: "toolTime", label: "Tool time", tone: "good" }),
  Object.freeze({ key: "residualTime", label: "Residual time", tone: "muted" }),
]);

/* ---------------------------------------------------------------- section */

export const CHART_SECTION_IDS = ["context", "tokens", "cost", "duration"] as const;

export type ChartSectionID = (typeof CHART_SECTION_IDS)[number];

export const COST_AXIS_UNIT = "USD";

export interface ChartSectionConfig {
  id: ChartSectionID;
  title: string;
  /** Static legend/aria vocabulary; the context label follows the basis. */
  ariaLabel: string;
}

/** The documented order, `docs/UI.md:136-139`. */
export const CHART_SECTIONS: readonly ChartSectionConfig[] = Object.freeze([
  Object.freeze({
    id: "context",
    title: "Context growth",
    ariaLabel: "Context growth per turn, latest basis",
  }),
  Object.freeze({
    id: "tokens",
    title: "Token usage",
    ariaLabel: "Token usage per turn, five segments",
  }),
  Object.freeze({
    id: "cost",
    title: "Cost",
    ariaLabel: `Cost per turn by model, ${COST_AXIS_UNIT}`,
  }),
  Object.freeze({
    id: "duration",
    title: "Step duration",
    ariaLabel: "Step duration breakdown",
  }),
]);

export const CHART_DATA_SUMMARY = "Chart data";
export const NOT_RECORDED_LABEL = "Not recorded";

export const CHART_LEGEND = Object.freeze({
  unavailableGap: "Unavailable gap",
  marker: "Compaction marker",
  partialTurn: "Partial turn",
  notRecorded: NOT_RECORDED_LABEL,
});

export const CHART_EMPTY_FALLBACK = "No chart data.";

/** One chart-level label per chart, `docs/UI.md:141`. */
export function chartAriaLabel(id: ChartSectionID, basis: "latest" | "cumulative" = "latest"): string {
  if (id === "context") return `Context growth per turn, ${basis} basis`;
  const section = CHART_SECTIONS.find((entry) => entry.id === id);
  return section?.ariaLabel ?? CHART_EMPTY_FALLBACK;
}

/** Attributes spread onto the Recharts surface: `role="img"` + one label. */
export function chartA11y(
  id: ChartSectionID,
  basis: "latest" | "cumulative" = "latest",
): { role: "img"; "aria-label": string } {
  return { role: "img", "aria-label": chartAriaLabel(id, basis) };
}

/* ------------------------------------------------------------------ scales */

export type ChartAxisFormat = "compact" | "cost" | "duration";

/** Axis ticks reuse `format.ts`; duration keeps its unit on every tick. */
export function formatAxisValue(kind: ChartAxisFormat, value: number): string {
  if (kind === "cost") return formatCost(value);
  if (kind === "duration") return formatDuration(value);
  return formatCompact(value);
}

/** Five ticks including the baseline, or the baseline alone for no data. */
export function axisTicks(max: number | null | undefined): readonly number[] {
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return Object.freeze([0]);
  const ticks: number[] = [];
  for (let row = 0; row <= CHART_GRID_ROWS; row += 1) {
    ticks.push((max * row) / CHART_GRID_ROWS);
  }
  return Object.freeze(ticks);
}

/** A null max still needs a positive domain so the axis can render. */
export function chartDomainMax(max: number | null | undefined): number {
  return typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 1;
}

/** Legacy `labelEvery` (`charts.js:114-116`). */
export function tickEvery(count: number, maxLabels = CHART_MAX_LABELS): number {
  return Math.max(1, Math.ceil(count / maxLabels));
}

/** Legacy `barWidth` (`charts.js:100-102`): 55% of the slot, 4-34 px. */
export function barSize(count: number): number {
  const step = count > 0 ? CHART_PLOT_WIDTH / count : CHART_PLOT_WIDTH;
  return Math.max(4, Math.min(34, step * 0.55));
}
