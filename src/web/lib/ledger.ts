/**
 * The Trajectory row model, a pure port of the ledger section of `src/ui/app.js`
 * (`hasEventSubLine` .. `buildLedgerRows`, `:1412-1533`).
 *
 * Two things are deliberately different from the legacy DOM renderer and both
 * are enforced here rather than in the component:
 *
 * - The event button carries no `aria-label`: its rendered text — time, title,
 *   kind badge, status text, preview and metrics — is already the complete
 *   accessible name, so the name cannot drift from what is on screen. Colour is
 *   never the only state signal.
 * - The height model accounts for a preview that wraps to up to four lines
 *   (`PREVIEW_MAX_LINES`), which the legacy one-line estimate did not. See
 *   `rowHeight()` for the numbers; the live ledger still measures every row, so
 *   the estimate can never clip content.
 */

import type {
  ModelRef,
  NormalizedEvent,
  Step,
  ToolCallDetail,
  Turn,
} from "../../core/types.ts";
import {
  formatCompact,
  formatCost,
  formatDuration,
  formatPercent,
  modelLabel,
} from "./format.ts";

/* ------------------------------------------------------------------ heights */

/** Line heights of the four stacked row lines (`app.js:1450`). */
export const LINE_HEIGHTS = Object.freeze([20, 18, 18, 17] as const);
/** Vertical rhythm between the row lines (`app.js:1461`). */
export const ROW_GAP = 3;
/** The row's own padding and border budget (`app.js:1457`, `:1464`). */
export const ROW_BASE = 16;
export const ROW_PADDING = 2;
/** Fixed header heights (`app.js:1793`). */
export const TURN_HEADER_HEIGHT = 46;
export const STEP_HEADER_HEIGHT = 32;
/** A preview may occupy at most four lines; the row never clips beyond that. */
export const PREVIEW_MAX_LINES = 4;
export const PREVIEW_LINE_HEIGHT = LINE_HEIGHTS[2];
/**
 * Conservative wrap budget for the preview line count. The ledger's fluid width
 * always fits at least this many 12 px characters, so the estimate never lands
 * below the rendered line count on a supported viewport.
 */
export const PREVIEW_CHARS_PER_LINE = 84;

export type BadgeKind =
  | "neutral"
  | "error"
  | "retry"
  | "compaction"
  | "context"
  | "tool"
  | "subagent"
  | "uncertain";

export interface BadgeModel {
  label: string;
  kind: BadgeKind;
  title?: string;
}

/* ------------------------------------------------------------------- labels */

export function hasEventSubLine(event: NormalizedEvent): boolean {
  return Boolean(event.agent || event.model || event.tool || event.stepID);
}

