/**
 * Deterministic, locally derived recommendations over an already-loaded
 * `Analysis`.
 *
 * The evaluator never performs I/O, never reads the clock and never re-reads
 * the source: it is a pure function of the same analysis that diagnostics,
 * health and attribution already produced. It runs once, in `loadDataset`,
 * after attribution, so every downstream path (analysis, export, UI) reads one
 * cached object verbatim. There is no model call, no network call and no
 * second compute site.
 *
 * Two structural rules keep the DTO honest:
 *
 * - Facts and hypotheses are separated by `kind`, never by prose. A `fact` row
 *   restates a finding that already exists in the analysis (a triggered health
 *   rule, an incident aggregate, a count, an attribution aggregate). A
 *   `hypothesis` row is an if-then suggestion, and it always ships with a
 *   companion `fact` row naming the finding it rests on. A hypothesis is never
 *   a diagnosis.
 * - Nothing is ranked. There is no score, no priority, no weight and no
 *   ordering artifact: rows follow the fixed rule order below (fact before its
 *   hypothesis), which is declaration order, not importance.
 *
 * Notes are deterministic phrases plus counts, mirroring `Diagnostics.why` and
 * the health rule notes: no prompt, tool output, file content, patch text or
 * shell command line ever enters this DTO.
 */

import { MAX_EVENT_LINKS } from "./health.ts";
import type { Analysis, CompactionTransaction, Turn } from "./types.ts";

export type RecommendationKind = "fact" | "hypothesis";

/** `info` restates a fact; `advisory` marks a hypothesis. Nothing is stronger. */
export type RecommendationSeverity = "info" | "advisory";

/** The closed rule set. Adding a rule is a documented change to this union. */
export type RecommendationRuleId =
  | "reduce-context"
  | "retry-failed-tool"
  | "split-task"
  | "reuse-subagent"
  | "avoid-unnecessary-compaction"
  | "concentrated-file-cost";

export interface Recommendation {
  /** Stable identity: `<ruleID>:<kind>`; there is one row per rule and kind. */
  id: string;
  kind: RecommendationKind;
  severity: RecommendationSeverity;
  ruleID: RecommendationRuleId;
  /** Short fixed headline, sentence case. */
  label: string;
  /** Deterministic phrase plus counts; never payload text. */
  note: string;
  /** Capped event ids that exist in `Analysis.events`. */
  eventIDs: string[];
  /** Capped turn ids that exist in `Analysis.turns`. */
  turnIDs: string[];
}

export interface Recommendations {
  rows: Recommendation[];
  basisNotes: string[];
}

/** Turn evidence links kept per row; the same cap as the health rules. */
export const MAX_RECOMMENDATION_TURN_LINKS = 6;
/** Rows the fixed rule set can emit: six facts plus five paired hypotheses. */
export const MAX_RECOMMENDATION_ROWS = 16;
/** A turn with this many recorded steps is large enough to consider splitting. */
export const SPLIT_TASK_MIN_STEPS = 12;
/** Fifteen minutes of recorded turn time is the second split-task trigger. */
export const SPLIT_TASK_MIN_DURATION_MS = 900_000;
/** Repeated delegation only suggests a reusable subagent from three calls up. */
export const REUSE_SUBAGENT_MIN_CALLS = 3;
/** A compaction below this context size invites the "was it needed?" question. */
export const COMPACTION_CONTEXT_FLOOR = 20_000;
/** Share of the attributed file cost a single path must carry to be named. */
export const CONCENTRATED_FILE_SHARE = 0.5;
/** Concentration needs at least two attributed files to mean anything. */
export const CONCENTRATED_FILE_MIN_FILES = 2;

/**
 * The standing basis notes. Deterministic phrases only: they restate where the
 * rows come from and what the layer refuses to do.
 */
const BASIS_NOTES: readonly string[] = Object.freeze([
  "Recommendations are derived from this analysis: diagnostics incidents, session health rules, turns, compactions and attribution rows.",
  "Every hypothesis ships with a fact row naming the finding it rests on; a hypothesis is a suggestion, not a diagnosis.",
  "Notes are deterministic phrases plus counts: no prompt, tool output, file content, patch text or shell command line is included.",
  "Rows follow the fixed rule order, fact before its hypothesis; no numeric ordering artifact is computed.",
  "Recommendations are local and deterministic: no model and no network call is involved, and nothing here can act on a session.",
]);

/** Recovery states that prove the failure run continued without a resolution. */
const UNRECOVERED: ReadonlySet<string> = new Set(["no-recovery-evidence"]);

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

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function minutes(ms: number): string {
  return (ms / 60_000).toFixed(1);
}

