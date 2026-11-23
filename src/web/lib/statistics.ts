/**
 * The Statistics table and tile models, a pure port of the legacy renderers
 * (`renderStatisticsBasic` `app.js:2147`, `renderStatistics` `:2293`, the row
 * builders `:1837-2037` and the stat tiles `renderHeader` `:1145-1237`).
 *
 * The split mirrors the legacy contract rather than the DOM: Basic has seven
 * turn columns and no advanced surface; Advanced carries the 19-column set with
 * the identity columns frozen, the basis-selectable context column and the
 * step detail rows. Cell text, provenance marks and drill anchors are computed
 * here so the components only choose token treatments.
 *
 * Numbers are never invented: an unrecorded metric stays `—` with its
 * `unavailable` provenance, and the tiles carry a superscribed mark on every
 * figure (`M`, `D`, `E`, `—`).
 */

import type {
  Analysis,
  EventIndexEntry,
  Metric,
  Step,
  TokenUsage,
  Turn,
} from "../../core/types.ts";
import {
  formatCompact,
  formatCost,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTime,
} from "./format.ts";
import { metricText, type MetricText } from "./diagnostics.ts";
import { renderMarkdown } from "./markdown.ts";

/* ------------------------------------------------------------------ columns */

export type FrozenSide = "left" | "right" | null;

export interface StatsColumn {
  id: string;
  label: string;
  numeric: boolean;
  frozen: FrozenSide;
}

/** The seven Basic turn columns, in legacy order (`app.js:2179-2181`). */
export const BASIC_COLUMNS: readonly StatsColumn[] = Object.freeze([
  Object.freeze({ id: "index", label: "#", numeric: false, frozen: null }),
  Object.freeze({ id: "trigger", label: "Trigger", numeric: false, frozen: null }),
  Object.freeze({ id: "duration", label: "Duration", numeric: true, frozen: null }),
  Object.freeze({ id: "input", label: "In", numeric: true, frozen: null }),
  Object.freeze({ id: "output", label: "Out", numeric: true, frozen: null }),
  Object.freeze({ id: "cost", label: "Cost", numeric: true, frozen: null }),
  Object.freeze({ id: "status", label: "Status", numeric: false, frozen: null }),
]);

/** The 19 Advanced columns, in legacy order (`app.js:2392-2398`). */
export const ADVANCED_COLUMNS: readonly StatsColumn[] = Object.freeze([
  Object.freeze({ id: "index", label: "#", numeric: false, frozen: "left" }),
  Object.freeze({ id: "trigger", label: "Trigger", numeric: false, frozen: "left" }),
  Object.freeze({ id: "start", label: "Start", numeric: false, frozen: null }),
  Object.freeze({ id: "duration", label: "Duration", numeric: true, frozen: null }),
  Object.freeze({ id: "model", label: "Model", numeric: false, frozen: null }),
  Object.freeze({ id: "steps", label: "Steps", numeric: true, frozen: null }),
  Object.freeze({ id: "input", label: "In", numeric: true, frozen: null }),
  Object.freeze({ id: "output", label: "Out", numeric: true, frozen: null }),
  Object.freeze({ id: "reasoning", label: "Reason", numeric: true, frozen: null }),
  Object.freeze({ id: "cache", label: "Cache R/W", numeric: true, frozen: null }),
  Object.freeze({ id: "hit", label: "Hit", numeric: true, frozen: null }),
  Object.freeze({ id: "context", label: "Context", numeric: true, frozen: null }),
  Object.freeze({ id: "delta", label: "Δ context", numeric: true, frozen: null }),
  Object.freeze({ id: "model-time", label: "Model time", numeric: true, frozen: null }),
  Object.freeze({ id: "tool-time", label: "Tool time", numeric: true, frozen: null }),
  Object.freeze({ id: "residual", label: "Residual", numeric: true, frozen: null }),
  Object.freeze({ id: "speed", label: "Out/s", numeric: true, frozen: null }),
  Object.freeze({ id: "cost", label: "Cost", numeric: true, frozen: null }),
  Object.freeze({ id: "status", label: "Status", numeric: false, frozen: "right" }),
]);

