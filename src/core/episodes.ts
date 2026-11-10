/**
 * Episode enumeration over diagnostics incidents.
 *
 * An episode is the addressable form of one `DiagnosticIncident`: it adds the
 * identity (session, turn, tool, first failing event) needed to select it and
 * re-read its underlying events later. Enumeration is pure and never re-sorts:
 * the output order is the incident order, which is recorded order (turn index,
 * then the recorded position of the run's first failure).
 *
 * One episode is produced per incident; the mapping carries every diagnostic
 * verdict verbatim. No episode-level comparison happens here.
 */

import type {
  DiagnosticIncident,
  Diagnostics,
  RecoveryState,
  SimilarityVerdict,
} from "./diagnostics.ts";

export interface DiagnosticEpisode {
  /**
   * Stable episode key:
   * `${sessionID}:${turnID}:${tool}:${failureEventIDs[0]}`.
   */
  id: string;
  sessionID: string;
  turnID: string;
  /** 1-based turn index from `Analysis.turns`, copied from the incident. */
  turnIndex: number;
  tool: string;
  /** Number of failures in the incident's maximal run. */
  attemptCount: number;
  recovery: RecoveryState;
  similarity: SimilarityVerdict;
  /** Failing event ids in recorded order, copied from the incident. */
  failureEventIDs: string[];
  /** Same-tool success event id when the run recovered; otherwise null. */
  recoveryEventID: string | null;
}

function toEpisode(
  incident: DiagnosticIncident,
  sessionID: string,
): DiagnosticEpisode {
  const failureEventIDs = [...incident.failureEventIDs];
  const [firstFailureID] = failureEventIDs;
  return {
    id: `${sessionID}:${incident.turnID}:${incident.tool}:${firstFailureID}`,
    sessionID,
    turnID: incident.turnID,
    turnIndex: incident.turn,
    tool: incident.tool,
    attemptCount: incident.attempts,
    recovery: incident.recovery,
    similarity: incident.similarity,
    failureEventIDs,
    recoveryEventID: incident.recoveryEventID,
  };
}

/**
 * Lists one episode per diagnostic incident, in recorded order.
 *
 * `sessionID` is the session the diagnostics were evaluated for (normally
 * `analysis.session.id`). It is part of every episode id, so callers must pass
 * the same session that produced the incidents. Returns an empty array when
 * nothing failed.
 */
export function listDiagnosticEpisodes(
  diagnostics: Diagnostics,
  sessionID: string,
): DiagnosticEpisode[] {
  return diagnostics.incidents.map((incident) =>
    toEpisode(incident, sessionID),
  );
}