function row(
  ruleID: RecommendationRuleId,
  kind: RecommendationKind,
  label: string,
  note: string,
  eventIDs: readonly string[] = [],
  turnIDs: readonly string[] = [],
): Recommendation {
  return {
    id: `${ruleID}:${kind}`,
    kind,
    severity: kind === "fact" ? "info" : "advisory",
    ruleID,
    label,
    note,
    eventIDs: capIDs(eventIDs, MAX_EVENT_LINKS),
    turnIDs: capIDs(turnIDs, MAX_RECOMMENDATION_TURN_LINKS),
  };
}

/** A fact row plus the hypothesis it supports, in that order. */
function pair(
  ruleID: RecommendationRuleId,
  factLabel: string,
  factNote: string,
  hypothesisLabel: string,
  hypothesisNote: string,
  eventIDs: readonly string[],
  turnIDs: readonly string[],
): Recommendation[] {
  return [
    row(ruleID, "fact", factLabel, factNote, eventIDs, turnIDs),
    row(
      ruleID,
      "hypothesis",
      hypothesisLabel,
      hypothesisNote,
      eventIDs,
      turnIDs,
    ),
  ];
}

/**
 * Rule 1 — reads the already-computed `context-growth` health rule. The rule is
 * the trigger; the notes are regenerated from counts so no free text is copied.
 */
function reduceContextRows(analysis: Analysis): Recommendation[] {
  const rule = asArray(analysis.health?.rules).find(
    (item) => item.id === "context-growth",
  );
  if (!rule?.triggered) return [];
  const level = rule.level ?? "watch";
  const growthTurns = asArray(analysis.turns).filter(
    (turn) => (turn.contextDelta.value ?? 0) > 0,
  ).length;
  const finalContext = analysis.totals?.finalContext?.value ?? null;
  const observed =
    finalContext === null
      ? `${growthTurns} turn(s) added context`
      : `${growthTurns} turn(s) added context; final context ${finalContext}`;
  return pair(
    "reduce-context",
    "Context growth",
    `Health rule "Context growth" is triggered (${level}): ${observed}.`,
    "Trim or summarize in-turn context",
    `Hypothesis: trimming or summarizing in-turn context before the next prompt may keep the growth run shorter across the ${growthTurns} recorded turn(s).`,
    rule.eventIDs,
    rule.turnIDs,
  );
}

/**
 * Rule 2 — unrecovered diagnostic incidents. `possible-recovery` and
 * `insufficient-data` are deliberately excluded: neither proves that the run
 * continued unresolved.
 */
function retryFailedToolRows(analysis: Analysis): Recommendation[] {
  const incidents = asArray(analysis.diagnostics?.incidents);
  const unrecovered = incidents.filter((incident) =>
    UNRECOVERED.has(incident.recovery),
  );
  if (unrecovered.length === 0) return [];
  let top = unrecovered[0]!;
  for (const incident of unrecovered) {
    if (incident.attempts > top.attempts) top = incident;
  }
  const tools = new Set(unrecovered.map((incident) => incident.tool));
  return pair(
    "retry-failed-tool",
    "Unrecovered tool failures",
    `${unrecovered.length} incident(s) across ${tools.size} tool(s) have no recovery evidence; ${top.tool} failed ${top.attempts} time(s) in one run.`,
    "Verify the tool precondition before retrying",
    `Hypothesis: retrying ${top.tool} immediately may repeat the same failure; checking its precondition or configuration first may end the run sooner.`,
    unrecovered.map((incident) => incident.firstFailureEventID),
    unrecovered.map((incident) => incident.turnID),
  );
}

/** First turn, in recorded order, that exceeds either split-task bound. */
function oversizedTurn(turns: readonly Turn[]): Turn | null {
  for (const turn of turns) {
    if (!turn) continue;
    const steps = asArray(turn.steps).length;
    if (steps >= SPLIT_TASK_MIN_STEPS) return turn;
    const elapsed = turn.totalTime?.value ?? 0;
    if (elapsed >= SPLIT_TASK_MIN_DURATION_MS) return turn;
  }
  return null;
}

/** Rule 3 — one oversized turn, by step count or recorded turn time. */
function splitTaskRows(analysis: Analysis): Recommendation[] {
  const turn = oversizedTurn(asArray(analysis.turns));
  if (turn === null) return [];
  const steps = asArray(turn.steps).length;
  const elapsed = turn.totalTime?.value ?? 0;
  return pair(
    "split-task",
    "Large turn",
    `Turn ${turn.index} recorded ${steps} step(s) and ${minutes(elapsed)} min of recorded turn time.`,
    "Split the task",
    "Hypothesis: splitting this turn into smaller prompts may keep each turn's context, step count and cost per turn lower.",
    asArray(turn.eventIDs),
    [turn.id],
  );
}

