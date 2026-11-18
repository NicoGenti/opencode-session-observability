/**
 * Cross-session benchmark: deterministic rollups over a bounded, recency-sorted
 * candidate set.
 *
 * The layer is pure and server-agnostic: it never reads events, storage, HTTP
 * or the DOM, never reads the clock and never re-reads the source. Callers hand
 * it one already-projected row per session (`benchmarkInputFrom`) and it only
 * aggregates.
 *
 * This module deliberately does **not** extend `episodeCompare`. That module's
 * neutrality contract governs an ordinal, one-to-one alignment of two
 * diagnostic episodes; a benchmark instead folds many independent sessions into
 * descriptive group rollups. The shared discipline is that nothing is ranked:
 * groups are ordered by their recorded key, patterns by kind and key, no field
 * names a winner or an optimum, and every judgement-free average carries the
 * `derived` basis of its inputs.
 *
 * Aggregation rules, all basis-propagated:
 *
 * - Sums (tokens, cost, turns, steps, retries, errors, tool-failure incidents,
 *   compactions) cover every compared session.
 * - Averages (cost per session, duration per session, cache hit rate) are
 *   `derived` and skip a session whose value was not recorded.
 * - Windowed sessions (`coverage.complete === false`) are counted in
 *   `windowedCount` and in every sum, but excluded from every average: a
 *   partial window cannot claim a comparable per-session rate.
 *
 * Notes are deterministic phrases plus counts, mirroring `HealthRuleResult.note`
 * and `Diagnostics.why`: no prompt, file path, patch text or shell command line
 * enters this DTO. The DTO carries session ids, model/provider/agent/outcome/
 * task-type group keys, health-rule ids and tool names only — no directory is
 * carried.
 */

import { sumTokens } from "./metrics.ts";
import { metric } from "./types.ts";
import type {
  Analysis,
  Metric,
  ModelRef,
  SessionSummary,
  TokenUsage,
} from "./types.ts";

/** Hard cap on the compared sessions; the rest of the candidates are not read. */
export const MAX_BENCHMARK_SESSIONS = 50;

/**
 * How many of the newest sessions the service lists as candidates. Older
 * sessions are never listed, so they can never enter a comparison.
 */
export const CANDIDATE_LISTING_LIMIT = 1000;

/** Minimum number of sessions a recurring-pattern group-by must span. */
export const PATTERN_MIN_SESSIONS = 3;

/** Longest list of failing tool names kept per session (the first is its top). */
export const MAX_FAILING_TOOLS = 5;

/** The dimension a comparison is grouped by. `none` yields only `overall`. */
export const BENCHMARK_GROUP_BYS = Object.freeze([
  "none",
  "model",
  "provider",
  "agent",
  "outcome",
  "taskType",
] as const);

export type BenchmarkGroupBy = (typeof BENCHMARK_GROUP_BYS)[number];

/** The closed set of recorded session outcomes a filter accepts. */
export const BENCHMARK_OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "interrupted",
] as const);

/**
 * The task dimension is the turn trigger kind. Only a recorded user prompt and a
 * recorded delegated prompt name a task; `synthetic`, `retry`, `resume` and
 * `orphan` triggers do not.
 */
export const BENCHMARK_TASK_TYPES = Object.freeze(["user", "delegation"] as const);

export type BenchmarkTaskType = (typeof BENCHMARK_TASK_TYPES)[number];

/** Group key for a session that did not record the dimension's value. */
export const NOT_RECORDED = "not recorded";

export function isBenchmarkGroupBy(value: unknown): value is BenchmarkGroupBy {
  return (
    typeof value === "string" &&
    (BENCHMARK_GROUP_BYS as readonly string[]).includes(value)
  );
}

export function isBenchmarkTaskType(value: unknown): value is BenchmarkTaskType {
  return (
    typeof value === "string" &&
    (BENCHMARK_TASK_TYPES as readonly string[]).includes(value)
  );
}

export function isBenchmarkOutcome(
  value: unknown,
): value is (typeof BENCHMARK_OUTCOMES)[number] {
  return (
    typeof value === "string" &&
    (BENCHMARK_OUTCOMES as readonly string[]).includes(value)
  );
}

