/**
 * Ordinal, descriptive comparison of two recorded diagnostic episodes.
 *
 * The layer is pure and server-agnostic: it never reads events, storage, HTTP
 * or the DOM, and it never ranks the two sides. Attempts are aligned by
 * recorded position only (1<->1, 2<->2, ...); a differing attempt count yields
 * trailing one-sided rows instead of a fuzzy match. Every difference is
 * `left - right` and carries the epistemic basis of its inputs.
 *
 * DTO neutrality: no field in these comparison shapes names a winner, an
 * optimum, a recommendation, a verdict or a "better" side. The only
 * judgement-like value (`inputSimilarity`) is copied verbatim from the purely
 * descriptive diagnostics layer. A recursive key-scan test enforces the
 * absence of ranking fields in every DTO object.
 */

import { classifyInput, compareInputs } from "./diagnostics.ts";
import { metric } from "./types.ts";
import type {
  InputComparability,
  RecoveryState,
  SimilarityVerdict,
} from "./diagnostics.ts";
import type { DiagnosticEpisode } from "./episodes.ts";
import type { Metric, TokenUsage, ToolStatus } from "./types.ts";

/** Identity of one side's episode, copied from `DiagnosticEpisode`. */
export interface EpisodeDescriptor {
  id: string;
  sessionID: string;
  turnID: string;
  turnIndex: number;
  tool: string;
  attemptCount: number;
  recovery: RecoveryState;
  similarity: SimilarityVerdict;
  /** Non-null only when the episode recorded an actual same-tool recovery. */
  recoveryEventID: string | null;
}

/**
 * One recorded tool call. Attempts are supplied by the caller in recorded
 * order; the compare layer never re-reads events on its own.
 */
export interface AttemptSummary {
  /** Stable event id of the call, e.g. `"a1:0"`. */
  eventID: string;
  tool: string;
  status: ToolStatus;
  /**
   * The recorded input exactly as the caller supplied it. When the caller
   * passes redacted data (no reveal), this field carries that redacted value:
   * the comparison layer never dereferences or reconstructs payloads.
   */
  input: unknown;
  /** Recorded call duration, normally `toolDurationMetric(tool)`. */
  duration: Metric;
}

/**
 * Totals for one side's session: a numeric subset that the caller must adapt
 * from `Analysis.totals` rather than pass directly. In particular `totalTime`
 * comes from `activeTurnTime`, since a session has no single span; see
 * `totalsSubset` in the service for the mapping.
 */
export interface EpisodeTotals {
  tokens: TokenUsage;
  /** True when every analysed step contributed token usage. */
  tokensComplete: boolean;
  cost: Metric;
  modelTime: Metric;
  toolTime: Metric;
  totalTime: Metric;
  outputSpeed: Metric;
  cacheHitRate: Metric;
}

/**
 * Metrics for the turn that owns the episode, structurally a subset of
 * `Analysis.turns[i]`. Callers may pass the matching `Turn` directly.
 */
export interface TurnSummary extends EpisodeTotals {
  /** 1-based turn index from `Analysis.turns`. */
  index: number;
  /** Prompt size of the latest step in the turn. */
  promptTokensLatest: Metric;
}

/** All data one side of a comparison needs; nothing is read elsewhere. */
export interface EpisodeCompareInput {
  /** The episode recorded by the diagnostics layer. */
  episode: DiagnosticEpisode;
  /** Failure attempts in recorded order. */
  attempts: readonly AttemptSummary[];
  /**
   * The recovery call when `episode.recoveryEventID` names one; otherwise
   * null. Supplying it is the caller's responsibility: this layer never
   * searches other events for a matching call.
   */
  recovery: AttemptSummary | null;
  /** Session totals from `Analysis.totals`. */
  totals: EpisodeTotals;
  /** The turn that contains the episode, from `Analysis.turns`. */
  turn: TurnSummary;
  /** True when the caller supplied redacted inputs (`Analysis.redacted`). */
  redacted?: boolean;
}

/** Per-token-field differences of `TokenUsage`. */
export interface TokenDelta {
  input: Metric;
  output: Metric;
  reasoning: Metric;
  cacheRead: Metric;
  cacheWrite: Metric;
}

/** Descriptive `left - right` differences of the session totals. */
export interface TotalsDelta {
  tokens: TokenDelta;
  cost: Metric;
  modelTime: Metric;
  toolTime: Metric;
  totalTime: Metric;
  outputSpeed: Metric;
  cacheHitRate: Metric;
}