export function statsColumns(mode: "basic" | "advanced"): readonly StatsColumn[] {
  return mode === "advanced" ? ADVANCED_COLUMNS : BASIC_COLUMNS;
}

/** The identity columns that stay visible while the Advanced table scrolls. */
export const FROZEN_COLUMN_IDS: readonly string[] = Object.freeze([
  "index",
  "trigger",
  "status",
]);

/* --------------------------------------------------------------- row cells */

export type StatusTone = "completed" | "error" | "interrupted" | "running" | "unknown";

export interface StatusModel {
  label: string;
  tone: StatusTone;
  uncertainty?: { label: string; title: string };
}

export interface ToggleModel {
  expanded: boolean;
  label: string;
}

export interface DrillModel {
  eventID: string;
  label: string;
  ariaLabel: string;
}

export interface StatsCell {
  key: string;
  text: string;
  /** Secondary line under the value (legacy `.sub-label`). */
  sub?: string;
  title?: string;
  numeric?: boolean;
  mono?: boolean;
  muted?: boolean;
  /** Non-measured provenance superscript, as `metricHtml` prints it. */
  mark?: string;
  span?: number;
  toggle?: ToggleModel;
  status?: StatusModel;
  drill?: DrillModel;
}

export type StatsRowKind = "turn" | "step" | "detail" | "event";

export interface StatsRow {
  key: string;
  kind: StatsRowKind;
  turnID: string;
  stepID?: string;
  expanded?: boolean;
  cells: StatsCell[];
  turn?: Turn;
  step?: Step;
  event?: EventIndexEntry;
}

export function statusTone(status: string | null | undefined): StatusTone {
  if (status === "completed" || status === "succeeded") return "completed";
  if (status === "error" || status === "failed") return "error";
  if (status === "interrupted") return "interrupted";
  if (status === "running") return "running";
  return "unknown";
}

function metricCell(
  key: string,
  metric: Metric | null | undefined,
  formatter: (value: number) => string,
): StatsCell {
  const text = metricText(metric ?? undefined, formatter);
  return {
    key,
    text: text.text,
    title: text.title,
    numeric: true,
    mark: text.basis === "measured" ? undefined : text.mark,
  };
}

function countCell(key: string, value: number | null | undefined): StatsCell {
  return { key, text: formatNumber(value), numeric: true };
}

function statusCell(turn: Turn | Step): StatsCell {
  return {
    key: "status",
    text: turn.status,
    status: {
      label: turn.status,
      tone: statusTone(turn.status),
      uncertainty:
        turn.uncertainty.length > 0
          ? { label: "!", title: turn.uncertainty.join(", ") }
          : undefined,
    },
  };
}

function indexCell(
  key: string,
  text: string,
  expanded: boolean,
  turnIndex: number,
): StatsCell {
  return {
    key,
    text,
    mono: true,
    toggle: {
      expanded,
      label: `${expanded ? "Collapse" : "Expand"} turn ${turnIndex}`,
    },
  };
}

function turnModel(turn: Turn): { id: string; provider: string; variant: string } {
  for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
    const step = turn.steps[index];
    if (step?.model) {
      return {
        id: step.model.id,
        provider: step.model.providerID,
        variant: step.model.variant ?? "",
      };
    }
  }
  return { id: "—", provider: "—", variant: "" };
}

function cacheText(tokens: TokenUsage | null | undefined): string {
  return `${formatNumber(tokens?.cacheRead)} / ${formatNumber(tokens?.cacheWrite)}`;
}

function contextCell(turn: Turn, contextBasis: string): StatsCell {
  return metricCell(
    "context",
    contextBasis === "cumulative" ? turn.promptTokensCumulative : turn.promptTokensLatest,
    formatNumber,
  );
}

const DELTA_FORMAT = (value: number): string =>
  `${value >= 0 ? "+" : ""}${formatNumber(value)}`;
const SPEED_FORMAT = (value: number): string => `${value.toFixed(1)} tok/s`;

