/**
 * Deterministic session health derived purely from an already-loaded
 * `Analysis`.
 *
 * The evaluator never performs I/O, never reads the clock and never re-reads
 * the source: it is a pure function of totals, turns, compactions, diagnostics,
 * capabilities and coverage. Every rule is a documented heuristic with
 * exported thresholds (`HEALTH_RULES`), a watch level, a strong level and an
 * evaluable guard. Notes are deterministic phrases plus counts, mirroring
 * `Diagnostics.why`, and never embed payload text.
 *
 * The result is never a numeric score: `state` is one of three words and the
 * rules that produced it are returned alongside, so the UI can explain it.
 */

import type { Analysis, Metric, Turn } from "./types.ts";
import type { CompactionTransaction } from "./types.ts";
import type { DiagnosticIncident } from "./diagnostics.ts";

export type HealthState = "healthy" | "watch" | "degraded";

export type HealthRuleLevel = "watch" | "strong";

export type HealthRuleId =
  | "error-rate"
  | "retry-count"
  | "tool-failure-recurrence"
  | "context-growth"
  | "cost-per-turn"
  | "low-cache-hit"
  | "unfinished-outcome";

/** One rule's verdict plus the already-present ids it can drill into. */
export interface HealthRuleResult {
  id: HealthRuleId;
  label: string;
  triggered: boolean;
  level: HealthRuleLevel | null;
  evaluable: boolean;
  /** Deterministic phrase plus counts; never payload text. */
  note: string;
  /** Capped event ids that exist in `Analysis.events`. */
  eventIDs: string[];
  /** Capped turn ids that exist in `Analysis.turns`. */
  turnIDs: string[];
}

export interface SessionHealth {
  state: HealthState;
  insufficient: boolean;
  insufficientReasons: string[];
  rules: HealthRuleResult[];
  triggeredCount: number;
}

/** Drill targets are capped so the breakdown stays scannable. */
export const MAX_EVENT_LINKS = 10;
export const MAX_TURN_LINKS = 6;

/**
 * The threshold shape the evaluator reads. It matches the frozen
 * `HEALTH_RULES` object field for field, so the approved defaults are one
 * valid value of it; callers may substitute another object (tests do) without
 * touching the frozen constant.
 */
export interface HealthThresholds {
  errorRate: {
    watchRate: number;
    watchErrors: number;
    strongRate: number;
    strongErrors: number;
  };
  retryCount: { watch: number; strong: number };
  toolFailureRecurrence: {
    watchIncidents: number;
    strongIncidents: number;
    watchMaxAttempts: number;
    strongMaxAttempts: number;
  };
  contextGrowth: {
    watchRun: number;
    strongRun: number;
    watchFinalContext: number;
    strongFinalContext: number;
  };
  costPerTurn: { watch: number; strong: number };
  lowCacheHit: {
    lowBelow: number;
    watchLowTurns: number;
    strongLowTurns: number;
    watchShare: number;
    strongShare: number;
  };
  maxEventLinks: number;
  maxTurnLinks: number;
}

/**
 * The user-approved thresholds of 2026-11-17. Frozen so tests, the UI and the
 * documentation all assert against the same source.
 */
export const HEALTH_RULES = Object.freeze({
  errorRate: Object.freeze({
    watchRate: 0.25,
    watchErrors: 4,
    strongRate: 0.6,
    strongErrors: 6,
  }),
  retryCount: Object.freeze({ watch: 8, strong: 15 }),
  toolFailureRecurrence: Object.freeze({
    watchIncidents: 4,
    strongIncidents: 7,
    watchMaxAttempts: 5,
    strongMaxAttempts: 9,
  }),
  contextGrowth: Object.freeze({
    watchRun: 5,
    strongRun: 8,
    watchFinalContext: 150_000,
    strongFinalContext: 250_000,
  }),
  costPerTurn: Object.freeze({ watch: 2, strong: 10 }),
  lowCacheHit: Object.freeze({
    lowBelow: 0.2,
    watchLowTurns: 5,
    strongLowTurns: 9,
    watchShare: 0.6,
    strongShare: 0.8,
  }),
  maxEventLinks: MAX_EVENT_LINKS,
  maxTurnLinks: MAX_TURN_LINKS,
});

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function levelFor(watch: boolean, strong: boolean): HealthRuleLevel | null {
  if (strong) return "strong";
  if (watch) return "watch";
  return null;
}