/** Descriptive `left - right` differences of the owning turn. */
export interface TurnDelta extends TotalsDelta {
  promptTokensLatest: Metric;
}

export type AlignmentPresence = "both" | "left-only" | "right-only";
export type AttemptRowKind = "attempt" | "recovery";

/** Comparability of each side of one aligned row. */
export interface InputComparabilityPair {
  left: InputComparability;
  right: InputComparability;
}

/**
 * One alignment row. `index` is 1-based across the whole alignment array,
 * including the trailing recovery row.
 */
export interface AlignedAttempt {
  index: number;
  kind: AttemptRowKind;
  presence: AlignmentPresence;
  left: AttemptSummary | null;
  right: AttemptSummary | null;
  /**
   * `left - right`; unavailable when either side lacks a duration or only
   * estimates one.
   */
  latencyDelta: Metric;
  inputComparability: InputComparabilityPair;
  /** `"not-comparable"` unless both inputs passed `classifyInput`. */
  inputSimilarity: SimilarityVerdict | "not-comparable";
  /** Key-shape overlap from `compareInputs`; null when not comparable. */
  inputOverlap: number | null;
}

export interface EpisodeComparisonTotals {
  left: EpisodeTotals;
  right: EpisodeTotals;
  delta: TotalsDelta;
}

export interface EpisodeComparisonTurn {
  left: TurnSummary;
  right: TurnSummary;
  delta: TurnDelta;
}

/**
 * The neutral comparison payload. It contains no ranking, recommendation or
 * preference field: every numeric difference is a descriptive magnitude.
 */
export interface EpisodeComparison {
  schemaVersion: 1;
  redacted: boolean;
  left: EpisodeDescriptor;
  right: EpisodeDescriptor;
  alignment: AlignedAttempt[];
  totals: EpisodeComparisonTotals;
  turn: EpisodeComparisonTurn;
  /** Deterministic, descriptive notes; never an evaluation. */
  notes: string[];
}

function describeEpisode(episode: DiagnosticEpisode): EpisodeDescriptor {
  return {
    id: episode.id,
    sessionID: episode.sessionID,
    turnID: episode.turnID,
    turnIndex: episode.turnIndex,
    tool: episode.tool,
    attemptCount: episode.attemptCount,
    recovery: episode.recovery,
    similarity: episode.similarity,
    recoveryEventID: episode.recoveryEventID,
  };
}

function copyAttempt(attempt: AttemptSummary): AttemptSummary {
  return {
    eventID: attempt.eventID,
    tool: attempt.tool,
    status: attempt.status,
    input: attempt.input,
    duration: { ...attempt.duration },
  };
}

function copyTotals(totals: EpisodeTotals): EpisodeTotals {
  return {
    tokens: { ...totals.tokens },
    tokensComplete: totals.tokensComplete,
    cost: { ...totals.cost },
    modelTime: { ...totals.modelTime },
    toolTime: { ...totals.toolTime },
    totalTime: { ...totals.totalTime },
    outputSpeed: { ...totals.outputSpeed },
    cacheHitRate: { ...totals.cacheHitRate },
  };
}

function copyTurn(turn: TurnSummary): TurnSummary {
  return {
    ...copyTotals(turn),
    index: turn.index,
    promptTokensLatest: { ...turn.promptTokensLatest },
  };
}

/**
 * `left - right` for two already-computed metrics. A delta is `derived` only
 * when both sides are; an estimated or unavailable component makes the delta
 * unavailable rather than presenting an inferred magnitude as measured. The
 * same policy governs the attempt duration deltas below.
 */
function differenceMetric(left: Metric, right: Metric, label: string): Metric {
  if (left.value === null || right.value === null) {
    return metric(null, "unavailable", `${label} is unavailable on one side`);
  }
  if (left.basis === "estimated" || right.basis === "estimated") {
    return metric(null, "unavailable", `${label} is estimated on one side`);
  }
  if (left.basis === "unavailable" || right.basis === "unavailable") {
    return metric(null, "unavailable", `${label} is unavailable on one side`);
  }
  return metric(left.value - right.value, "derived", `${label} left − right`);
}