/* -------------------------------------------------------------- basic rows */

export function buildBasicRows(
  analysis: Analysis,
  expandedTurns: ReadonlySet<string>,
  expandedSteps: ReadonlySet<string>,
): StatsRow[] {
  const rows: StatsRow[] = [];
  for (const turn of analysis.turns) {
    const expanded = expandedTurns.has(turn.id);
    rows.push({
      key: `turn:${turn.id}`,
      kind: "turn",
      turnID: turn.id,
      expanded,
      turn,
      cells: [
        indexCell("index", String(turn.index), expanded, turn.index),
        { key: "trigger", text: turn.trigger.label },
        metricCell("duration", turn.totalTime, formatDuration),
        countCell("input", turn.tokens.input),
        countCell("output", turn.tokens.output),
        metricCell("cost", turn.cost, formatCost),
        statusCell(turn),
      ],
    });
    if (!expanded) continue;
    for (const step of turn.steps) {
      rows.push({
        key: `step:${turn.id}:${step.id}`,
        kind: "step",
        turnID: turn.id,
        stepID: step.id,
        turn,
        step,
        cells: [
          {
            key: "index",
            text: `${turn.index}.${step.index}`,
            mono: true,
            title: `Trigger: ${step.trigger}`,
          },
          {
            key: "trigger",
            text: step.agent || "—",
            sub: step.trigger,
          },
          metricCell("duration", step.totalTime, formatDuration),
          countCell("input", step.tokens?.input),
          countCell("output", step.tokens?.output),
          {
            key: "cost",
            text: step.cost === null || step.cost === undefined ? "—" : formatCost(step.cost),
            numeric: true,
          },
          {
            key: "status",
            text: step.status,
            status: { label: step.status, tone: statusTone(step.status) },
            drill: step.eventIDs[0]
              ? {
                  eventID: step.eventIDs[0],
                  label: "View",
                  ariaLabel: `Open step ${turn.index}.${step.index} in Trajectory`,
                }
              : undefined,
          },
        ],
      });
      if (expandedSteps.has(`${turn.id}:${step.id}`)) {
        rows.push({
          key: `detail:${turn.id}:${step.id}`,
          kind: "detail",
          turnID: turn.id,
          stepID: step.id,
          turn,
          step,
          cells: [],
        });
      }
    }
  }
  return rows;
}

/* ----------------------------------------------------------- advanced rows */

/** The event kinds the legacy "Show event rows" switch lists (`app.js:2322`). */
export const STATS_EVENT_KINDS: readonly string[] = Object.freeze([
  "system",
  "skill",
  "shell",
  "compaction",
  "agent-switched",
  "model-switched",
  "location-switched",
  "synthetic",
  "retry",
  "error",
]);

export interface AdvancedRowsOptions {
  expandedTurns: ReadonlySet<string>;
  expandedSteps: ReadonlySet<string>;
  contextBasis: string;
  showEventRows: boolean;
}

