import type { Metric, Step } from "../../../core/types.ts";
import {
  basisMark,
  formatCompact,
  formatCost,
  formatDuration,
} from "../../../core/format.ts";
import { statusMark } from "./status.ts";

/**
 * Pure step-row model for the turn accordion.
 *
 * This module owns one row of primitive text per `Step`; the view only pads and
 * colors what it returns. It has no JSX, no SDK import and no terminal state,
 * so phase-4 tests can import it directly.
 */

export type StepField =
  | "index"
  | "trigger"
  | "model"
  | "tools"
  | "tokens"
  | "cost"
  | "time"
  | "status";

export interface StepRowValues {
  readonly index: string;
  readonly trigger: string;
  readonly model: string;
  readonly tools: string;
  readonly tokens: string;
  readonly cost: string;
  readonly time: string;
  readonly status: string;
}

const EM_DASH = "—";

const STEP_WIDTHS: Readonly<Record<StepField, number>> = {
  index: 3,
  trigger: 18,
  model: 22,
  tools: 20,
  tokens: 17,
  cost: 10,
  time: 10,
  status: 5,
};

const LEFT_ALIGNED = new Set<StepField>(["trigger", "model", "tools"]);

const ALL_FIELDS: readonly StepField[] = [
  "index",
  "trigger",
  "model",
  "tools",
  "tokens",
  "cost",
  "time",
  "status",
];

/**
 * Step rows degrade like the turn table: extra context disappears on narrow
 * terminals while index, tokens, cost and status always survive.
 */
export function stepFields(width: number): readonly StepField[] {
  const safe = Number.isFinite(width) ? Math.trunc(width) : 0;
  if (safe >= 120) return ALL_FIELDS;
  if (safe >= 90) {
    return ["index", "trigger", "model", "tokens", "cost", "time", "status"];
  }
  if (safe >= 81) return ["index", "trigger", "tokens", "cost", "status"];
  return ["index", "tokens", "cost", "status"];
}

function text(value: string | null | undefined): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : EM_DASH;
}

function marked(
  metric: Metric | undefined,
  formatter: (value: number | null) => string,
): string {
  if (!metric || metric.value === null || !Number.isFinite(metric.value)) {
    return EM_DASH;
  }
  return `${formatter(metric.value)} ${basisMark(metric.basis)}`;
}

function modelLabel(step: Step): string {
  const id = step.model?.id;
  if (typeof id === "string" && id.trim().length > 0) return id.trim();
  return text(step.provider);
}

function toolSummary(step: Step): string {
  const names = Array.isArray(step.toolNames)
    ? step.toolNames.filter(
        (name): name is string =>
          typeof name === "string" && name.trim().length > 0,
      )
    : [];
  if (names.length > 0) return names.join(",");
  const calls = Array.isArray(step.toolCalls) ? step.toolCalls.length : 0;
  if (calls > 0) return calls === 1 ? "1 call" : `${calls} calls`;
  return EM_DASH;
}

function tokensLabel(step: Step): string {
  const tokens = step.tokens;
  if (!tokens) return EM_DASH;
  return `${formatCompact(tokens.input)}→${formatCompact(tokens.output)}`;
}

/** Primitive cell text for one accordion row. */
export function stepCellValues(step: Step): StepRowValues {
  const trigger =
    typeof step.trigger === "string" && step.trigger.trim().length > 0
      ? step.trigger.trim()
      : text(step.agent);
  return {
    index: Number.isFinite(step.index) ? String(Math.trunc(step.index)) : "0",
    trigger,
    model: modelLabel(step),
    tools: toolSummary(step),
    tokens: tokensLabel(step),
    cost: formatCost(step.cost),
    time: marked(step.modelTime, formatDuration),
    status: statusMark(step.status).symbol,
  };
}

function padCell(field: StepField, value: string): string {
  const width = STEP_WIDTHS[field];
  const clipped =
    value.length > width
      ? `${value.slice(0, Math.max(0, width - 1))}…`
      : value;
  return LEFT_ALIGNED.has(field)
    ? clipped.padEnd(width)
    : clipped.padStart(width);
}

export interface FormattedStepRow {
  /** Indented row text up to (excluding) the status cell. */
  readonly prefix: string;
  /** Status cell prefixed with its separating space, so it can be colored alone. */
  readonly status: string;
}

/**
 * Formats one step row below its turn. The four-space indent keeps the row
 * visibly nested under the turn table while staying monospace-aligned.
 */
export function formatStepRow(
  step: Step,
  width: number,
  fields: readonly StepField[] = stepFields(width),
): FormattedStepRow {
  const values = stepCellValues(step);
  const cells: string[] = [];
  let status = "";
  for (const field of fields) {
    const cell = padCell(field, values[field]);
    if (field === "status") {
      status = ` ${cell}`;
      continue;
    }
    cells.push(cell);
  }
  return { prefix: `    ${cells.join(" ")}`, status };
}