/** `left - right` for one `TokenUsage` field, gated by completeness. */
function tokenDifference(
  field: keyof TokenUsage,
  label: string,
  left: EpisodeTotals,
  right: EpisodeTotals,
): Metric {
  if (!left.tokensComplete || !right.tokensComplete) {
    return metric(
      null,
      "unavailable",
      `${label} tokens are incomplete on one side`,
    );
  }
  return metric(
    left.tokens[field] - right.tokens[field],
    "derived",
    `${label} tokens left − right`,
  );
}

function latencyDelta(
  left: AttemptSummary | null,
  right: AttemptSummary | null,
): Metric {
  if (left === null) return metric(null, "unavailable", "left attempt is missing");
  if (right === null) {
    return metric(null, "unavailable", "right attempt is missing");
  }
  if (left.duration.value === null || right.duration.value === null) {
    return metric(null, "unavailable", "left − right duration is unavailable");
  }
  if (
    left.duration.basis === "estimated" ||
    right.duration.basis === "estimated"
  ) {
    return metric(
      null,
      "unavailable",
      "left − right duration is estimated on one side",
    );
  }
  return metric(
    left.duration.value - right.duration.value,
    "derived",
    "left − right",
  );
}

interface PairInputVerdict {
  comparability: InputComparabilityPair;
  similarity: SimilarityVerdict | "not-comparable";
  overlap: number | null;
}

/**
 * Compares one aligned pair of inputs. Absent, truncated and redacted inputs
 * are terminal: similarity is `"not-comparable"` and no overlap is guessed.
 */
function comparePairInputs(
  left: AttemptSummary | null,
  right: AttemptSummary | null,
): PairInputVerdict {
  const leftState = left === null ? "absent" : classifyInput(left.input);
  const rightState = right === null ? "absent" : classifyInput(right.input);
  const comparability: InputComparabilityPair = {
    left: leftState,
    right: rightState,
  };
  if (left === null || right === null) {
    return { comparability, similarity: "not-comparable", overlap: null };
  }
  if (leftState !== "comparable" || rightState !== "comparable") {
    return { comparability, similarity: "not-comparable", overlap: null };
  }
  const comparison = compareInputs(left.input, right.input);
  return {
    comparability,
    similarity: comparison.verdict,
    overlap: comparison.overlap,
  };
}

function buildRow(
  index: number,
  kind: AttemptRowKind,
  left: AttemptSummary | null,
  right: AttemptSummary | null,
  notes: string[],
): AlignedAttempt {
  const inputs = comparePairInputs(left, right);
  const label = kind === "recovery" ? "recovery call" : `attempt ${index}`;
  if (left !== null && right !== null && inputs.similarity === "not-comparable") {
    notes.push(
      `${label} inputs are not comparable (left ${inputs.comparability.left}, right ${inputs.comparability.right})`,
    );
  }
  if (left !== null && right !== null && left.tool !== right.tool) {
    notes.push(
      `${label} uses ${left.tool} on the left and ${right.tool} on the right`,
    );
  }
  const presence: AlignmentPresence =
    left !== null && right !== null
      ? "both"
      : left !== null
        ? "left-only"
        : "right-only";
  return {
    index,
    kind,
    presence,
    left: left === null ? null : copyAttempt(left),
    right: right === null ? null : copyAttempt(right),
    latencyDelta: latencyDelta(left, right),
    inputComparability: inputs.comparability,
    inputSimilarity: inputs.similarity,
    inputOverlap: inputs.overlap,
  };
}

function dataNotes(
  side: "left" | "right",
  input: EpisodeCompareInput,
  notes: string[],
): void {
  if (input.redacted === true) notes.push(`${side} inputs are redacted`);
  if (input.attempts.length !== input.episode.attemptCount) {
    notes.push(
      `${side} episode records ${input.episode.attemptCount} attempt(s) but ${input.attempts.length} attempt(s) were supplied`,
    );
  }
  if (input.episode.recoveryEventID !== null && input.recovery === null) {
    notes.push(
      `${side} episode records a recovery event without a supplied recovery attempt`,
    );
  }
  if (input.recovery !== null && input.episode.recoveryEventID === null) {
    notes.push(
      `${side} recovery attempt was supplied but the episode records no recovery event`,
    );
  }
}

