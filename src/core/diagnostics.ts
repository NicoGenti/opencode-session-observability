/**
 * Deterministic, purely local diagnostics over normalized OpenCode events.
 *
 * The engine detects maximal runs of consecutive failures for a single tool
 * within one turn and labels the run's recovery state. Recorded order is
 * authoritative: it never re-sorts events and never reconstructs a turn from
 * prose.
 *
 * Payload privacy: recorded inputs are UNTRUSTED DATA. They are only used to
 * derive comparability flags and a key-shape verdict. Incidents never embed
 * raw inputs, output text or file contents.
 *
 * Basis: a verdict basis is `measured` only when its blocker was directly
 * observed in the recorded log; otherwise it is `derived`.
 */

import type {
  Analysis,
  Basis,
  NormalizedEvent,
  ToolCallDetail,
  Turn,
} from "./types.ts";

export type RecoveryState =
  | "recovered"
  | "possible-recovery"
  | "no-recovery-evidence"
  | "insufficient-data";

export type SimilarityVerdict = "identical" | "related" | "different" | "unknown";

/** Whether a recorded input could be compared at all. */
export type InputComparability =
  | "comparable"
  | "absent"
  | "truncated"
  | "redacted";

export interface DiagnosticIncident {
  /** The failing tool name. */
  tool: string;
  /** 1-based turn index from `Analysis.turns`. */
  turn: number;
  /** Stable turn identifier from `Analysis.turns`. */
  turnID: string;
  /** Number of failures in the maximal run. */
  attempts: number;
  /** Event ids of the failing calls, in recorded order. Names the run's events. */
  failureEventIDs: string[];
  /**
   * Event id of the same-tool success that actually closed the run as
   * recovered. Null in every other recovery state, including a different-shape
   * same-tool success and a recovery signalled by another tool.
   */
  recoveryEventID: string | null;
  recovery: RecoveryState;
  /**
   * Basis of the recovery verdict: `measured` only when the blocker was
   * directly observed in the recorded log; otherwise `derived`.
   */
  basis: Basis;
  /** Failures are recorded, so the attempt count itself is measured. */
  failureBasis: "measured";
  /** Short deterministic explanation of the rule that was applied. */
  why: string;
  /** True only when a same-tool success was actually compared against. */
  inputsCompared: boolean;
  /** True when every relevant input was free of absence/truncation/redaction. */
  inputsComparable: boolean;
  similarity: SimilarityVerdict;
  /**
   * Key names only (no values) of the first failure's input. Null when that
   * input was not comparable, or when it exposed no object/array keys (a
   * scalar or empty comparable input). Never describes later failures.
   */
  inputKeyShape: string[] | null;
}

export interface DiagnosticsSummary {
  incidents: number;
  recovered: number;
  possibleRecovery: number;
  noRecoveryEvidence: number;
  insufficientData: number;
  turnsWithIncidents: number;
  excludedTurnlessToolEvents: number;
}

export interface Diagnostics {
  incidents: DiagnosticIncident[];
  summary: DiagnosticsSummary;
}

export const REPEATED_TOOL_FAILURE_RULE_ID = "repeated-tool-failure";

export const REPEATED_TOOL_FAILURE_RULE_DESCRIPTION =
  "A maximal run of consecutive failures of one tool within a turn, with its later recovery signals. Consecutive means consecutive events of that tool: calls on other tools do not break a run, and each tool's run is independent.";

// Jaccard over distinct key paths: |intersection| / |union|; 0.50 is inclusive, so overlap >= 0.50 is "related".
// Scalars expose no key paths, so union 0 -> overlap 0 -> "different".
const SIMILARITY_THRESHOLD = 0.5;

const REDACTION_SENTINEL = /\[REDACTED(?::[^\]]*)?\]/;
const TRUNCATION_MARKER = /(?:…|\[truncated\b[^\]]*\]|<truncated\s*\/?>|\[snip\])\s*$/i;

interface OpenRun {
  tool: string;
  turn: Turn;
  failures: NormalizedEvent[];
  firstIndex: number;
  lastIndex: number;
}

interface OrderedIncident {
  incident: DiagnosticIncident;
  turnIndex: number;
  firstIndex: number;
}

interface CollectedIncidents {
  ordered: OrderedIncident[];
  excludedTurnlessToolEvents: number;
}

interface AfterRunSignals {
  success: boolean;
  successTool: string | null;
  assistantStep: boolean;
}