/** The totals-level subset one compared session contributes. */
export interface BenchmarkSessionTotals {
  turns: number;
  steps: number;
  tokens: TokenUsage;
  /** Sum of step and compaction costs; `null` when none was recorded. */
  cost: number | null;
  /** First-to-last recorded event span in ms; `null` when unavailable. */
  duration: number | null;
  /** Token-weighted cache hit rate in [0, 1]; `null` when unavailable. */
  cacheHitRate: number | null;
  retries: number;
  errors: number;
  /** Diagnostic tool-failure incidents (one per repeated-failure run). */
  toolFailures: number;
  compactions: number;
}

/**
 * One session's benchmark row. Built from the session *summary* (so redaction
 * matches what the filter read) plus the same projection every other view uses.
 */
export interface BenchmarkSessionInput {
  sessionID: string;
  directory: string | null;
  /** Model id only; `provider` carries `ModelRef.providerID`. */
  model: string | null;
  provider: string | null;
  agent: string | null;
  outcome: "succeeded" | "failed" | "interrupted" | null;
  timeCreated: number;
  timeUpdated: number | null;
  totals: BenchmarkSessionTotals;
  /** Ids of the triggered health rules, in rule-declaration order. */
  triggeredRuleIDs: string[];
  /** Failing tool names by incident count, descending; the first is the top. */
  failingTools: string[];
  /** `coverage.complete === false`: counted in sums, excluded from averages. */
  windowed: boolean;
  /** Recorded turn trigger kinds, in `BENCHMARK_TASK_TYPES` order. */
  taskTypes: BenchmarkTaskType[];
}

export interface BenchmarkCompletions {
  succeeded: number;
  failed: number;
  interrupted: number;
  /** Sessions with no recorded outcome (in progress or never settled). */
  unrecorded: number;
}

export interface BenchmarkRollups {
  /** Sessions folded into this rollup, windowed ones included. */
  sessions: number;
  turns: number;
  steps: number;
  tokens: TokenUsage;
  /** `input + output + reasoning + cacheRead + cacheWrite`, summed. */
  tokensTotal: number;
  costSum: Metric;
  costPerSession: Metric;
  durationPerSession: Metric;
  cacheHitRate: Metric;
  retries: number;
  errors: number;
  toolFailures: number;
  compactions: number;
  completions: BenchmarkCompletions;
  /** Windowed sessions here: counted in sums, excluded from averages. */
  windowedCount: number;
  /** Non-windowed sessions, i.e. the denominator the averages draw from. */
  averagedSessions: number;
}

export interface BenchmarkGroup {
  /** Recorded value the group was built on; never prettified. */
  key: string;
  /** Display label; the recorded key verbatim (the UI names the dimension). */
  label: string;
  count: number;
  rollups: BenchmarkRollups;
}

export type BenchmarkPatternKind = "health-rule" | "failing-tool";

/** A deterministic group-by, never a correlation or a similarity score. */
export interface BenchmarkPattern {
  kind: BenchmarkPatternKind;
  /** Health rule id, or the failing tool name. */
  key: string;
  sessionCount: number;
  /** Sessions in comparison order (recency descending). */
  sessionIDs: string[];
}

export interface Benchmark {
  groupBy: BenchmarkGroupBy;
  groups: BenchmarkGroup[];
  overall: { count: number; rollups: BenchmarkRollups };
  recurringPatterns: BenchmarkPattern[];
  /** True when candidates exceeded `MAX_BENCHMARK_SESSIONS`. */
  sessionsCapped: boolean;
  /** Sessions that passed the summary-level filters, before the cap. */
  candidatesConsidered: number;
  basisNotes: string[];
}

export interface BenchmarkOptions {
  groupBy?: string;
  sessionsCapped?: boolean;
  /** Sessions that matched the summary filters, before the cap. */
  candidatesConsidered?: number;
  /** Candidates that went into `loadDataset` (the capped set). */
  candidatesLoaded?: number;
  /** Sessions that vanished between listing and loading. */
  skippedSessions?: number;
}

/**
 * The filters a benchmark accepts. Every field is optional and an empty filter
 * object matches every session; the route layer is what requires at least one
 * criterion, so the core stays reusable and side-effect free.
 */