function alignAttempts(
  left: EpisodeCompareInput,
  right: EpisodeCompareInput,
  notes: string[],
): AlignedAttempt[] {
  const leftAttempts = [...left.attempts];
  const rightAttempts = [...right.attempts];
  const paired = Math.min(leftAttempts.length, rightAttempts.length);
  const rows: AlignedAttempt[] = [];

  for (let position = 0; position < paired; position += 1) {
    rows.push(
      buildRow(
        rows.length + 1,
        "attempt",
        leftAttempts[position]!,
        rightAttempts[position]!,
        notes,
      ),
    );
  }
  for (let position = paired; position < leftAttempts.length; position += 1) {
    rows.push(
      buildRow(rows.length + 1, "attempt", leftAttempts[position]!, null, notes),
    );
  }
  for (let position = paired; position < rightAttempts.length; position += 1) {
    rows.push(
      buildRow(rows.length + 1, "attempt", null, rightAttempts[position]!, notes),
    );
  }

  const leftRecovery =
    left.episode.recoveryEventID !== null ? left.recovery : null;
  const rightRecovery =
    right.episode.recoveryEventID !== null ? right.recovery : null;
  if (leftRecovery !== null || rightRecovery !== null) {
    if (leftRecovery !== null && rightRecovery === null) {
      notes.push("recovery call only in left");
    } else if (rightRecovery !== null && leftRecovery === null) {
      notes.push("recovery call only in right");
    }
    rows.push(
      buildRow(
        rows.length + 1,
        "recovery",
        leftRecovery,
        rightRecovery,
        notes,
      ),
    );
  }
  return rows;
}

function totalsDelta(left: EpisodeTotals, right: EpisodeTotals): TotalsDelta {
  return {
    tokens: {
      input: tokenDifference("input", "input", left, right),
      output: tokenDifference("output", "output", left, right),
      reasoning: tokenDifference("reasoning", "reasoning", left, right),
      cacheRead: tokenDifference("cacheRead", "cache read", left, right),
      cacheWrite: tokenDifference("cacheWrite", "cache write", left, right),
    },
    cost: differenceMetric(left.cost, right.cost, "cost"),
    modelTime: differenceMetric(left.modelTime, right.modelTime, "model time"),
    toolTime: differenceMetric(left.toolTime, right.toolTime, "tool time"),
    totalTime: differenceMetric(left.totalTime, right.totalTime, "total time"),
    outputSpeed: differenceMetric(
      left.outputSpeed,
      right.outputSpeed,
      "output speed",
    ),
    cacheHitRate: differenceMetric(
      left.cacheHitRate,
      right.cacheHitRate,
      "cache hit rate",
    ),
  };
}

function turnDelta(left: TurnSummary, right: TurnSummary): TurnDelta {
  return {
    ...totalsDelta(left, right),
    promptTokensLatest: differenceMetric(
      left.promptTokensLatest,
      right.promptTokensLatest,
      "turn prompt tokens",
    ),
  };
}

/**
 * Compares two episodes by recorded ordinal.
 *
 * Pure and deterministic: repeated calls with equal inputs return deep-equal
 * results, no input is mutated, and the returned arrays are fresh. No attempt
 * is ever matched by input shape, so a count mismatch stays visible as
 * trailing one-sided rows plus a note.
 */
export function compareEpisodeData(
  leftInput: EpisodeCompareInput,
  rightInput: EpisodeCompareInput,
): EpisodeComparison {
  const notes: string[] = [];
  dataNotes("left", leftInput, notes);
  dataNotes("right", rightInput, notes);

  if (leftInput.episode.tool !== rightInput.episode.tool) {
    notes.push(
      `left episode tool is ${leftInput.episode.tool} and right episode tool is ${rightInput.episode.tool}`,
    );
  }
  const leftCount = leftInput.attempts.length;
  const rightCount = rightInput.attempts.length;
  if (leftCount > rightCount) {
    notes.push(`${leftCount - rightCount} attempt(s) only in left`);
  } else if (rightCount > leftCount) {
    notes.push(`${rightCount - leftCount} attempt(s) only in right`);
  }

  const alignment = alignAttempts(leftInput, rightInput, notes);

  return {
    schemaVersion: 1,
    redacted: leftInput.redacted === true || rightInput.redacted === true,
    left: describeEpisode(leftInput.episode),
    right: describeEpisode(rightInput.episode),
    alignment,
    totals: {
      left: copyTotals(leftInput.totals),
      right: copyTotals(rightInput.totals),
      delta: totalsDelta(leftInput.totals, rightInput.totals),
    },
    turn: {
      left: copyTurn(leftInput.turn),
      right: copyTurn(rightInput.turn),
      delta: turnDelta(leftInput.turn, rightInput.turn),
    },
    notes,
  };
}