function rule(
  thresholds: HealthThresholds,
  id: HealthRuleId,
  label: string,
  level: HealthRuleLevel | null,
  evaluable: boolean,
  note: string,
  eventIDs: readonly string[] = [],
  turnIDs: readonly string[] = [],
): HealthRuleResult {
  return {
    id,
    label,
    triggered: level !== null,
    level,
    evaluable,
    note,
    eventIDs: capIDs(eventIDs, thresholds.maxEventLinks),
    turnIDs: capIDs(turnIDs, thresholds.maxTurnLinks),
  };
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

/** `totals.errors.total / totals.steps`; steps are the work denominator. */
function errorRateRule(
  analysis: Analysis,
  thresholds: HealthThresholds,
): HealthRuleResult {
  const { errors, steps } = analysis.totals;
  const threshold = thresholds.errorRate;
  if (steps === 0) {
    return rule(
      thresholds,
      "error-rate",
      "Error rate",
      null,
      false,
      "no steps were recorded",
    );
  }
  const rate = errors.total / steps;
  const level = levelFor(
    rate >= threshold.watchRate && errors.total >= threshold.watchErrors,
    rate >= threshold.strongRate && errors.total >= threshold.strongErrors,
  );
  const eventIDs = analysis.events
    .filter((event) => event.flags.error)
    .map((event) => event.id);
  return rule(
    thresholds,
    "error-rate",
    "Error rate",
    level,
    true,
    `${errors.total} error(s) across ${steps} step(s); rate ${formatRatio(rate)}`,
    eventIDs,
  );
}

function retryCountRule(
  analysis: Analysis,
  thresholds: HealthThresholds,
): HealthRuleResult {
  const threshold = thresholds.retryCount;
  const retries = analysis.totals.retries;
  const level = levelFor(
    retries >= threshold.watch,
    retries >= threshold.strong,
  );
  const eventIDs = analysis.events
    .filter((event) => event.kind === "retry")
    .map((event) => event.id);
  return rule(
    thresholds,
    "retry-count",
    "Retry count",
    level,
    true,
    `${retries} retry event(s) recorded`,
    eventIDs,
  );
}

/** Reads the diagnostics attached to the same analysis. */
function toolFailureRecurrenceRule(
  analysis: Analysis,
  thresholds: HealthThresholds,
): HealthRuleResult {
  const threshold = thresholds.toolFailureRecurrence;
  const incidents: DiagnosticIncident[] = analysis.diagnostics?.incidents ?? [];
  let maxAttempts = 0;
  for (const incident of incidents) {
    if (incident.attempts > maxAttempts) maxAttempts = incident.attempts;
  }
  const level = levelFor(
    incidents.length >= threshold.watchIncidents ||
      maxAttempts >= threshold.watchMaxAttempts,
    incidents.length >= threshold.strongIncidents ||
      maxAttempts >= threshold.strongMaxAttempts,
  );
  const eventIDs = incidents.map((incident) => incident.firstFailureEventID);
  return rule(
    thresholds,
    "tool-failure-recurrence",
    "Tool-failure recurrence",
    level,
    true,
    `${incidents.length} incident(s) recorded; max ${maxAttempts} attempt(s) in one run`,
    eventIDs,
  );
}

/** One span of consecutive turns whose context delta is positive. */
export interface GrowthRun {
  first: Turn;
  last: Turn;
  length: number;
}

/**
 * A compaction recorded inside the run's span ends the run. A turn that owns
 * the compaction is included in the run that it terminates; a compaction
 * recorded between two turns ends the run at the preceding turn.
 */
function compactionBreaks(
  previous: Turn,
  next: Turn,
  compactions: readonly CompactionTransaction[],
): boolean {
  const previousEnd = previous.endTime ?? previous.startTime;
  const nextEnd = next.endTime ?? next.startTime;
  return compactions.some((item) => {
    if (item.turnID === previous.id || item.turnID === next.id) return true;
    return item.timestamp > previousEnd && item.timestamp <= nextEnd;
  });
}

/**
 * Longest run of consecutive turns whose context delta is positive.
 *
 * Exported so the guardrail context-run budget shares the exact health
 * vocabulary (compaction breaks included) instead of reimplementing it.
 */
export function longestGrowthRun(analysis: Analysis): GrowthRun | null {
  const runs: Turn[][] = [];
  let current: Turn[] = [];
  const flush = (): void => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  for (const turn of analysis.turns) {
    const delta = turn.contextDelta.value;
    if (delta === null || delta <= 0) {
      flush();
      continue;
    }
    if (current.length > 0) {
      const previous = current[current.length - 1]!;
      if (compactionBreaks(previous, turn, analysis.compactions)) flush();
    }
    current.push(turn);
    if (analysis.compactions.some((item) => item.turnID === turn.id)) flush();
  }
  flush();
  let best: Turn[] | null = null;
  for (const run of runs) {
    if (best === null || run.length > best.length) best = run;
  }
  if (best === null) return null;
  return { first: best[0]!, last: best[best.length - 1]!, length: best.length };
}

function contextGrowthRule(
  analysis: Analysis,
  thresholds: HealthThresholds,
): HealthRuleResult {
  const threshold = thresholds.contextGrowth;
  const available = analysis.turns.filter(
    (turn) => turn.contextDelta.value !== null,
  ).length;
  if (available < 2) {
    return rule(
      thresholds,
      "context-growth",
      "Context growth",
      null,
      false,
      `${available} turn(s) recorded a context delta; at least 2 are required`,
    );
  }
  const finalContext = analysis.totals.finalContext.value;
  if (finalContext === null) {
    return rule(
      thresholds,
      "context-growth",
      "Context growth",
      null,
      false,
      "final context size was not recorded",
    );
  }
  const run = longestGrowthRun(analysis);
  const length = run?.length ?? 0;
  const level = levelFor(
    length >= threshold.watchRun && finalContext >= threshold.watchFinalContext,
    length >= threshold.strongRun &&
      finalContext >= threshold.strongFinalContext,
  );
  const turnIDs = run ? [run.first.id, run.last.id] : [];
  return rule(
    thresholds,
    "context-growth",
    "Context growth",
    level,
    true,
    `longest growth run ${length} turn(s); final context ${finalContext}`,
    [],
    turnIDs,
  );
}

/** Highest-cost turns, descending, ties resolved by recorded order. */
function costliestTurns(
  turns: readonly Turn[],
  limit: number,
): string[] {
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

function costPerTurnRule(
  analysis: Analysis,
  thresholds: HealthThresholds,
): HealthRuleResult {
  const threshold = thresholds.costPerTurn;
  const cost: Metric = analysis.totals.cost;
  const turns = analysis.totals.turns;
  if (cost.value === null) {
    return rule(
      thresholds,
      "cost-per-turn",
      "Cost per turn",
      null,
      false,
      "cost was not recorded",
    );
  }
  if (turns < 2) {
    return rule(
      thresholds,
      "cost-per-turn",
      "Cost per turn",
      null,
      false,
      `${turns} turn(s) recorded; at least 2 are required`,
    );
  }
  const perTurn = cost.value / turns;
  const level = levelFor(
    perTurn >= threshold.watch,
    perTurn >= threshold.strong,
  );
  return rule(
    thresholds,
    "cost-per-turn",
    "Cost per turn",
    level,
    true,
    `$${perTurn.toFixed(2)} per turn across ${turns} turn(s)`,
    [],
    costliestTurns(analysis.turns, 3),
  );
}

function lowCacheHitRule(
  analysis: Analysis,
  thresholds: HealthThresholds,
): HealthRuleResult {
  const threshold = thresholds.lowCacheHit;
  const available = analysis.turns.filter(
    (turn) => turn.cacheHitRate.value !== null,
  );
  if (available.length === 0) {
    return rule(
      thresholds,
      "low-cache-hit",
      "Low cache hit rate",
      null,
      false,
      "no turn recorded a cache hit rate",
    );
  }
  const low = available.filter(
    (turn) => (turn.cacheHitRate.value ?? 0) < threshold.lowBelow,
  );
  const share = low.length / available.length;
  const level = levelFor(
    low.length >= threshold.watchLowTurns && share >= threshold.watchShare,
    low.length >= threshold.strongLowTurns && share >= threshold.strongShare,
  );
  return rule(
    thresholds,
    "low-cache-hit",
    "Low cache hit rate",
    level,
    true,
    `${low.length} of ${available.length} turn(s) below a ${threshold.lowBelow.toFixed(2)} cache hit rate`,
    [],
    low.map((turn) => turn.id),
  );
}

/**
 * `running` is explicitly not a trigger: an in-flight session is not
 * unhealthy. Only a recorded interrupt, failure or incomplete tail counts.
 */
function unfinishedOutcomeRule(
  analysis: Analysis,
  thresholds: HealthThresholds,
): HealthRuleResult {
  const last = analysis.turns[analysis.turns.length - 1] ?? null;
  const outcome = analysis.session.outcome ?? null;
  const lastStatus = last?.status ?? null;
  const level = levelFor(
    outcome === "interrupted" ||
      lastStatus === "interrupted" ||
      lastStatus === "incomplete",
    outcome === "failed" || lastStatus === "error",
  );
  const anchor = last
    ? (last.trigger.eventID ?? last.eventIDs[0] ?? null)
    : null;
  const idleFailures = analysis.events
    .filter(
      (event) =>
        event.kind === "idle" &&
        (event.status === "failed" || event.status === "interrupted"),
    )
    .map((event) => event.id);
  const eventIDs = anchor === null ? idleFailures : [anchor, ...idleFailures];
  return rule(
    thresholds,
    "unfinished-outcome",
    "Unfinished outcome",
    level,
    true,
    `session outcome: ${outcome ?? "not recorded"}; last turn status: ${lastStatus ?? "no turns"}`,
    eventIDs,
  );
}

/** The sufficiency gate: none of these may claim a healthy session. */
function insufficiencyReasons(analysis: Analysis): string[] {
  const reasons: string[] = [];
  if (analysis.totals.turns === 0) reasons.push("no turns were recorded");
  if (!analysis.coverage.complete) {
    reasons.push("the analysis covers a window, not the full session");
  }
  if (!analysis.capabilities.tokenUsage && !analysis.capabilities.cost) {
    reasons.push("neither token usage nor cost was recorded");
  }
  return reasons;
}

/**
 * Primary entry point. Pure, deterministic and local.
 *
 * State mapping (one documented rule): insufficiency forces `watch` (never
 * `healthy`); otherwise any strong trigger or at least two watch triggers is
 * `degraded`; exactly one watch trigger is `watch`; nothing is `healthy`.
 * Recorded evidence may escalate an insufficient session to `degraded` — only
 * the `healthy` claim is blocked.
 */
export function evaluateSessionHealth(
  analysis: Analysis,
  thresholds: HealthThresholds = HEALTH_RULES,
): SessionHealth {
  const rules: HealthRuleResult[] = [
    errorRateRule(analysis, thresholds),
    retryCountRule(analysis, thresholds),
    toolFailureRecurrenceRule(analysis, thresholds),
    contextGrowthRule(analysis, thresholds),
    costPerTurnRule(analysis, thresholds),
    lowCacheHitRule(analysis, thresholds),
    unfinishedOutcomeRule(analysis, thresholds),
  ];
  let watch = 0;
  let strong = 0;
  for (const item of rules) {
    if (item.level === "strong") strong += 1;
    else if (item.level === "watch") watch += 1;
  }
  const insufficientReasons = insufficiencyReasons(analysis);
  const insufficient = insufficientReasons.length > 0;
  const state: HealthState =
    strong > 0 || watch >= 2
      ? "degraded"
      : insufficient || watch === 1
        ? "watch"
        : "healthy";
  return {
    state,
    insufficient,
    insufficientReasons,
    rules,
    triggeredCount: watch + strong,
  };
}