/** Rule 4 — repeated subagent calls, evidenced by the attributed subtasks. */
function reuseSubagentRows(analysis: Analysis): Recommendation[] {
  const calls = analysis.totals?.subagentCalls ?? 0;
  if (calls < REUSE_SUBAGENT_MIN_CALLS) return [];
  const turnIDs: string[] = [];
  for (const turn of asArray(analysis.attribution?.turns)) {
    if (asArray(turn.subtasks).length > 0) turnIDs.push(turn.turnID);
  }
  return pair(
    "reuse-subagent",
    "Repeated subagent calls",
    `${calls} subagent call(s) were recorded in this analysis.`,
    "Reuse a subagent for the repeated workload",
    `Hypothesis: ${calls} delegated calls may be served by one reusable subagent instead of starting a fresh delegate each time.`,
    [],
    turnIDs,
  );
}

/** Rule 5 — compactions recorded while the context was still small. */
function avoidCompactionRows(analysis: Analysis): Recommendation[] {
  const compactions = asArray<CompactionTransaction>(analysis.compactions);
  const small = compactions.filter((item) => {
    const before = item.contextBefore?.value ?? null;
    return before !== null && before < COMPACTION_CONTEXT_FLOOR;
  });
  if (small.length === 0) return [];
  return pair(
    "avoid-unnecessary-compaction",
    "Small-context compactions",
    `${small.length} of ${compactions.length} compaction(s) were recorded with less than ${COMPACTION_CONTEXT_FLOOR} of context before them.`,
    "Check whether the compaction was needed",
    `Hypothesis: a compaction recorded below ${COMPACTION_CONTEXT_FLOOR} of context may not have been necessary; checking its trigger may avoid the summary cost next time.`,
    small.map((item) => item.eventID),
    small.map((item) => item.turnID ?? ""),
  );
}

interface FileCost {
  path: string;
  cost: number;
  turnIDs: string[];
  eventIDs: string[];
}

/**
 * Rule 6 — the attribution layer's own aggregates. A single path carrying at
 * least half of the attributed file cost is a fact worth naming; concentration
 * needs two attributed files to be meaningful.
 */
function concentratedFileRows(analysis: Analysis): Recommendation[] {
  const byPath = new Map<string, FileCost>();
  for (const turn of asArray(analysis.attribution?.turns)) {
    for (const file of asArray(turn.files)) {
      const value = file.costShare?.value ?? null;
      if (value === null || !(value > 0)) continue;
      const key = file.path;
      let entry = byPath.get(key);
      if (!entry) {
        entry = { path: file.path, cost: 0, turnIDs: [], eventIDs: [] };
        byPath.set(key, entry);
      }
      entry.cost += value;
      entry.turnIDs.push(turn.turnID);
      for (const eventID of asArray(file.eventIDs)) entry.eventIDs.push(eventID);
    }
  }
  const files = [...byPath.values()].sort(
    (left, right) =>
      right.cost - left.cost || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  if (files.length < CONCENTRATED_FILE_MIN_FILES) return [];
  const total = files.reduce((sum, file) => sum + file.cost, 0);
  if (!(total > 0)) return [];
  const top = files[0]!;
  const share = top.cost / total;
  if (share < CONCENTRATED_FILE_SHARE) return [];
  const percent = Math.round(share * 100);
  return [
    row(
      "concentrated-file-cost",
      "fact",
      "Concentrated file cost",
      `${top.path} carries ${percent}% of the attributed file cost (${money(top.cost)} across ${new Set(top.turnIDs).size} turn(s)).`,
      top.eventIDs,
      top.turnIDs,
    ),
  ];
}

/**
 * Primary entry point. Pure, deterministic and local.
 *
 * Returns `null` when no rule triggers: the rider then stays absent instead of
 * asserting an empty recommendation list, mirroring the diagnostics and
 * attribution precedent. A malformed analysis also yields `null` rather than
 * throwing, matching `delegation.ts` and `attribution.ts`.
 */
export function evaluateRecommendations(
  analysis: Analysis,
): Recommendations | null {
  if (
    !analysis ||
    !Array.isArray(analysis.turns) ||
    !Array.isArray(analysis.events) ||
    !Array.isArray(analysis.compactions)
  ) {
    return null;
  }
  const rows: Recommendation[] = [
    ...reduceContextRows(analysis),
    ...retryFailedToolRows(analysis),
    ...splitTaskRows(analysis),
    ...reuseSubagentRows(analysis),
    ...avoidCompactionRows(analysis),
    ...concentratedFileRows(analysis),
  ];
  if (rows.length === 0) return null;
  return {
    rows: rows.slice(0, MAX_RECOMMENDATION_ROWS),
    basisNotes: [...BASIS_NOTES],
  };
}
