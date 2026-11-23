/**
 * Advisory guardrail budgets evaluated purely from an already-loaded
 * `Analysis`.
 *
 * Guardrails are a second, deliberately separate vocabulary from session
 * health: health answers "does this session look unhealthy?" with frozen,
 * user-approved thresholds (`HEALTH_RULES`), while a guardrail answers "has
 * this session crossed a budget the user configured?" with thresholds owned by
 * the browser's per-user settings store. The two share the evidence-link shape
 * and the growth-run vocabulary, never a verdict: a guardrail warning is always
 * `advisory`, is never a health rule, and cannot block, interrupt or prompt
 * anything — the server stays GET-only and the evaluator is a pure function.
 *
 * The evaluator never performs I/O, never reads the clock and never re-reads
 * the source. Observations are deterministic phrases plus counts, mirroring
 * `HealthRuleResult.note`, and never embed payload text.
 *
 * `DEFAULT_GUARDRAILS` is this module's own default (the web UI mirrors it as a
 * frozen literal and the TUI imports it directly); `HEALTH_RULES` is never
 * read or modified here.
 */

import type { Analysis, TokenUsage, Turn } from "./types.ts";
import type { DiagnosticIncident } from "./diagnostics.ts";
import { MAX_EVENT_LINKS, MAX_TURN_LINKS, longestGrowthRun } from "./health.ts";

/** The closed budget vocabulary, in the order warnings are reported. */
export type GuardrailBudgetId =
  | "tokens-total"
  | "cost-total"
  | "context-run"
  | "retries"
  | "tool-failures"
  | "elapsed-minutes";

/** One budget per key; every value is a non-negative number. */
export interface GuardrailThresholds {
  /** Total recorded tokens (`input + output + reasoning + cache read/write`). */
  tokensTotal: number;
  /** Total recorded cost in dollars. */
  costTotal: number;
  /** Longest consecutive context-increase run, in turns. */
  contextRun: number;
  /** Recorded retry events. */
  retries: number;
  /** Diagnostics incidents (repeated tool failures). */
  toolFailures: number;
  /** Wall time from the first to the last recorded event, in minutes. */
  elapsedMinutes: number;
}

/**
 * The out-of-the-box budgets. They sit just above the approved health watch
 * levels on purpose: health flags an anomaly, a guardrail flags a budget the
 * user chose to track. Frozen so the UI mirror, the TUI and the tests all
 * assert against the same numbers.
 */
export const DEFAULT_GUARDRAILS: Readonly<GuardrailThresholds> = Object.freeze({
  tokensTotal: 2_000_000,
  costTotal: 5,
  contextRun: 6,
  retries: 10,
  toolFailures: 5,
  elapsedMinutes: 60,
});

/**
 * The largest accepted value per budget. This table is the single source of
 * truth: the GET `gr.*` contract validates against it, the browser settings
 * panel mirrors it as a frozen literal and a test pins the mirror field for
 * field, so a client and the server can never disagree on a bound.
 */
export const GUARDRAIL_MAX: Readonly<GuardrailThresholds> = Object.freeze({
  tokensTotal: 1e12,
  costTotal: 1e12,
  contextRun: 1e12,
  retries: 1e12,
  toolFailures: 1e12,
  elapsedMinutes: 100_000,
});

/** Largest accepted `elapsedMinutes` budget; derived from `GUARDRAIL_MAX`. */
export const MAX_ELAPSED_MINUTES = GUARDRAIL_MAX.elapsedMinutes;

/**
 * One budget's form metadata: the stored key, its sentence-case label, the
 * inclusive bounds, the input step and whether only whole numbers are accepted.
 *
 * This table is additive metadata only — it does not participate in
 * evaluation, so `evaluateGuardrails` behaviour is unchanged. The web UI
 * derives its settings form from it (one source of truth) instead of keeping a
 * second hand-maintained copy of the vocabulary or its bounds.
 */
export interface GuardrailField {
  /** Key in `GuardrailThresholds` and in the browser's stored settings. */
  readonly key: keyof GuardrailThresholds;
  /** Sentence-case form label. */
  readonly label: string;
  /** Smallest accepted value (inclusive). */
  readonly min: number;
  /** Largest accepted value (inclusive); always `GUARDRAIL_MAX[key]`. */
  readonly max: number;
  /** Input step hint; display metadata only, not a validation rule. */
  readonly step: number;
  /** Count budgets are whole numbers; cost and elapsed minutes stay fractional. */
  readonly integer: boolean;
}

/**
 * The closed, ordered budget vocabulary the settings form renders. Order
 * matches the evaluation order in `evaluateGuardrails` and the order of the
 * `gr.*` GET parameters, so the panel and the server can never disagree.
 */