interface Comparison {
  verdict: Exclude<SimilarityVerdict, "unknown">;
  overlap: number;
}

function isFailure(event: NormalizedEvent): boolean {
  const tool = event.tool;
  return (
    event.kind === "tool" &&
    tool !== null &&
    (tool.status === "error" || tool.error !== null)
  );
}

function isSuccess(event: NormalizedEvent): boolean {
  const tool = event.tool;
  return (
    event.kind === "tool" &&
    tool !== null &&
    tool.error === null &&
    tool.status === "completed"
  );
}

function walkStrings(
  value: unknown,
  visit: (text: string) => void,
  seen: Set<object> = new Set<object>(),
): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) walkStrings(item, visit, seen);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) {
        walkStrings(item, visit, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * Classifies whether a recorded input can participate in a comparison.
 * Absence, truncation and redaction are terminal: the engine never guesses.
 */
export function classifyInput(input: unknown): InputComparability {
  if (input === undefined || input === null || input === "") return "absent";
  let redacted = false;
  let truncated = false;
  walkStrings(input, (text) => {
    if (redacted) return;
    if (REDACTION_SENTINEL.test(text)) {
      redacted = true;
      return;
    }
    if (TRUNCATION_MARKER.test(text)) truncated = true;
  });
  if (redacted) return "redacted";
  if (truncated) return "truncated";
  return "comparable";
}

function isObjectLike(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function sortDeep(
  value: unknown,
  seen: Set<object> = new Set<object>(),
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("cyclic input");
    seen.add(value);
    try {
      return value.map((item) => sortDeep(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) throw new TypeError("cyclic input");
    seen.add(value);
    try {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        out[key] = sortDeep(source[key], seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

function canonicalJson(value: unknown): string {
  try {
    const normalized = sortDeep(value);
    const text = JSON.stringify(normalized);
    return text === undefined ? `undefined:${String(normalized)}` : text;
  } catch {
    // Unreachable from JSON-derived sources (sqlite/api), which only hand over
    // JSON-parseable payloads; MemorySource may pass non-JSON-like in-memory
    // values that land here instead of throwing.
    return `unserializable:${String(value)}`;
  }
}

function collectKeyPaths(
  value: unknown,
  prefix: string,
  out: Set<string>,
  seen: Set<object>,
): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) collectKeyPaths(item, prefix, out, seen);
    } else {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix.length > 0 ? `${prefix}.${key}` : key;
        out.add(path);
        collectKeyPaths(item, path, out, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

/** Sorted key paths, names only — never values. */
function keyShape(value: unknown): string[] {
  const keys = new Set<string>();
  collectKeyPaths(value, "", keys, new Set<object>());
  return [...keys].sort();
}

export function compareInputs(left: unknown, right: unknown): Comparison {
  if (canonicalJson(left) === canonicalJson(right)) {
    return { verdict: "identical", overlap: 1 };
  }
  const leftKeys = new Set(keyShape(left));
  const rightKeys = new Set(keyShape(right));
  const union = new Set<string>([...leftKeys, ...rightKeys]);
  if (union.size === 0) return { verdict: "different", overlap: 0 };
  let intersection = 0;
  for (const key of leftKeys) {
    if (rightKeys.has(key)) intersection += 1;
  }
  const overlap = intersection / union.size;
  return {
    verdict: overlap >= SIMILARITY_THRESHOLD ? "related" : "different",
    overlap,
  };
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function comparabilityReason(
  state: InputComparability,
  source: "failure" | "success",
): string {
  const subject =
    source === "failure" ? "failure input" : "the matching success input";
  switch (state) {
    case "absent":
      return `${subject} is absent`;
    case "truncated":
      return `${subject} contains a truncation marker`;
    case "redacted":
      return `${subject} contains a redaction sentinel`;
    default:
      return `${subject} is comparable`;
  }
}

/**
 * Looks for post-run signals inside the same turn only.
 * Stops at the first event that belongs to a different turn.
 */
function scanAfter(
  startIndex: number,
  turnID: string,
  events: readonly NormalizedEvent[],
  turnByEventId: ReadonlyMap<string, Turn>,
): AfterRunSignals {
  const result: AfterRunSignals = {
    success: false,
    successTool: null,
    assistantStep: false,
  };
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index]!;
    const turn = turnByEventId.get(event.id);
    if (!turn || turn.id !== turnID) break;
    if (event.kind === "assistant") result.assistantStep = true;
    if (event.kind === "tool" && event.tool && isSuccess(event)) {
      result.success = true;
      if (result.successTool === null) result.successTool = event.tool.name;
    }
  }
  return result;
}

function buildIncident(
  run: OpenRun,
  success: NormalizedEvent | null,
  events: readonly NormalizedEvent[],
  turnByEventId: ReadonlyMap<string, Turn>,
): OrderedIncident {
  const failureTools: ToolCallDetail[] = [];
  for (const event of run.failures) {
    if (event.tool) failureTools.push(event.tool);
  }
  const failureStates = failureTools.map((tool) => classifyInput(tool.input));
  const successTool = success ? success.tool : null;
  const successState = successTool ? classifyInput(successTool.input) : null;

  let badFailure: InputComparability | null = null;
  for (const state of failureStates) {
    if (state !== "comparable") {
      badFailure = state;
      break;
    }
  }
  const badSuccess: InputComparability | null =
    successState !== null && successState !== "comparable" ? successState : null;
  const badState = badFailure ?? badSuccess;
  const inputsComparable = badState === null;

  let similarity: SimilarityVerdict = "unknown";
  let overlap: number | null = null;
  let inputsCompared = false;
  if (inputsComparable && successTool) {
    const comparisons = failureTools.map((tool) =>
      compareInputs(tool.input, successTool.input),
    );
    inputsCompared = true;
    const allIdentical = comparisons.every(
      (item) => item.verdict === "identical",
    );
    const anyDifferent = comparisons.some(
      (item) => item.verdict === "different",
    );
    similarity = allIdentical
      ? "identical"
      : anyDifferent
        ? "different"
        : "related";
    overlap = Math.min(...comparisons.map((item) => item.overlap));
  }

  const after = scanAfter(run.lastIndex, run.turn.id, events, turnByEventId);
  const prefix = `${run.failures.length} failure(s) on ${run.tool} in turn ${run.turn.index}`;

  let recovery: RecoveryState;
  let why: string;
  if (badState !== null) {
    recovery = "insufficient-data";
    const source = badFailure !== null ? "failure" : "success";
    why = `${prefix}; ${comparabilityReason(badState, source)}; input comparison is undetermined`;
  } else if (
    successTool &&
    (similarity === "identical" || similarity === "related")
  ) {
    recovery = "recovered";
    why =
      similarity === "identical"
        ? `${prefix}; a later ${run.tool} call succeeded with identical input (canonical JSON equality)`
        : `${prefix}; a later ${run.tool} call succeeded with related input (key-shape overlap ${formatRatio(overlap ?? 0)} >= 0.50)`;
  } else if (after.success || after.assistantStep) {
    recovery = "possible-recovery";
    why =
      successTool !== null && similarity === "different"
        ? `${prefix}; a later ${run.tool} call succeeded but with a different input shape (key-shape overlap ${formatRatio(overlap ?? 0)} < 0.50)`
        : after.success
          ? `${prefix}; no matching ${run.tool} success, but a later successful tool call${
              after.successTool ? ` (${after.successTool})` : ""
            } followed`
          : `${prefix}; no matching ${run.tool} success, but the turn continued with a subsequent assistant step`;
  } else {
    recovery = "no-recovery-evidence";
    why = `${prefix}; no same-tool success and no later successful call or subsequent step before the turn ended`;
  }

  const firstFailureInput = failureTools[0]?.input;
  const inputKeyShape =
    inputsComparable && isObjectLike(firstFailureInput)
      ? keyShape(firstFailureInput)
      : null;

  const incident: DiagnosticIncident = {
    tool: run.tool,
    turn: run.turn.index,
    turnID: run.turn.id,
    attempts: run.failures.length,
    failureEventIDs: run.failures.map((event) => event.id),
    recoveryEventID: recovery === "recovered" && success ? success.id : null,
    recovery,
    basis: recovery === "insufficient-data" ? "measured" : "derived",
    failureBasis: "measured",
    why,
    inputsCompared,
    inputsComparable,
    similarity,
    inputKeyShape,
  };
  return { incident, turnIndex: run.turn.index, firstIndex: run.firstIndex };
}

function collectIncidents(
  events: readonly NormalizedEvent[],
  analysis: Analysis,
): CollectedIncidents {
  const turnByEventId = new Map<string, Turn>();
  for (const turn of analysis.turns) {
    for (const id of turn.eventIDs) turnByEventId.set(id, turn);
  }

  const open = new Map<string, OpenRun>();
  const ordered: OrderedIncident[] = [];
  let currentTurnId: string | null = null;
  let excludedTurnlessToolEvents = 0;

  const finalizeTurn = (turnID: string): void => {
    for (const [key, run] of [...open.entries()]) {
      if (run.turn.id !== turnID) continue;
      open.delete(key);
      ordered.push(buildIncident(run, null, events, turnByEventId));
    }
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const turn = turnByEventId.get(event.id) ?? null;
    const turnId = turn ? turn.id : null;
    if (turnId !== currentTurnId) {
      if (currentTurnId !== null) finalizeTurn(currentTurnId);
      currentTurnId = turnId;
    }
    if (!turn) {
      if (event.kind === "tool" && event.tool !== null) {
        excludedTurnlessToolEvents += 1;
      }
      continue;
    }
    if (event.kind !== "tool") continue;
    const tool = event.tool;
    if (!tool) continue;
    const key = `${turn.id}\u0000${tool.name}`;
    if (isFailure(event)) {
      const run = open.get(key);
      if (run) {
        run.failures.push(event);
        run.lastIndex = index;
      } else {
        open.set(key, {
          tool: tool.name,
          turn,
          failures: [event],
          firstIndex: index,
          lastIndex: index,
        });
      }
    } else if (isSuccess(event)) {
      const run = open.get(key);
      if (run) {
        open.delete(key);
        ordered.push(buildIncident(run, event, events, turnByEventId));
      }
    }
  }

  if (currentTurnId !== null) finalizeTurn(currentTurnId);
  for (const [key, run] of [...open.entries()]) {
    open.delete(key);
    ordered.push(buildIncident(run, null, events, turnByEventId));
  }

  ordered.sort(
    (left, right) =>
      left.turnIndex - right.turnIndex || left.firstIndex - right.firstIndex,
  );
  return { ordered, excludedTurnlessToolEvents };
}

function summarize(
  incidents: readonly DiagnosticIncident[],
  excludedTurnlessToolEvents: number,
): DiagnosticsSummary {
  let recovered = 0;
  let possibleRecovery = 0;
  let noRecoveryEvidence = 0;
  let insufficientData = 0;
  const turns = new Set<number>();
  for (const incident of incidents) {
    turns.add(incident.turn);
    switch (incident.recovery) {
      case "recovered":
        recovered += 1;
        break;
      case "possible-recovery":
        possibleRecovery += 1;
        break;
      case "no-recovery-evidence":
        noRecoveryEvidence += 1;
        break;
      case "insufficient-data":
        insufficientData += 1;
        break;
    }
  }
  return {
    incidents: incidents.length,
    recovered,
    possibleRecovery,
    noRecoveryEvidence,
    insufficientData,
    turnsWithIncidents: turns.size,
    excludedTurnlessToolEvents,
  };
}

/**
 * The repeated-tool-failure rule.
 *
 * "Consecutive" means consecutive events of that tool within the turn:
 * intervening calls on other tools do not break the run, and each tool's run
 * is tracked independently. One incident is produced per maximal run; a run
 * terminates on that tool's success or at the turn boundary.
 */
export function RepeatedToolFailureRule(
  events: NormalizedEvent[],
  analysis: Analysis,
): { incidents: DiagnosticIncident[]; excludedTurnlessToolEvents: number } {
  const collected = collectIncidents(events, analysis);
  return {
    incidents: collected.ordered.map((item) => item.incident),
    excludedTurnlessToolEvents: collected.excludedTurnlessToolEvents,
  };
}

/**
 * Primary entry point. Pure, deterministic and local.
 * Returns an empty incident list (never null/undefined) when nothing failed.
 * Events must be the full recorded-order event list of `analysis.session`;
 * windowed or page-subset calls yield a non-zero `excludedTurnlessToolEvents`
 * rather than silently miscounting.
 */
export function evaluateDiagnostics(
  events: NormalizedEvent[],
  analysis: Analysis,
): Diagnostics {
  const { incidents, excludedTurnlessToolEvents } = RepeatedToolFailureRule(
    events,
    analysis,
  );
  return {
    incidents,
    summary: summarize(incidents, excludedTurnlessToolEvents),
  };
}