export function buildAdvancedRows(
  analysis: Analysis,
  options: AdvancedRowsOptions,
): StatsRow[] {
  const rows: StatsRow[] = [];
  for (const turn of analysis.turns) {
    const expanded = options.expandedTurns.has(turn.id);
    const model = turnModel(turn);
    rows.push({
      key: `turn:${turn.id}`,
      kind: "turn",
      turnID: turn.id,
      expanded,
      turn,
      cells: [
        indexCell("index", String(turn.index), expanded, turn.index),
        { key: "trigger", text: turn.trigger.label },
        {
          key: "start",
          text: formatTime(turn.startTime),
          sub: `→ ${formatTime(turn.endTime)}`,
          mono: true,
        },
        metricCell("duration", turn.totalTime, formatDuration),
        {
          key: "model",
          text: model.id,
          sub: `${model.provider}${model.variant ? `#${model.variant}` : ""}`,
          mono: true,
        },
        {
          key: "steps",
          text: String(turn.steps.length),
          numeric: true,
        },
        countCell("input", turn.tokens.input),
        countCell("output", turn.tokens.output),
        countCell("reasoning", turn.tokens.reasoning),
        { key: "cache", text: cacheText(turn.tokens), numeric: true },
        metricCell("hit", turn.cacheHitRate, formatPercent),
        contextCell(turn, options.contextBasis),
        metricCell("delta", turn.contextDelta, DELTA_FORMAT),
        metricCell("model-time", turn.modelTime, formatDuration),
        metricCell("tool-time", turn.toolTime, formatDuration),
        metricCell("residual", turn.residualTime, formatDuration),
        metricCell("speed", turn.outputSpeed, SPEED_FORMAT),
        metricCell("cost", turn.cost, formatCost),
        statusCell(turn),
      ],
    });
    if (expanded) {
      for (const step of turn.steps) {
        const stepExpanded = options.expandedSteps.has(`${turn.id}:${step.id}`);
        rows.push({
          key: `step:${turn.id}:${step.id}`,
          kind: "step",
          turnID: turn.id,
          stepID: step.id,
          turn,
          step,
          expanded: stepExpanded,
          cells: [
            {
              key: "index",
              text: `${turn.index}.${step.index} ${stepExpanded ? "▾" : "▸"}`,
              mono: true,
              title: `Trigger: ${step.trigger}`,
            },
            {
              key: "trigger",
              text: step.trigger,
              sub: step.agent ?? undefined,
            },
            step.startUnknown
              ? { key: "start", text: "start unknown", muted: true }
              : {
                  key: "start",
                  text: formatTime(step.startTime),
                  sub: `→ ${formatTime(step.endTime)}`,
                  mono: true,
                },
            metricCell("duration", step.totalTime, formatDuration),
            {
              key: "model",
              text: step.model?.id ?? "—",
              sub: `${step.provider ?? step.model?.providerID ?? "—"}${
                step.model?.variant ? `#${step.model.variant}` : ""
              }`,
              mono: true,
            },
            {
              key: "steps",
              text: "—",
              title: "Steps are not nested inside a step",
              numeric: true,
            },
            countCell("input", step.tokens?.input),
            countCell("output", step.tokens?.output),
            countCell("reasoning", step.tokens?.reasoning),
            { key: "cache", text: cacheText(step.tokens), numeric: true },
            metricCell("hit", step.cacheHitRate, formatPercent),
            metricCell("context", step.promptTokens, formatNumber),
            {
              key: "delta",
              text: "—",
              title: "Context delta is computed per turn",
              numeric: true,
            },
            metricCell("model-time", step.modelTime, formatDuration),
            metricCell("tool-time", step.toolTime, formatDuration),
            metricCell("residual", step.residualTime, formatDuration),
            metricCell("speed", step.outputSpeed, SPEED_FORMAT),
            {
              key: "cost",
              text: step.cost === null || step.cost === undefined ? "—" : formatCost(step.cost),
              numeric: true,
            },
            {
              key: "status",
              text: step.status,
              status: { label: step.status, tone: statusTone(step.status) },
              drill: step.eventIDs[0]
                ? {
                    eventID: step.eventIDs[0],
                    label: "View",
                    ariaLabel: `Open step ${turn.index}.${step.index} in Trajectory`,
                  }
                : undefined,
            },
          ],
        });
        if (stepExpanded) {
          rows.push({
            key: `detail:${turn.id}:${step.id}`,
            kind: "detail",
            turnID: turn.id,
            stepID: step.id,
            turn,
            step,
            cells: [],
          });
        }
      }
    }
    if (options.showEventRows) {
      const events = analysis.events.filter(
        (event) =>
          event.turnID === turn.id && STATS_EVENT_KINDS.includes(event.kind),
      );
      for (const event of events) {
        rows.push({
          key: `event:${event.id}`,
          kind: "event",
          turnID: turn.id,
          event,
          cells: [],
        });
      }
    }
  }
  return rows;
}

export interface EventRowModel {
  time: string;
  kind: string;
  title: string;
  note: string;
}

/** The muted "not included in turn/step totals" line (`app.js:2001-2008`). */
export function eventRowModel(event: EventIndexEntry): EventRowModel {
  return {
    time: formatTime(event.timestamp),
    kind: event.kind,
    title: event.title,
    note: event.preview ? `${event.preview} (not included in turn/step totals)` : "(not included in turn/step totals)",
  };
}

/** Events with no turn attribution, listed by the Advanced renderer. */
export function unattachedEvents(analysis: Analysis): EventIndexEntry[] {
  return analysis.events.filter((event) => event.turnID === null);
}

/* --------------------------------------------------------------- totals row */

export interface TotalsRowModel {
  scopeLabel: string;
  cells: StatsCell[];
}

export function scopeLabel(totals: { scope: "session" | "window" }): string {
  return totals.scope === "session" ? "Session total" : "Window total";
}

export function buildBasicTotals(analysis: Analysis): TotalsRowModel {
  const totals = analysis.totals;
  return {
    scopeLabel: scopeLabel(totals),
    cells: [
      { key: "scope", text: scopeLabel(totals), span: 2 },
      metricCell("wall", totals.wallClockTime, formatDuration),
      countCell("input", totals.tokens.input),
      countCell("output", totals.tokens.output),
      metricCell("cost", totals.cost, formatCost),
      {
        key: "counts",
        text: `${formatNumber(totals.turns)} turns, ${formatNumber(totals.steps)} steps`,
      },
    ],
  };
}

export function buildAdvancedTotals(analysis: Analysis): TotalsRowModel {
  const totals = analysis.totals;
  const final = metricText(totals.finalContext, formatNumber);
  const cumulative = metricText(totals.cumulativePrompt, formatNumber);
  return {
    scopeLabel: scopeLabel(totals),
    cells: [
      { key: "scope", text: scopeLabel(totals), span: 5 },
      countCell("steps", totals.steps),
      countCell("input", totals.tokens.input),
      countCell("output", totals.tokens.output),
      countCell("reasoning", totals.tokens.reasoning),
      {
        key: "cache",
        text: `${formatNumber(totals.tokens.cacheRead)} / ${formatNumber(
          totals.tokens.cacheWrite,
        )}`,
        numeric: true,
      },
      metricCell("hit", totals.cacheHitRate, formatPercent),
      {
        key: "context",
        text: `Final ${final.text} · Cumulative ${cumulative.text}`,
        numeric: true,
        title: `final context: ${final.title}; cumulative prompt: ${cumulative.title}`,
      },
      { key: "delta", text: "—", numeric: true },
      metricCell("model-time", totals.modelTime, formatDuration),
      metricCell("tool-time", totals.toolTime, formatDuration),
      {
        key: "residual",
        text: "—",
        numeric: true,
        title: `Active turn time: ${formatDuration(totals.activeTurnTime.value)}`,
      },
      metricCell("speed", totals.outputSpeed, SPEED_FORMAT),
      metricCell("cost", totals.cost, formatCost),
      { key: "counts", text: `${formatNumber(totals.turns)} turns` },
    ],
  };
}

export function buildTotalsRow(
  analysis: Analysis,
  mode: "basic" | "advanced",
): TotalsRowModel {
  return mode === "advanced" ? buildAdvancedTotals(analysis) : buildBasicTotals(analysis);
}

/** The `Recorded by OpenCode` comparison line (`app.js:2414-2427`). */
export function buildRecordedLegend(
  analysis: Analysis,
): { text: string; note: string } | null {
  const recorded = analysis.totals.recorded;
  if (!recorded) return null;
  const tokens = recorded.tokens
    ? `in ${formatNumber(recorded.tokens.input)} · out ${formatNumber(
        recorded.tokens.output,
      )} · cache R/W ${formatNumber(recorded.tokens.cacheRead)}/${formatNumber(
        recorded.tokens.cacheWrite,
      )}`
    : "tokens unavailable";
  const cost = recorded.cost !== undefined ? ` · cost ${formatCost(recorded.cost)}` : "";
  return { text: `Recorded by OpenCode: ${tokens}${cost}`, note: recorded.note };
}

/* ------------------------------------------------------------- step detail */

export interface StepDetailToolModel {
  key: string;
  name: string;
  status: string;
  statusKind: "error" | "tool";
  duration: MetricText;
  childSessionIDs: string[];
  inputPreview: string | null;
  outputPreview: string | null;
}

export interface StepDetailModel {
  heading: string;
  html: string;
  truncated: boolean;
  reasoningHtml: string | null;
  facts: { label: string; value: string }[];
  tools: StepDetailToolModel[];
  noToolsNote: string;
  jump: DrillModel | null;
}

/** `stepDetailHtml` (`app.js:1929-1999`) as data, Markdown already rendered. */
export function buildStepDetail(
  turn: Turn,
  step: Step,
  responseLimit: number,
): StepDetailModel {
  const hasResponse = (step.responseText || "").trim().length > 0;
  const hasReasoning = (step.reasoningText || "").trim().length > 0;
  const primary = hasResponse ? step.responseText : step.reasoningText;
  const response = renderMarkdown(primary || "", { maxChars: responseLimit });
  const reasoning =
    hasResponse && hasReasoning
      ? renderMarkdown(step.reasoningText, {
          maxChars: Math.min(12_000, responseLimit),
        })
      : null;
  const jumpID = step.eventIDs[0] ?? "";
  return {
    heading: hasResponse ? "Response" : "Reasoning",
    html: response.html || '<p class="muted">No response text recorded.</p>',
    truncated: response.truncated,
    reasoningHtml: reasoning ? reasoning.html : null,
    facts: [
      { label: "Trigger", value: step.trigger },
      {
        label: "Start",
        value: step.startUnknown ? "start unknown" : formatTime(step.startTime),
      },
      { label: "End", value: formatTime(step.endTime) },
      { label: "Model", value: step.model?.id || "—" },
      { label: "Provider", value: step.provider || "—" },
      { label: "TTFT", value: metricText(step.ttft, formatDuration).text },
      { label: "Finish", value: step.finish || "—" },
      { label: "Tools", value: step.toolNames.join(", ") || "—" },
      { label: "Subagents", value: step.subagentSessionIDs.join(", ") || "—" },
      { label: "Uncertainty", value: step.uncertainty.join(", ") || "—" },
    ],
    tools: step.toolCalls.map((tool, position) => ({
      key: `${step.id}:tool:${position}`,
      name: tool.name,
      status: tool.status,
      statusKind: tool.status === "error" ? "error" : "tool",
      duration: metricText(tool.duration, formatDuration),
      childSessionIDs: tool.childSessionIDs,
      inputPreview: tool.inputPreview,
      outputPreview: tool.outputPreview,
    })),
    noToolsNote: "No tool calls in this step.",
    jump: jumpID
      ? {
          eventID: jumpID,
          label: "Open step in Trajectory",
          ariaLabel: `Open step ${turn.index}.${step.index} in Trajectory`,
        }
      : null,
  };
}

/* ------------------------------------------------------------ summary line */

export interface SummaryPiece {
  text: string;
  mark?: string;
  title?: string;
}

export function buildSummary(
  analysis: Analysis,
  mode: "basic" | "advanced",
): SummaryPiece[] {
  const totals = analysis.totals;
  const pieces: SummaryPiece[] = [
    { text: `${formatNumber(totals.turns)} turns` },
    { text: "·" },
    { text: `${formatNumber(totals.steps)} steps` },
    { text: "·" },
    { text: `${formatNumber(totals.toolCalls)} tool calls` },
  ];
  if (mode === "basic") return pieces;
  const active = metricText(totals.activeTurnTime, formatDuration);
  const wall = metricText(totals.wallClockTime, formatDuration);
  return [
    ...pieces,
    { text: "·" },
    { text: `active ${active.text}`, mark: active.mark, title: active.title },
    { text: "·" },
    { text: `wall ${wall.text}`, mark: wall.mark, title: wall.title },
  ];
}

/* -------------------------------------------------------------------- tiles */

export interface StatTileModel {
  id: string;
  label: string;
  value: string;
  /** Superscribed provenance mark; present on every tile figure. */
  mark: string;
  basis: MetricText["basis"];
  title: string;
  sub: string;
}

function metricTile(
  id: string,
  label: string,
  metric: Metric,
  formatter: (value: number) => string,
  sub: string,
): StatTileModel {
  const text = metricText(metric, formatter);
  return {
    id,
    label,
    value: text.text,
    mark: text.mark,
    basis: text.basis,
    title: text.title,
    sub,
  };
}

function countTile(
  id: string,
  label: string,
  value: number,
  sub: string,
): StatTileModel {
  return {
    id,
    label,
    value: formatNumber(value),
    mark: "M",
    basis: "measured",
    title: "measured",
    sub,
  };
}

/** The eight headline tiles; Basic keeps the first four (`app.js:1213`). */
export function buildStatTiles(
  analysis: Analysis,
  mode: "basic" | "advanced",
): StatTileModel[] {
  const totals = analysis.totals;
  const tiles: StatTileModel[] = [
    countTile("turns", "Turns", totals.turns, `${formatNumber(totals.steps)} steps`),
    countTile(
      "tokens",
      "Input tokens",
      totals.tokens.input,
      `out ${formatCompact(totals.tokens.output)} · reas ${formatCompact(
        totals.tokens.reasoning,
      )}`,
    ),
    metricTile("cache", "Cache", totals.cacheHitRate, formatPercent, `R ${formatCompact(
      totals.tokens.cacheRead,
    )} · W ${formatCompact(totals.tokens.cacheWrite)}`),
    metricTile("cost", "Cost", totals.cost, formatCost, "steps + compactions"),
    metricTile("model-time", "Model time", totals.modelTime, formatDuration, "created → streamed"),
    metricTile("tool-time", "Tool time", totals.toolTime, formatDuration, "sum; may overlap"),
    countTile(
      "errors",
      "Errors",
      totals.errors.total,
      `${formatNumber(totals.retries)} retries · ${formatNumber(totals.compactions)} compactions`,
    ),
    metricTile("speed", "Output speed", totals.outputSpeed, SPEED_FORMAT, "output / model time"),
  ];
  if (mode === "advanced") return tiles;
  const basicIDs = new Set(["turns", "tokens", "cost", "errors"]);
  return tiles.filter((tile) => basicIDs.has(tile.id));
}

/* ------------------------------------------------------------------ toolbar */

export const STATS_TAB_OPTIONS = Object.freeze([
  Object.freeze({ id: "table", label: "Table" }),
  Object.freeze({ id: "charts", label: "Charts" }),
] as const);

export type StatsTab = (typeof STATS_TAB_OPTIONS)[number]["id"];

export const BASIC_MODE_HINT =
  "Basic view · switch to Advanced in the top bar or Settings";

export const BASIS_LEGEND = Object.freeze([
  Object.freeze({ mark: "M", label: "measured" }),
  Object.freeze({ mark: "D", label: "derived" }),
  Object.freeze({ mark: "E", label: "estimated" }),
  Object.freeze({ mark: "—", label: "unavailable" }),
]);

export const BASIS_LEGEND_NOTE =
  "TTFT, approvals, request headers and tool-set changes are not persisted; prompt = input + cache read + cache write.";

export type CopyActionID = "review" | "digest";

export interface CopyActionModel {
  id: CopyActionID;
  label: string;
  /** The honest Phase 6 placeholder the button reports while unwired. */
  notice: string;
}

export const COPY_ACTIONS: readonly CopyActionModel[] = Object.freeze([
  Object.freeze({
    id: "review",
    label: "Copy LLM review prompt",
    notice: "Review-prompt copy arrives in Phase 6",
  }),
  Object.freeze({
    id: "digest",
    label: "Copy raw session digest",
    notice: "Digest copy arrives in Phase 6",
  }),
]);

export const CHARTS_PLACEHOLDER_TITLE = "Charts — Phase 5";
export const CHARTS_PLACEHOLDER_NOTE =
  "The four chart sections arrive in Phase 5. The table, basis legend, diagnostics and compactions stay available.";