export const GUARDRAIL_FIELDS: readonly GuardrailField[] = Object.freeze([
  Object.freeze({
    key: "tokensTotal",
    label: "Total tokens",
    min: 0,
    max: GUARDRAIL_MAX.tokensTotal,
    step: 1_000,
    integer: true,
  }),
  Object.freeze({
    key: "costTotal",
    label: "Total cost (USD)",
    min: 0,
    max: GUARDRAIL_MAX.costTotal,
    step: 0.5,
    integer: false,
  }),
  Object.freeze({
    key: "contextRun",
    label: "Context growth run (turns)",
    min: 0,
    max: GUARDRAIL_MAX.contextRun,
    step: 1,
    integer: true,
  }),
  Object.freeze({
    key: "retries",
    label: "Retry events",
    min: 0,
    max: GUARDRAIL_MAX.retries,
    step: 1,
    integer: true,
  }),
  Object.freeze({
    key: "toolFailures",
    label: "Tool-failure incidents",
    min: 0,
    max: GUARDRAIL_MAX.toolFailures,
    step: 1,
    integer: true,
  }),
  Object.freeze({
    key: "elapsedMinutes",
    label: "Elapsed time (minutes)",
    min: 0,
    max: GUARDRAIL_MAX.elapsedMinutes,
    step: 5,
    integer: false,
  }),
]);

/**
 * One crossed budget. `observed` is a deterministic phrase with the measured
 * numbers, `threshold` is the budget that was crossed, and the evidence ids
 * already exist in the analysis (same caps as health).
 */
export interface GuardrailWarning {
  id: GuardrailBudgetId;
  label: string;
  observed: string;
  threshold: number;
  basis: "derived";
  advisory: true;
  /** Capped event ids that exist in `Analysis.events`. */
  eventIDs: string[];
  /** Capped turn ids that exist in `Analysis.turns`. */
  turnIDs: string[];
}

/**
 * A budget that could not be evaluated. It is reported instead of guessed:
 * an elapsed-time budget on a windowed analysis, or a cost/token budget with
 * nothing recorded, produces no warning at all.
 */
export interface GuardrailSkip {
  id: GuardrailBudgetId;
  label: string;
  note: string;
}

export interface Guardrails {
  /** Crossed budgets only, in the fixed `GuardrailBudgetId` order. */
  warnings: GuardrailWarning[];
  /** Budgets skipped for lack of evaluable data; never a guess. */
  skipped: GuardrailSkip[];
}

const LABELS: Readonly<Record<GuardrailBudgetId, string>> = Object.freeze({
  "tokens-total": "Token budget",
  "cost-total": "Cost budget",
  "context-run": "Context growth budget",
  retries: "Retry budget",
  "tool-failures": "Tool-failure budget",
  "elapsed-minutes": "Elapsed-time budget",
});

/** A finite, non-negative threshold; anything else falls back to the default. */
function limitFor(
  thresholds: Partial<GuardrailThresholds>,
  key: keyof GuardrailThresholds,
): number {
  const value = thresholds[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_GUARDRAILS[key];
}

/** Deduplicates, drops empty ids and caps the list in recorded order. */
function capIDs(ids: readonly string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/** `input + output + reasoning + cache read + cache write`, like `sumTokens`. */
function totalTokens(tokens: TokenUsage): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cacheRead +
    tokens.cacheWrite
  );
}

/** Highest-token turns, descending, ties resolved by recorded order. */
function heaviestTurns(turns: readonly Turn[], limit: number): string[] {
  return [...turns]
    .sort(
      (left, right) =>
        totalTokens(right.tokens) - totalTokens(left.tokens) ||
        left.index - right.index,
    )
    .filter((turn) => totalTokens(turn.tokens) > 0)
    .slice(0, limit)
    .map((turn) => turn.id);
}

