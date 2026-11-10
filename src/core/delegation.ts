/**
 * Cross-session delegation recovery analysis.
 *
 * The layer is pure and server-agnostic: it never reads events, storage, HTTP
 * or the DOM, and it is deterministic. Everything it reports is derived from
 * the caller-supplied recorded event streams and the analyses/diagnostics that
 * were already computed for them.
 *
 * Recorded versus inferred is the central split:
 * - Recorded durable linkage: a parent `subagent` tool event whose
 *   `childSessionIDs` names the child, plus that event's `meta.delegatedAgent`
 *   stamp. These live verbatim in `DelegationLink`.
 * - Inferred classification: every pattern kind and reaction kind is `derived`
 *   and never `measured`. A child failure picture is `measured` only when the
 *   child stream is complete; a windowed stream cannot claim one.
 *
 * DTO neutrality: no field names a winner, an optimum or a preference. The
 * only "adaptation" signal is the recorded input-change proxy, and it is
 * co-located with its `basis` inside `DelegationRecoveryPattern`.
 */

import { classifyInput, compareInputs } from "./diagnostics.ts";
import type {
  Diagnostics,
  DiagnosticsSummary,
  InputComparability,
} from "./diagnostics.ts";
import type {
  Analysis,
  Basis,
  EventIndexEntry,
  NormalizedEvent,
  SessionSummary,
  Turn,
} from "./types.ts";

export type DelegationRecoveryPatternKind =
  | "no-child-failure"
  | "child-failed-no-parent-reaction"
  | "parent-retried-same-agent"
  | "parent-retried-identical-delegation-input"
  | "parent-retried-with-changed-delegation-input"
  | "parent-fallback-to-other-agent"
  | "parent-reaction-unclear"
  | "insufficient-data";

export type ParentReactionKind =
  | "none"
  | "retry-same-agent"
  | "fallback-to-other-agent"
  | "unclear";

/** Recorded linkage between a parent delegation event and a child session. */
export interface DelegationLink {
  childSessionID: string;
  /** Recorded delegation tool event carrying the child id; null when none. */
  parentEventID: string | null;
  /** Null only when the anchor is the timestamp fallback. */
  parentTurnID: string | null;
  parentTurnIndex: number | null;
  /** Recorded `meta.delegatedAgent` on the anchor tool event. */
  delegatedAgent: string | null;
  /** Derived fallback (earliest child timestamp) when no anchor exists. */
  anchorTimestamp: number;
  inputComparability: InputComparability;
}

/** Failure evidence measured from the child's own recorded stream. */
export interface ChildFailureEvidence {
  repeatedToolFailureIncidents: number;
  sessionOutcome: SessionSummary["outcome"];
  failedOrInterruptedTurns: number;
  failedOrInterruptedIdles: number;
  /** Measured only on a complete, non-windowed child stream. */
  hasFailureEvidence: boolean;
  basis: Basis;
}

/** Recorded parent delegations strictly after the child anchor. */
export interface ParentReaction {
  kind: ParentReactionKind;
  /** Classification label; never `measured`. */
  basis: Basis;
  eventIDs: string[];
  agents: string[];
  inputChanged: boolean;
  inputChangeBasis: Basis;
  uncertainty: string[];
}

export interface DelegationRecoveryPattern {
  kind: DelegationRecoveryPatternKind;
  basis: Basis;
  /** True only for `parent-retried-with-changed-delegation-input`. */
  inputChangeProxy: boolean;
}

export interface ChildDelegationAssessment {
  link: DelegationLink;
  childFailed: ChildFailureEvidence;
  parentReaction: ParentReaction;
  pattern: DelegationRecoveryPattern;
  childDiagnosticsSummary: DiagnosticsSummary | null;
}

export interface FamilyDelegationRecovery {
  schemaVersion: 1;
  rootSessionID: string;
  depth: 1;
  redacted: boolean;
  totalChildren: number;
  childrenCapped: boolean;
  /** Ordered by child `timeCreated`, then by session id. */
  assessments: ChildDelegationAssessment[];
  patternCounts: Record<DelegationRecoveryPatternKind, number>;
  /** `derived` when any classification applied; `unavailable` if all insufficient. */
  basis: Basis;
  notes: string[];
  uncertainty: string[];
}

/** One direct child as supplied by the caller (Ph2 loads these datasets). */
export interface DelegationChildInput {
  sessionID: string;
  events: NormalizedEvent[];
  analysis: Analysis;
  diagnostics: Diagnostics;
}

