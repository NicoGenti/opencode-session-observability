/**
 * Live session snapshot derived purely from an already-loaded `Analysis`.
 *
 * The evaluator never performs I/O, never reads the clock and never re-reads
 * the source: it is a pure function of the session, turns, events and the
 * already-attached `analysis.health` rules. That keeps the live surface on the
 * same single compute site as every other view — polling re-projects the
 * dataset and this module only re-shapes the result.
 *
 * Liveness is derived, never streamed. The three orthogonal signals are
 * `state` (recording / idle / ended / unknown), `coverage.complete` (window or
 * full range) and the recorded terminal outcomes. Warnings are the five
 * operational health rules re-read from `analysis.health.rules`, never a
 * second rule engine, and they live only in this DTO: they are never attached
 * to `Analysis`, persisted or exported.
 */

import { MAX_EVENT_LINKS, MAX_TURN_LINKS } from "./health.ts";
import type { HealthRuleId, HealthRuleResult } from "./health.ts";
import type {
  Analysis,
  Coverage,
  EventIndexEntry,
  Metric,
  SessionMeta,
  TokenUsage,
  Turn,
} from "./types.ts";

export type LiveState = "running" | "idle" | "ended" | "unknown";

/** One incremental page of new events; a first tick stays small. */
export const MAX_NEW_EVENTS = 50;

/**
 * The five operational rules a live poll reports. `error-rate` is a
 * retrospective aggregate and `unfinished-outcome` would fire on every
 * recorded failure or interrupt, so both stay out of the live vocabulary.
 */
export const LIVE_WARNING_RULE_IDS: readonly HealthRuleId[] = Object.freeze([
  "retry-count",
  "tool-failure-recurrence",
  "context-growth",
  "low-cache-hit",
  "cost-per-turn",
]);

/** The still-open turn, carrying its already-computed metrics. */
export interface LiveOpenTurn {
  index: number;
  id: string;
  startedAt: number;
  steps: number;
  tokens: TokenUsage;
  cost: Metric;
  /** Always `["session-in-progress"]`: the turn has not settled yet. */
  uncertainty: string[];
}

/**
 * One triggered health rule, re-read verbatim from `analysis.health.rules` and
 * labelled as a live derivation. Evidence ids keep the health caps.
 */
export interface LiveWarning extends Omit<HealthRuleResult, "triggered"> {
  triggered: true;
  basis: "derived";
  uncertainty: string[];
}

export interface LiveSnapshot {
  state: LiveState;
  basis: "derived";
  /** Session `time.updated`, else the last recorded event timestamp. */
  asOf: number;
  openTurn: LiveOpenTurn | null;
  warnings: LiveWarning[];
  coverage: Coverage;
  totalInSession: number;
  /** Events with `orderKey > since`; `null` when no `since` was supplied. */
  newEvents: EventIndexEntry[] | null;
  /** Present only when `lastTurns` bounded the snapshot. */
  turnWindow?: { last: number; of: number };
}

export interface LiveSnapshotOptions {
  /** Restricts `openTurn` and warning evidence to the last N turns. */
  lastTurns?: number;
  /** Lexicographic `orderKey` cursor for `newEvents`. */
  since?: string;
}

/** Mirrors `projectSession`'s `sessionActive` without re-deriving it. */
function sessionActive(session: SessionMeta): boolean {
  const { busy, idle } = session.time;
  return busy !== undefined && (idle === undefined || busy > idle);
}

function isTerminalOutcome(status: string | null): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "interrupted"
  );
}

/**
 * `ended` needs a recorded terminal outcome: the session outcome, or an idle
 * message attached to the last turn. A session that merely has no open steps
 * is not claimed as ended.
 */
function deriveState(analysis: Analysis): LiveState {
  if (analysis.session.outcome) return "ended";
  const last = analysis.turns[analysis.turns.length - 1] ?? null;
  if (last !== null && hasTerminalIdle(analysis, last)) return "ended";
  if (sessionActive(analysis.session)) return "running";
  const { busy, idle } = analysis.session.time;
  if (busy !== undefined && idle !== undefined) return "idle";
  return "unknown";
}