/** Highest-cost turns, descending, ties resolved by recorded order. */
function costliestTurns(turns: readonly Turn[], limit: number): string[] {
  return [...turns]
    .filter((turn) => turn.cost.value !== null)
    .sort(
      (left, right) =>
        (right.cost.value ?? 0) - (left.cost.value ?? 0) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map((turn) => turn.id);
}

function warning(
  id: GuardrailBudgetId,
  observed: string,
  threshold: number,
  eventIDs: readonly string[] = [],
  turnIDs: readonly string[] = [],
): GuardrailWarning {
  return {
    id,
    label: LABELS[id],
    observed,
    threshold,
    basis: "derived",
    advisory: true,
    eventIDs: capIDs(eventIDs, MAX_EVENT_LINKS),
    turnIDs: capIDs(turnIDs, MAX_TURN_LINKS),
  };
}

type BudgetOutcome =
  | { kind: "warning"; warning: GuardrailWarning }
  | { kind: "skip"; skip: GuardrailSkip }
  /** Evaluated and below its budget: nothing to report. */
  | { kind: "none" };

const NONE: BudgetOutcome = { kind: "none" };

function skip(id: GuardrailBudgetId, note: string): BudgetOutcome {
  return { kind: "skip", skip: { id, label: LABELS[id], note } };
}

function tokensBudget(analysis: Analysis, limit: number): BudgetOutcome {
  const tokens = totalTokens(analysis.totals.tokens);
  if (tokens === 0 && !analysis.capabilities.tokenUsage) {
    return skip("tokens-total", "token usage was not recorded");
  }
  const observed = `${tokens} total token(s) recorded`;
  if (tokens < limit) return NONE;
  return {
    kind: "warning",
    warning: warning(
      "tokens-total",
      observed,
      limit,
      [],
      heaviestTurns(analysis.turns, 3),
    ),
  };
}

function costBudget(analysis: Analysis, limit: number): BudgetOutcome {
  const cost = analysis.totals.cost.value;
  if (cost === null) return skip("cost-total", "cost was not recorded");
  const observed = `$${cost.toFixed(2)} total recorded cost`;
  if (cost < limit) return NONE;
  return {
    kind: "warning",
    warning: warning(
      "cost-total",
      observed,
      limit,
      [],
      costliestTurns(analysis.turns, 3),
    ),
  };
}

function contextRunBudget(analysis: Analysis, limit: number): BudgetOutcome {
  const available = analysis.turns.filter(
    (turn) => turn.contextDelta.value !== null,
  ).length;
  if (available < 2) {
    return skip(
      "context-run",
      `${available} turn(s) recorded a context delta; at least 2 are required`,
    );
  }
  const run = longestGrowthRun(analysis);
  const length = run?.length ?? 0;
  const observed = `longest growth run ${length} turn(s)`;
  if (length < limit) return NONE;
  const turnIDs = run ? [run.first.id, run.last.id] : [];
  return {
    kind: "warning",
    warning: warning("context-run", observed, limit, [], turnIDs),
  };
}

function retriesBudget(analysis: Analysis, limit: number): BudgetOutcome {
  const retries = analysis.totals.retries;
  const observed = `${retries} retry event(s) recorded`;
  if (retries < limit) return NONE;
  const eventIDs = analysis.events
    .filter((event) => event.kind === "retry")
    .map((event) => event.id);
  return {
    kind: "warning",
    warning: warning("retries", observed, limit, eventIDs),
  };
}

function toolFailuresBudget(analysis: Analysis, limit: number): BudgetOutcome {
  const incidents: DiagnosticIncident[] = analysis.diagnostics?.incidents ?? [];
  const observed = `${incidents.length} tool-failure incident(s) recorded`;
  if (incidents.length < limit) return NONE;
  const eventIDs = incidents.map((incident) => incident.firstFailureEventID);
  return {
    kind: "warning",
    warning: warning("tool-failures", observed, limit, eventIDs),
  };
}

/**
 * Wall time between the first and the last recorded event. Only a complete
 * analysis bounds the whole session, so a windowed one is skipped rather than
 * timed from a partial event set.
 */
function elapsedBudget(analysis: Analysis, limit: number): BudgetOutcome {
  if (!analysis.coverage.complete) {
    return skip(
      "elapsed-minutes",
      "the analysis covers a window, not the full session",
    );
  }
  const events = analysis.events;
  if (events.length === 0) {
    return skip("elapsed-minutes", "no events were recorded");
  }
  let first = events[0]!;
  let last = events[0]!;
  for (const event of events) {
    if (event.timestamp < first.timestamp) first = event;
    if (event.timestamp > last.timestamp) last = event;
  }
  const minutes = Math.max(0, last.timestamp - first.timestamp) / 60_000;
  const observed = `${minutes.toFixed(1)} minute(s) from the first to the last recorded event`;
  if (minutes < limit) return NONE;
  return {
    kind: "warning",
    warning: warning("elapsed-minutes", observed, limit, [first.id, last.id]),
  };
}

/**
 * Primary entry point. Pure, deterministic and local; the default thresholds
 * are `DEFAULT_GUARDRAILS`. A malformed injected threshold (not finite or
 * negative) falls back to the default for that budget, so a hostile query
 * cannot disable a budget or make the evaluator throw.
 */
export function evaluateGuardrails(
  analysis: Analysis,
  thresholds: Partial<GuardrailThresholds> = DEFAULT_GUARDRAILS,
): Guardrails {
  const limits: GuardrailThresholds = {
    tokensTotal: limitFor(thresholds, "tokensTotal"),
    costTotal: limitFor(thresholds, "costTotal"),
    contextRun: limitFor(thresholds, "contextRun"),
    retries: limitFor(thresholds, "retries"),
    toolFailures: limitFor(thresholds, "toolFailures"),
    elapsedMinutes: limitFor(thresholds, "elapsedMinutes"),
  };
  const outcomes: BudgetOutcome[] = [
    tokensBudget(analysis, limits.tokensTotal),
    costBudget(analysis, limits.costTotal),
    contextRunBudget(analysis, limits.contextRun),
    retriesBudget(analysis, limits.retries),
    toolFailuresBudget(analysis, limits.toolFailures),
    elapsedBudget(analysis, limits.elapsedMinutes),
  ];
  const warnings: GuardrailWarning[] = [];
  const skipped: GuardrailSkip[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "skip") skipped.push(outcome.skip);
    else if (outcome.kind === "warning") warnings.push(outcome.warning);
  }
  return { warnings, skipped };
}