export interface DelegationRecoveryInput {
  rootSessionID: string;
  parentSessionID: string;
  /** Full recorded order, with turn ids already assigned. */
  parentEvents: NormalizedEvent[];
  parentAnalysis: Analysis;
  parentDiagnostics: Diagnostics;
  children: ReadonlyArray<DelegationChildInput>;
  /** Precomputed by the service in Ph2; derived here when omitted. */
  delegationLinks?: DelegationLink[];
  reveal: boolean;
  /** Cycle guard, defaults to `new Set([rootSessionID])`. Never mutated. */
  seen?: Set<string>;
}

/** Assessment cap for direct children; the remainder is reported as capped. */
export const MAX_ASSESSED_CHILDREN = 8;

const PATTERN_KINDS: readonly DelegationRecoveryPatternKind[] = [
  "no-child-failure",
  "child-failed-no-parent-reaction",
  "parent-retried-same-agent",
  "parent-retried-identical-delegation-input",
  "parent-retried-with-changed-delegation-input",
  "parent-fallback-to-other-agent",
  "parent-reaction-unclear",
  "insufficient-data",
];

/**
 * True when the event is a recorded delegation call. The three signals are
 * ORed on purpose: the tool name, the normalized subagent flag, or a recorded
 * child session id is each sufficient on its own.
 */
export function isDelegationToolEvent(event: NormalizedEvent): boolean {
  if (!event || event.kind !== "tool") return false;
  const tool = event.tool;
  if (!tool) return false;
  const childIDs = Array.isArray(tool.childSessionIDs)
    ? tool.childSessionIDs
    : [];
  return (
    tool.name === "subagent" ||
    event.flags?.subagent === true ||
    childIDs.length > 0
  );
}