/** The sub-line text, without markup (`eventSubLine`, `app.js:1416-1426`). */
export function eventSubLine(event: NormalizedEvent): string {
  return [
    event.agent ? `agent ${event.agent}` : "",
    event.model ? modelLabel(event.model) : "",
    event.tool ? `tool ${event.tool.name} (${event.tool.status})` : "",
    event.stepID ? `step ${event.stepID}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The metric chips under the preview (`eventMetrics`, `app.js:1428-1447`). */
export function eventMetrics(event: NormalizedEvent): string[] {
  const tool = event.tool;
  const metrics: string[] = [];
  if (event.tokens) {
    const prompt =
      event.tokens.input + event.tokens.cacheRead + event.tokens.cacheWrite;
    metrics.push(`prompt ${formatCompact(prompt)}`);
    metrics.push(`out ${formatCompact(event.tokens.output)}`);
    const rate = prompt > 0 ? event.tokens.cacheRead / prompt : null;
    if (rate !== null) metrics.push(`cache ${formatPercent(rate)}`);
  }
  if (tool?.duration?.value !== null && tool?.duration?.value !== undefined) {
    metrics.push(formatDuration(tool.duration.value));
  }
  if (event.cost !== null && event.cost !== undefined) {
    metrics.push(formatCost(event.cost));
  }
  return metrics;
}

/** `event.meta.description` wins over the derived preview (`app.js:1493`). */
export function eventPreview(event: NormalizedEvent): string | null {
  if (!event.textPreview) return null;
  const description = event.meta?.description;
  if (typeof description === "string" && description.length > 0) return description;
  return event.textPreview;
}

/**
 * The number of preview lines the model reserves (1..4). Explicit newlines are
 * counted; each paragraph wraps at `PREVIEW_CHARS_PER_LINE`.
 */
export function previewLineCount(text: string | null | undefined): number {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  if (source.length === 0) return 0;
  let lines = 0;
  for (const paragraph of source.split("\n")) {
    lines += Math.max(1, Math.ceil(paragraph.length / PREVIEW_CHARS_PER_LINE));
  }
  return Math.min(PREVIEW_MAX_LINES, Math.max(1, lines));
}

/**
 * The strict legacy height: 16 px base, one height per present line, a 3 px gap
 * between present lines, rounded up plus 2 px of padding.
 */
export function eventRowHeight(event: NormalizedEvent): number {
  const present = [
    true,
    hasEventSubLine(event),
    Boolean(event.textPreview),
    eventMetrics(event).length > 0,
  ];
  let height = ROW_BASE;
  let count = 0;
  for (let index = 0; index < present.length; index++) {
    if (!present[index]) continue;
    height += (count > 0 ? ROW_GAP : 0) + LINE_HEIGHTS[index];
    count++;
  }
  return Math.ceil(height + ROW_PADDING);
}

/* ----------------------------------------------------------------- row model */

export type LedgerRow =
  | { type: "turn"; key: string; turn: Turn | null }
  | {
      type: "step";
      key: string;
      turn: Turn | null;
      step: Step | undefined;
      stepID: string;
    }
  | { type: "event"; key: string; event: NormalizedEvent; eventID: string };

/** The row key TanStack Virtual uses to keep measurements across prepends. */
export function rowKey(row: LedgerRow): string {
  return row.key;
}

export function buildLedgerRows(
  events: readonly NormalizedEvent[],
  turns: readonly Turn[],
): LedgerRow[] {
  const byTurn = new Map(turns.map((turn) => [turn.id, turn]));
  const rows: LedgerRow[] = [];
  let currentTurn: string | null = null;
  let currentStep: string | null = null;
  let unattachedHeader = false;
  for (const event of events) {
    if (event.turnID !== currentTurn) {
      currentTurn = event.turnID;
      currentStep = null;
      unattachedHeader = false;
      if (event.turnID === null) {
        if (!unattachedHeader) {
          rows.push({ type: "turn", key: "turn:unattached", turn: null });
          unattachedHeader = true;
        }
      } else {
        const turn = byTurn.get(event.turnID);
        if (turn) rows.push({ type: "turn", key: `turn:${turn.id}`, turn });
      }
    }
    if (event.stepID && event.stepID !== currentStep) {
      currentStep = event.stepID;
      const turn = event.turnID ? byTurn.get(event.turnID) : null;
      const step = turn?.steps.find((item) => item.id === event.stepID);
      rows.push({
        type: "step",
        key: `step:${event.turnID ?? "unattached"}:${event.stepID}`,
        turn: turn ?? null,
        step,
        stepID: event.stepID,
      });
    }
    if (!event.stepID) currentStep = null;
    rows.push({
      type: "event",
      key: `event:${event.id}`,
      event,
      eventID: event.id,
    });
  }
  return rows;
}

/**
 * The estimate TanStack Virtual starts from. It is the legacy height plus one
 * preview line height for each preview line beyond the first, capped at four.
 */
export function rowHeight(row: LedgerRow): number {
  if (row.type === "turn") return TURN_HEADER_HEIGHT;
  if (row.type === "step") return STEP_HEADER_HEIGHT;
  const extra = Math.max(0, previewLineCount(eventPreview(row.event)) - 1);
  return eventRowHeight(row.event) + extra * PREVIEW_LINE_HEIGHT;
}

/* -------------------------------------------------------------------- badges */

export function eventBadges(event: NormalizedEvent): BadgeModel[] {
  const badges: BadgeModel[] = [];
  if (event.flags?.error && event.kind !== "error") {
    badges.push({ label: "error", kind: "error" });
  }
  if (event.flags?.retry && event.kind !== "retry") {
    badges.push({ label: "retry", kind: "retry" });
  }
  if (event.flags?.compaction && event.kind !== "compaction") {
    badges.push({ label: "compaction", kind: "compaction" });
  }
  if (event.flags?.context) badges.push({ label: "context", kind: "context" });
  if (event.flags?.subagent) badges.push({ label: "subagent", kind: "subagent" });
  if (event.uncertainty?.length) {
    badges.push({
      label: "uncertain",
      kind: "uncertain",
      title: event.uncertainty.join(", "),
    });
  }
  return badges;
}

export function kindBadge(event: NormalizedEvent): BadgeModel {
  return {
    label: event.kind,
    kind: event.kind === "error" ? "error" : event.kind === "tool" ? "tool" : "neutral",
  };
}

/* -------------------------------------------------------------------- cursor */

/** Clamps a keyboard cursor inside the event list; -1 means "no cursor". */
export function clampCursor(index: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * The `j`/`k` step. `-1` (nothing selected) lands on the first event for both
 * directions, matching the legacy clamp at zero.
 */
export function moveCursor(
  current: number,
  count: number,
  delta: 1 | -1,
): number {
  if (count <= 0) return -1;
  const next = current + delta;
  return clampCursor(next, count);
}

/** The cursor cue that does not rely on colour. */
export const CURSOR_LABEL = "Cursor";

/** The metric chip for a tool call, exported so the drawer reuses one rule. */
export function toolDurationLabel(tool: ToolCallDetail | null): string {
  return tool ? formatDuration(tool.duration?.value ?? null) : "—";
}

/** A model label for headers, tolerant of a missing step. */
export function stepModelLabel(step: Step | undefined): string {
  const model: ModelRef | null = step?.model ?? null;
  return model ? modelLabel(model) : "";
}