function hasTerminalIdle(analysis: Analysis, turn: Turn): boolean {
  const attached = new Set(turn.nonStepEventIDs);
  return analysis.events.some(
    (event) =>
      attached.has(event.id) &&
      event.kind === "idle" &&
      isTerminalOutcome(event.status),
  );
}

function openTurnOf(turns: readonly Turn[]): LiveOpenTurn | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.status !== "running") continue;
    return {
      index: turn.index,
      id: turn.id,
      startedAt: turn.startTime,
      steps: turn.steps.length,
      tokens: { ...turn.tokens },
      cost: turn.cost,
      uncertainty: ["session-in-progress"],
    };
  }
  return null;
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

function eventTurnsByID(analysis: Analysis): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const event of analysis.events) map.set(event.id, event.turnID);
  return map;
}

/**
 * Triggered operational rules in the health order. When a turn window is
 * supplied, evidence outside it is dropped and a rule with no in-window
 * evidence is not reported: the snapshot describes the window, not the whole
 * session.
 */
function warningsOf(
  analysis: Analysis,
  window: ReadonlySet<string> | null,
): LiveWarning[] {
  const rules = analysis.health?.rules ?? [];
  const turnByEvent = window === null ? null : eventTurnsByID(analysis);
  const out: LiveWarning[] = [];
  for (const rule of rules) {
    if (!rule.triggered) continue;
    if (!LIVE_WARNING_RULE_IDS.includes(rule.id)) continue;
    const eventIDs = capIDs(rule.eventIDs, MAX_EVENT_LINKS);
    const turnIDs = capIDs(rule.turnIDs, MAX_TURN_LINKS);
    const inWindowEvents =
      window === null || turnByEvent === null
        ? eventIDs
        : eventIDs.filter((id) => {
            const turnID = turnByEvent.get(id) ?? null;
            return turnID !== null && window.has(turnID);
          });
    const inWindowTurns =
      window === null ? turnIDs : turnIDs.filter((id) => window.has(id));
    if (
      window !== null &&
      inWindowEvents.length === 0 &&
      inWindowTurns.length === 0
    ) {
      continue;
    }
    out.push({
      ...rule,
      triggered: true,
      eventIDs: inWindowEvents,
      turnIDs: inWindowTurns,
      basis: "derived",
      uncertainty: ["session-in-progress"],
    });
  }
  return out;
}

function newEventsOf(
  analysis: Analysis,
  since: string | undefined,
): EventIndexEntry[] | null {
  if (typeof since !== "string" || since.length === 0) return null;
  const out: EventIndexEntry[] = [];
  for (const event of analysis.events) {
    if (event.orderKey <= since) continue;
    out.push(event);
    if (out.length >= MAX_NEW_EVENTS) break;
  }
  return out;
}

function asOf(analysis: Analysis): number {
  const updated = analysis.session.time.updated;
  if (typeof updated === "number") return updated;
  const last = analysis.events[analysis.events.length - 1];
  if (last) return last.timestamp;
  return analysis.session.time.created;
}

function normalizeLastTurns(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const turns = Math.trunc(value);
  return turns > 0 ? turns : null;
}

/**
 * Primary entry point. Pure, deterministic and local.
 *
 * `lastTurns > 0` bounds `openTurn` and the warning evidence to the turn
 * suffix and emits a `turnWindow` label; `since` turns the event tail into an
 * incremental page capped at `MAX_NEW_EVENTS`.
 */
export function deriveLiveSnapshot(
  analysis: Analysis,
  options: LiveSnapshotOptions = {},
): LiveSnapshot {
  const lastTurns = normalizeLastTurns(options.lastTurns);
  const turns =
    lastTurns === null ? analysis.turns : analysis.turns.slice(-lastTurns);
  const window =
    lastTurns === null ? null : new Set(turns.map((turn) => turn.id));
  const snapshot: LiveSnapshot = {
    state: deriveState(analysis),
    basis: "derived",
    asOf: asOf(analysis),
    openTurn: openTurnOf(turns),
    warnings: warningsOf(analysis, window),
    coverage: analysis.coverage,
    totalInSession: analysis.events.length,
    newEvents: newEventsOf(analysis, options.since),
  };
  if (lastTurns !== null) {
    snapshot.turnWindow = { last: turns.length, of: analysis.turns.length };
  }
  return snapshot;
}