function delegatedAgentOf(event: NormalizedEvent): string | null {
  const meta = event.meta;
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>)["delegatedAgent"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function childSessionIDsOf(event: NormalizedEvent): string[] {
  const tool = event.tool;
  if (!tool || !Array.isArray(tool.childSessionIDs)) return [];
  return tool.childSessionIDs.filter(
    (id): id is string => typeof id === "string",
  );
}

function turnOfEvent(
  turns: ReadonlyArray<Turn>,
  eventID: string,
): Turn | null {
  for (const turn of turns) {
    if (Array.isArray(turn.eventIDs) && turn.eventIDs.includes(eventID)) {
      return turn;
    }
  }
  return null;
}

function emptyPatternCounts(): Record<DelegationRecoveryPatternKind, number> {
  const counts = {} as Record<DelegationRecoveryPatternKind, number>;
  for (const kind of PATTERN_KINDS) counts[kind] = 0;
  return counts;
}

function parentTurnsOf(analysis: Analysis | undefined): ReadonlyArray<Turn> {
  if (!analysis) return [];
  return Array.isArray(analysis.turns) ? analysis.turns : [];
}

function parentComplete(analysis: Analysis | undefined): boolean {
  return analysis?.coverage?.complete === true;
}

function childTurnsOf(child: DelegationChildInput): ReadonlyArray<Turn> {
  return Array.isArray(child.analysis?.turns) ? child.analysis.turns : [];
}

function childEventsOf(child: DelegationChildInput): ReadonlyArray<EventIndexEntry> {
  return Array.isArray(child.analysis?.events) ? child.analysis.events : [];
}

function childTimeCreated(child: DelegationChildInput): number {
  const created = child.analysis?.session?.time?.created;
  if (typeof created === "number" && Number.isFinite(created)) return created;
  return earliestChildTimestamp(child);
}

function earliestChildTimestamp(child: DelegationChildInput): number {
  let earliest = Number.POSITIVE_INFINITY;
  const events = Array.isArray(child.events) ? child.events : [];
  for (const event of events) {
    if (
      typeof event.timestamp === "number" &&
      Number.isFinite(event.timestamp) &&
      event.timestamp < earliest
    ) {
      earliest = event.timestamp;
    }
  }
  const created = child.analysis?.session?.time?.created;
  if (
    typeof created === "number" &&
    Number.isFinite(created) &&
    created < earliest
  ) {
    earliest = created;
  }
  return Number.isFinite(earliest) ? earliest : 0;
}

interface AnchorResolution {
  link: DelegationLink;
  anchorEvent: NormalizedEvent | null;
  anchorIndex: number;
  uncertainty: string[];
}

function deriveAnchor(
  child: DelegationChildInput,
  parentEvents: ReadonlyArray<NormalizedEvent>,
  parentTurns: ReadonlyArray<Turn>,
): AnchorResolution {
  let anchorIndex = -1;
  for (let index = 0; index < parentEvents.length; index += 1) {
    const event = parentEvents[index]!;
    if (!isDelegationToolEvent(event)) continue;
    if (!childSessionIDsOf(event).includes(child.sessionID)) continue;
    anchorIndex = index;
    break;
  }

  if (anchorIndex >= 0) {
    const event = parentEvents[anchorIndex]!;
    const tool = event.tool;
    const turn = turnOfEvent(parentTurns, event.id);
    return {
      anchorIndex,
      anchorEvent: event,
      uncertainty: [],
      link: {
        childSessionID: child.sessionID,
        parentEventID: event.id,
        parentTurnID: turn ? turn.id : null,
        parentTurnIndex: turn ? turn.index : null,
        delegatedAgent: delegatedAgentOf(event),
        anchorTimestamp: event.timestamp,
        inputComparability: classifyInput(tool ? tool.input : null),
      },
    };
  }

  return {
    anchorIndex: -1,
    anchorEvent: null,
    uncertainty: [
      `no recorded delegation event links child ${child.sessionID}; its earliest timestamp was used as the anchor`,
    ],
    link: {
      childSessionID: child.sessionID,
      parentEventID: null,
      parentTurnID: null,
      parentTurnIndex: null,
      delegatedAgent: null,
      anchorTimestamp: earliestChildTimestamp(child),
      inputComparability: "absent",
    },
  };
}

function providedAnchor(
  link: DelegationLink,
  parentEvents: ReadonlyArray<NormalizedEvent>,
): AnchorResolution {
  let anchorIndex = -1;
  if (typeof link.parentEventID === "string") {
    anchorIndex = parentEvents.findIndex(
      (event) => event.id === link.parentEventID,
    );
  }
  const anchorEvent = anchorIndex >= 0 ? parentEvents[anchorIndex]! : null;
  const uncertainty: string[] = [];
  if (typeof link.parentEventID === "string" && anchorEvent === null) {
    uncertainty.push(
      `recorded delegation event ${link.parentEventID} is absent from the parent stream`,
    );
  }
  return {
    anchorIndex,
    anchorEvent,
    uncertainty,
    link: {
      childSessionID: link.childSessionID,
      parentEventID: link.parentEventID,
      parentTurnID: link.parentTurnID,
      parentTurnIndex: link.parentTurnIndex,
      delegatedAgent: link.delegatedAgent,
      anchorTimestamp: Number.isFinite(link.anchorTimestamp)
        ? link.anchorTimestamp
        : 0,
      inputComparability: link.inputComparability,
    },
  };
}

function buildReaction(
  anchor: AnchorResolution,
  parentEvents: ReadonlyArray<NormalizedEvent>,
  complete: boolean,
  child: DelegationChildInput,
): ParentReaction {
  const after =
    anchor.anchorIndex >= 0
      ? parentEvents.slice(anchor.anchorIndex + 1)
      : parentEvents.filter(
          (event) => event.timestamp > anchor.link.anchorTimestamp,
        );
  const later = after.filter((event) => isDelegationToolEvent(event));
  const eventIDs = later.map((event) => event.id);
  const agents: string[] = [];
  for (const event of later) {
    const agent = delegatedAgentOf(event);
    if (agent !== null) agents.push(agent);
  }

  const uncertainty = [...anchor.uncertainty];
  const originalAgent = anchor.link.delegatedAgent;
  const originalTool = anchor.anchorEvent?.tool ?? null;

  // The first later delegation that stamps an agent decides the reaction;
  // later stamps do not retroactively change it.
  let chosenLater: NormalizedEvent | null = null;
  for (const event of later) {
    if (delegatedAgentOf(event) !== null) {
      chosenLater = event;
      break;
    }
  }

  let kind: ParentReactionKind;
  if (later.length === 0) {
    kind = "none";
  } else if (originalAgent === null) {
    kind = "unclear";
    uncertainty.push(
      "the recorded original delegation carries no delegated agent",
    );
  } else if (chosenLater === null) {
    kind = "unclear";
    uncertainty.push(
      "later delegation events carry no recorded delegated agent",
    );
  } else if (delegatedAgentOf(chosenLater) === originalAgent) {
    kind = "retry-same-agent";
  } else {
    kind = "fallback-to-other-agent";
  }

  let inputChanged = false;
  let inputChangeBasis: Basis = "unavailable";
  const laterTool = chosenLater === null ? null : chosenLater.tool;
  if (chosenLater !== null && originalTool !== null && laterTool !== null) {
    const originalState = classifyInput(originalTool.input);
    const laterState = classifyInput(laterTool.input);
    if (originalState === "comparable" && laterState === "comparable") {
      inputChanged =
        compareInputs(originalTool.input, laterTool.input).verdict !== "identical";
      inputChangeBasis = "derived";
    } else {
      uncertainty.push(
        `delegation inputs are not comparable (original ${originalState}, later ${laterState})`,
      );
    }
  }

  const basis: Basis =
    anchor.anchorEvent === null || !complete ? "unavailable" : "derived";
  if (anchor.anchorEvent !== null && !complete) {
    uncertainty.push(
      "the parent stream is incomplete; the reaction is not classified from a full record",
    );
  }
  if (anchor.anchorEvent === null) {
    uncertainty.push(
      `child ${child.sessionID} has no recorded delegation anchor`,
    );
  }

  return {
    kind,
    basis,
    eventIDs,
    agents,
    inputChanged,
    inputChangeBasis,
    uncertainty,
  };
}

function childFailureEvidence(
  child: DelegationChildInput,
): ChildFailureEvidence {
  const incidents =
    child.diagnostics && Array.isArray(child.diagnostics.incidents)
      ? child.diagnostics.incidents.length
      : 0;
  const sessionOutcome: SessionSummary["outcome"] =
    child.analysis?.session?.outcome;
  const failedOrInterruptedTurns = childTurnsOf(child).filter(
    (turn) => turn.status === "error" || turn.status === "interrupted",
  ).length;
  const failedOrInterruptedIdles = childEventsOf(child).filter(
    (event) =>
      event.kind === "idle" &&
      (event.status === "failed" || event.status === "interrupted"),
  ).length;
  const outcomeFailed =
    sessionOutcome === "failed" || sessionOutcome === "interrupted";
  const hasFailureEvidence =
    incidents > 0 ||
    outcomeFailed ||
    failedOrInterruptedTurns > 0 ||
    failedOrInterruptedIdles > 0;

  // Windowing hazard: a windowed/incomplete child stream cannot claim a
  // complete failure picture, so it never earns the `measured` basis. Ph2
  // always passes full-range datasets; `analysis.coverage.complete` is the only
  // completeness signal this pure module needs.
  return {
    repeatedToolFailureIncidents: incidents,
    sessionOutcome,
    failedOrInterruptedTurns,
    failedOrInterruptedIdles,
    hasFailureEvidence,
    basis: child.analysis?.coverage?.complete === true
      ? "measured"
      : "unavailable",
  };
}

interface PatternClassification {
  kind: DelegationRecoveryPatternKind;
  inputChangeProxy: boolean;
}

function classifyPattern(
  childFailed: ChildFailureEvidence,
  anchor: AnchorResolution,
  reaction: ParentReaction,
  complete: boolean,
): PatternClassification {
  if (childFailed.basis !== "measured") {
    return { kind: "insufficient-data", inputChangeProxy: false };
  }
  if (anchor.anchorEvent === null) {
    return { kind: "insufficient-data", inputChangeProxy: false };
  }
  if (!complete) {
    return { kind: "insufficient-data", inputChangeProxy: false };
  }
  if (!childFailed.hasFailureEvidence) {
    return { kind: "no-child-failure", inputChangeProxy: false };
  }
  switch (reaction.kind) {
    case "none":
      return { kind: "child-failed-no-parent-reaction", inputChangeProxy: false };
    case "unclear":
      return { kind: "parent-reaction-unclear", inputChangeProxy: false };
    case "fallback-to-other-agent":
      return { kind: "parent-fallback-to-other-agent", inputChangeProxy: false };
    case "retry-same-agent":
      if (reaction.inputChangeBasis !== "derived") {
        return { kind: "parent-retried-same-agent", inputChangeProxy: false };
      }
      return reaction.inputChanged
        ? {
            kind: "parent-retried-with-changed-delegation-input",
            inputChangeProxy: true,
          }
        : {
            kind: "parent-retried-identical-delegation-input",
            inputChangeProxy: false,
          };
  }
}

function assessChild(
  child: DelegationChildInput,
  parentEvents: ReadonlyArray<NormalizedEvent>,
  parentTurns: ReadonlyArray<Turn>,
  complete: boolean,
  provided: DelegationLink | undefined,
): { assessment: ChildDelegationAssessment; uncertainty: string[] } {
  const anchor =
    provided === undefined
      ? deriveAnchor(child, parentEvents, parentTurns)
      : providedAnchor(provided, parentEvents);
  const childFailed = childFailureEvidence(child);
  const parentReaction = buildReaction(anchor, parentEvents, complete, child);
  const classification = classifyPattern(
    childFailed,
    anchor,
    parentReaction,
    complete,
  );
  const pattern: DelegationRecoveryPattern = {
    kind: classification.kind,
    basis:
      classification.kind === "insufficient-data" ? "unavailable" : "derived",
    inputChangeProxy: classification.inputChangeProxy,
  };
  const summary =
    child.diagnostics && child.diagnostics.summary
      ? { ...child.diagnostics.summary }
      : null;
  return {
    assessment: {
      link: anchor.link,
      childFailed,
      parentReaction,
      pattern,
      childDiagnosticsSummary: summary,
    },
    uncertainty: parentReaction.uncertainty,
  };
}

/**
 * Evaluates delegation recovery for the direct children of one parent session.
 *
 * Pure and deterministic: no input is mutated and the returned DTO is fresh.
 * It never throws on a malformed input shape; missing pieces degrade to
 * `insufficient-data` plus deterministic `notes`/`uncertainty` entries.
 */
export function evaluateDelegationRecovery(
  input: DelegationRecoveryInput,
): FamilyDelegationRecovery {
  const rootSessionID =
    typeof input.rootSessionID === "string" ? input.rootSessionID : "";
  const parentEvents = Array.isArray(input.parentEvents)
    ? input.parentEvents
    : [];
  const parentTurns = parentTurnsOf(input.parentAnalysis);
  const complete = parentComplete(input.parentAnalysis);
  const children = Array.isArray(input.children) ? input.children : [];
  const precomputedLinks = Array.isArray(input.delegationLinks)
    ? input.delegationLinks
    : [];
  const seen =
    input.seen instanceof Set ? input.seen : new Set<string>([rootSessionID]);

  const notes: string[] = [];
  const uncertainty: string[] = [];

  const sorted = [...children].sort((left, right) => {
    const delta = childTimeCreated(left) - childTimeCreated(right);
    if (delta !== 0) return delta;
    return left.sessionID.localeCompare(right.sessionID);
  });

  const candidates: DelegationChildInput[] = [];
  for (const child of sorted) {
    if (child.sessionID === rootSessionID || seen.has(child.sessionID)) {
      notes.push(`cycle detected: ${child.sessionID}`);
      continue;
    }
    candidates.push(child);
  }

  const assessed = candidates.slice(0, MAX_ASSESSED_CHILDREN);
  if (candidates.length > MAX_ASSESSED_CHILDREN) {
    notes.push(
      `${candidates.length - MAX_ASSESSED_CHILDREN} children not assessed (cap ${MAX_ASSESSED_CHILDREN})`,
    );
  }

  const patternCounts = emptyPatternCounts();
  const assessments: ChildDelegationAssessment[] = [];
  for (const child of assessed) {
    const provided = precomputedLinks.find(
      (link) => link.childSessionID === child.sessionID,
    );
    const result = assessChild(
      child,
      parentEvents,
      parentTurns,
      complete,
      provided,
    );
    assessments.push(result.assessment);
    patternCounts[result.assessment.pattern.kind] += 1;
    for (const note of result.uncertainty) {
      uncertainty.push(`child ${child.sessionID}: ${note}`);
    }
  }

  const classified = assessments.some(
    (assessment) => assessment.pattern.kind !== "insufficient-data",
  );

  return {
    schemaVersion: 1,
    rootSessionID,
    depth: 1,
    redacted: input.reveal !== true,
    totalChildren: children.length,
    childrenCapped: children.length > MAX_ASSESSED_CHILDREN,
    assessments,
    patternCounts,
    basis: classified ? "derived" : "unavailable",
    notes,
    uncertainty,
  };
}