export interface BenchmarkFilters {
  /** Inclusive lower bound on the recency anchor (epoch ms). */
  from?: number;
  /** Inclusive upper bound on the recency anchor (epoch ms). */
  to?: number;
  /** Recorded model id; case-insensitive exact match. */
  model?: string;
  /** Recorded provider id; case-insensitive exact match. */
  provider?: string;
  /** Recorded session agent; case-insensitive exact match. */
  agent?: string;
  /** Recorded project directory; case-insensitive substring match. */
  directory?: string;
  /** One of `BENCHMARK_OUTCOMES`; case-insensitive exact match. */
  outcome?: string;
  /** One of `BENCHMARK_TASK_TYPES`: sessions with at least one such turn. */
  taskType?: string;
  groupBy?: string;
}

/** The summary fields the filters read. Kept structural for easy testing. */
export interface BenchmarkSessionFacts {
  directory?: string | null;
  model?: ModelRef | null;
  agent?: string | null;
  outcome?: string | null;
  timeCreated: number;
  timeUpdated?: number | null;
}

function text(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function equalsIgnoringCase(value: string | null | undefined, needle: string): boolean {
  return typeof value === "string" && value.toLowerCase() === needle.toLowerCase();
}

function includesIgnoringCase(
  value: string | null | undefined,
  needle: string,
): boolean {
  return typeof value === "string" && value.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Summary-level filters: date range, model, provider, agent, directory and
 * outcome. The task-type filter is applied after projection, because turn
 * triggers are not part of a session summary.
 *
 * `from`/`to` bound the recency anchor (`timeUpdated`, falling back to
 * `timeCreated`) — the same field the comparison is sorted by.
 */
export function matchesBenchmarkFilters(
  session: BenchmarkSessionFacts,
  filters: BenchmarkFilters,
): boolean {
  const anchor = session.timeUpdated ?? session.timeCreated;
  if (filters.from !== undefined && anchor < filters.from) return false;
  if (filters.to !== undefined && anchor > filters.to) return false;
  const model = text(filters.model);
  if (model !== undefined && !equalsIgnoringCase(session.model?.id, model)) {
    return false;
  }
  const provider = text(filters.provider);
  if (
    provider !== undefined &&
    !equalsIgnoringCase(session.model?.providerID, provider)
  ) {
    return false;
  }
  const agent = text(filters.agent);
  if (agent !== undefined && !equalsIgnoringCase(session.agent, agent)) {
    return false;
  }
  const directory = text(filters.directory);
  if (directory !== undefined && !includesIgnoringCase(session.directory, directory)) {
    return false;
  }
  const outcome = text(filters.outcome);
  if (outcome !== undefined && !equalsIgnoringCase(session.outcome, outcome)) {
    return false;
  }
  return true;
}

/**
 * True when a projected session recorded at least one turn of `taskType`.
 * An unknown value matches nothing (the route rejects it before this runs).
 */
export function matchesBenchmarkTaskType(
  input: BenchmarkSessionInput,
  taskType: string | undefined,
): boolean {
  const wanted = text(taskType);
  if (wanted === undefined) return true;
  return input.taskTypes.includes(wanted as BenchmarkTaskType);
}

/** True when at least one criterion is set (`groupBy` is not a criterion). */
export function hasBenchmarkCriteria(filters: BenchmarkFilters): boolean {
  return (
    filters.from !== undefined ||
    filters.to !== undefined ||
    text(filters.model) !== undefined ||
    text(filters.provider) !== undefined ||
    text(filters.agent) !== undefined ||
    text(filters.directory) !== undefined ||
    text(filters.outcome) !== undefined ||
    text(filters.taskType) !== undefined
  );
}

function countOf(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

/**
 * Failing tool names by incident count, descending, ties by name. A tool call
 * counts once per recorded `error` status; the DTO carries names only.
 */
export function failingToolsOf(analysis: Analysis): string[] {
  const counts = new Map<string, number>();
  for (const turn of analysis.turns) {
    for (const step of turn.steps) {
      for (const call of step.toolCalls) {
        if (call.status !== "error") continue;
        if (typeof call.name !== "string" || call.name.length === 0) continue;
        counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((left, right) =>
      right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
    )
    .slice(0, MAX_FAILING_TOOLS)
    .map(([name]) => name);
}

/** Recorded task trigger kinds, in `BENCHMARK_TASK_TYPES` order. */
export function taskTypesOf(analysis: Analysis): BenchmarkTaskType[] {
  const present = new Set<BenchmarkTaskType>();
  for (const turn of analysis.turns) {
    const kind = turn.trigger.kind;
    if (kind === "user" || kind === "delegation") present.add(kind);
  }
  return BENCHMARK_TASK_TYPES.filter((kind) => present.has(kind));
}

/** One benchmark row from the session summary plus its projection. */
export function benchmarkInputFrom(
  summary: SessionSummary,
  analysis: Analysis,
): BenchmarkSessionInput {
  const totals = analysis.totals;
  return {
    sessionID: summary.id,
    directory: summary.directory ?? null,
    model: summary.model?.id ?? null,
    provider: summary.model?.providerID ?? null,
    agent: summary.agent ?? null,
    outcome: summary.outcome ?? null,
    timeCreated: summary.timeCreated,
    timeUpdated: summary.timeUpdated ?? null,
    totals: {
      turns: countOf(totals.turns),
      steps: countOf(totals.steps),
      tokens: totals.tokens,
      cost: totals.cost.value,
      duration: totals.wallClockTime.value,
      cacheHitRate: totals.cacheHitRate.value,
      retries: countOf(totals.retries),
      errors: countOf(totals.errors.total),
      toolFailures: analysis.diagnostics?.incidents.length ?? 0,
      compactions: countOf(totals.compactions),
    },
    triggeredRuleIDs: (analysis.health?.rules ?? [])
      .filter((rule) => rule.triggered)
      .map((rule) => rule.id),
    failingTools: failingToolsOf(analysis),
    windowed: analysis.coverage.complete === false,
    taskTypes: taskTypesOf(analysis),
  };
}

function presentNumbers(values: readonly (number | null)[]): number[] {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

/** Sum of the recorded values, `derived`, with the missing count in the note. */
function sumMetric(values: readonly (number | null)[], what: string): Metric {
  if (values.length === 0) {
    return metric(null, "unavailable", "no sessions were compared");
  }
  const present = presentNumbers(values);
  if (present.length === 0) {
    return metric(null, "unavailable", `no session recorded ${what}`);
  }
  const missing = values.length - present.length;
  return metric(
    present.reduce((sum, value) => sum + value, 0),
    "derived",
    missing === 0
      ? `sum across ${values.length} session(s)`
      : `${missing} of ${values.length} session(s) did not record ${what}`,
  );
}

/**
 * Arithmetic mean of the recorded values, `derived`. Callers pass only the
 * comparable (non-windowed) sessions; `comparable` is the denominator the note
 * reports so an excluded session stays visible.
 */
function averageMetric(
  values: readonly (number | null)[],
  comparable: number,
  what: string,
): Metric {
  const present = presentNumbers(values);
  if (present.length === 0) {
    return comparable === 0
      ? metric(null, "unavailable", "no session was comparable")
      : metric(null, "unavailable", `no comparable session recorded ${what}`);
  }
  const total = present.reduce((sum, value) => sum + value, 0);
  return metric(
    total / present.length,
    "derived",
    `${present.length} of ${comparable} comparable session(s) recorded ${what}`,
  );
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function tokenTotal(tokens: TokenUsage): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cacheRead +
    tokens.cacheWrite
  );
}

function completionsFor(
  inputs: readonly BenchmarkSessionInput[],
): BenchmarkCompletions {
  const counts: BenchmarkCompletions = {
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    unrecorded: 0,
  };
  for (const input of inputs) {
    if (input.outcome === "succeeded") counts.succeeded += 1;
    else if (input.outcome === "failed") counts.failed += 1;
    else if (input.outcome === "interrupted") counts.interrupted += 1;
    else counts.unrecorded += 1;
  }
  return counts;
}

export function rollupsFor(
  inputs: readonly BenchmarkSessionInput[],
): BenchmarkRollups {
  const comparable = inputs.filter((input) => !input.windowed);
  const windowedCount = inputs.length - comparable.length;
  const tokens =
    inputs.length === 0
      ? emptyTokens()
      : sumTokens(inputs.map((input) => input.totals.tokens)).tokens;
  return {
    sessions: inputs.length,
    turns: inputs.reduce((sum, input) => sum + input.totals.turns, 0),
    steps: inputs.reduce((sum, input) => sum + input.totals.steps, 0),
    tokens,
    tokensTotal: tokenTotal(tokens),
    costSum: sumMetric(
      inputs.map((input) => input.totals.cost),
      "a cost value",
    ),
    costPerSession: averageMetric(
      comparable.map((input) => input.totals.cost),
      comparable.length,
      "a cost value",
    ),
    durationPerSession: averageMetric(
      comparable.map((input) => input.totals.duration),
      comparable.length,
      "a duration",
    ),
    cacheHitRate: averageMetric(
      comparable.map((input) => input.totals.cacheHitRate),
      comparable.length,
      "a cache hit rate",
    ),
    retries: inputs.reduce((sum, input) => sum + input.totals.retries, 0),
    errors: inputs.reduce((sum, input) => sum + input.totals.errors, 0),
    toolFailures: inputs.reduce((sum, input) => sum + input.totals.toolFailures, 0),
    compactions: inputs.reduce((sum, input) => sum + input.totals.compactions, 0),
    completions: completionsFor(inputs),
    windowedCount,
    averagedSessions: comparable.length,
  };
}

/** The recorded value a group is built on; missing values share one group. */
export function benchmarkGroupKey(
  groupBy: BenchmarkGroupBy,
  input: BenchmarkSessionInput,
): string {
  if (groupBy === "model") {
    if (input.model === null) return NOT_RECORDED;
    return input.provider === null ? input.model : `${input.provider}/${input.model}`;
  }
  if (groupBy === "provider") return input.provider ?? NOT_RECORDED;
  if (groupBy === "agent") return input.agent ?? NOT_RECORDED;
  if (groupBy === "outcome") return input.outcome ?? NOT_RECORDED;
  if (groupBy === "taskType") {
    return input.taskTypes.length === 0
      ? NOT_RECORDED
      : input.taskTypes.join("+");
  }
  return NOT_RECORDED;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Groups ordered by recorded key: declaration order is never importance. */
function groupsFor(
  inputs: readonly BenchmarkSessionInput[],
  groupBy: BenchmarkGroupBy,
): BenchmarkGroup[] {
  const buckets = new Map<string, BenchmarkSessionInput[]>();
  for (const input of inputs) {
    const key = benchmarkGroupKey(groupBy, input);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(input);
    else buckets.set(key, [input]);
  }
  return [...buckets.entries()]
    .sort((left, right) => compareKeys(left[0], right[0]))
    .map(([key, members]) => ({
      key,
      label: key,
      count: members.length,
      rollups: rollupsFor(members),
    }));
}

/**
 * Recurring patterns: the same triggered health rule id, or the same top failing
 * tool, recorded in at least `PATTERN_MIN_SESSIONS` sessions. Deterministic
 * group-bys only — no correlation, no similarity, no co-occurrence scoring.
 */
export function patternsFor(
  inputs: readonly BenchmarkSessionInput[],
): BenchmarkPattern[] {
  const rules = new Map<string, string[]>();
  const tools = new Map<string, string[]>();
  const push = (bucket: Map<string, string[]>, key: string, sessionID: string): void => {
    const ids = bucket.get(key);
    if (ids) ids.push(sessionID);
    else bucket.set(key, [sessionID]);
  };
  for (const input of inputs) {
    for (const ruleID of input.triggeredRuleIDs) {
      if (typeof ruleID === "string" && ruleID.length > 0) {
        push(rules, ruleID, input.sessionID);
      }
    }
    const top = input.failingTools[0];
    if (typeof top === "string" && top.length > 0) push(tools, top, input.sessionID);
  }
  const out: BenchmarkPattern[] = [];
  for (const [key, sessionIDs] of [...rules.entries()].sort((left, right) =>
    compareKeys(left[0], right[0]),
  )) {
    if (sessionIDs.length < PATTERN_MIN_SESSIONS) continue;
    out.push({
      kind: "health-rule",
      key,
      sessionCount: sessionIDs.length,
      sessionIDs,
    });
  }
  for (const [key, sessionIDs] of [...tools.entries()].sort((left, right) =>
    compareKeys(left[0], right[0]),
  )) {
    if (sessionIDs.length < PATTERN_MIN_SESSIONS) continue;
    out.push({
      kind: "failing-tool",
      key,
      sessionCount: sessionIDs.length,
      sessionIDs,
    });
  }
  return out;
}

/** "1 session" / "2 sessions" — a count with the grammar of its noun. */
function counted(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Provenance notes. Note 1 names three different counts, because they are three
 * different sets: what was compared, what was loaded, and what matched the
 * summary filters. Loading stops at the cap, so the matched set can be larger
 * than the loaded one; the task-type filter runs after loading, so the compared
 * set can be smaller than the loaded one.
 */
function basisNotesFor(
  inputs: readonly BenchmarkSessionInput[],
  options: BenchmarkOptions,
): string[] {
  const compared = inputs.length;
  const matched = options.candidatesConsidered ?? compared;
  const loaded = options.candidatesLoaded ?? compared;
  const skipped = options.skippedSessions ?? 0;
  const capped = options.sessionsCapped === true || matched > loaded;
  const windowedCount = inputs.filter((input) => input.windowed).length;
  const notes: string[] = [];
  notes.push(
    `Compared ${compared} of ${counted(loaded, "loaded candidate")} (${counted(
      matched,
      "session",
    )} matched the summary filters${
      capped ? "; older candidates were not loaded" : ""
    }).`,
  );
  const droppedByTaskType = Math.max(0, loaded - compared - skipped);
  if (droppedByTaskType > 0) {
    notes.push(
      `${counted(
        droppedByTaskType,
        "loaded candidate",
      )} recorded none of the requested task types and ${
        droppedByTaskType === 1 ? "was" : "were"
      } not compared.`,
    );
  }
  notes.push(
    `Windowed sessions (coverage.complete = false) are counted in sums and completion counts and excluded from averages; ${windowedCount} of ${inputs.length} compared session(s) are windowed.`,
  );
  notes.push(
    "Averages are derived: cost per session, duration per session and cache hit rate skip a session whose value was not recorded.",
  );
  notes.push(
    `Recurring patterns are deterministic group-bys: a health rule or a top failing tool recorded in at least ${PATTERN_MIN_SESSIONS} sessions. Nothing is ranked.`,
  );
  if (skipped > 0) {
    notes.push(
      `${skipped} candidate session(s) could not be loaded between listing and comparison and were skipped.`,
    );
  }
  notes.push(
    `Candidates are the ${CANDIDATE_LISTING_LIMIT} most recently updated sessions; older sessions were never listed.`,
  );
  return notes;
}

/**
 * Primary entry point. Pure, deterministic and local; an empty input set yields
 * a valid empty-shaped benchmark instead of throwing.
 *
 * The three candidate counts are normalised so their notes stay coherent:
 * `compared` ≤ `loaded` ≤ `matched`. An omitted count falls back to the next
 * inner one, so a caller that only knows the compared set needs no options.
 */
export function computeBenchmark(
  inputs: readonly BenchmarkSessionInput[],
  options: BenchmarkOptions = {},
): Benchmark {
  const groupBy = isBenchmarkGroupBy(options.groupBy) ? options.groupBy : "none";
  const compared = inputs.length;
  const matched = Math.max(compared, options.candidatesConsidered ?? compared);
  const loaded = Math.min(
    matched,
    Math.max(compared, options.candidatesLoaded ?? compared),
  );
  const sessionsCapped = options.sessionsCapped === true || matched > loaded;
  return {
    groupBy,
    groups: groupBy === "none" ? [] : groupsFor(inputs, groupBy),
    overall: { count: compared, rollups: rollupsFor(inputs) },
    recurringPatterns: patternsFor(inputs),
    // A load that stopped below the matched set is the cap, whether or not the
    // caller repeated the flag.
    sessionsCapped,
    candidatesConsidered: matched,
    basisNotes: basisNotesFor(inputs, {
      ...options,
      candidatesConsidered: matched,
      candidatesLoaded: loaded,
      sessionsCapped,
    }),
  };
}
