import type { Analysis } from "../../core/types.ts";

/**
 * Poll gating for the native panels.
 *
 * Polling an ended session forever is pure load: nothing advances once the
 * recording is complete. The gate is deliberately conservative — it needs a
 * terminal outcome *and* an idle session — so an active or ambiguous frame
 * keeps polling. It is a pure function of the analysis payload, which keeps the
 * rule identical in the statistics and trajectory panels.
 */

/** Turn statuses that mean the turn itself settled. */
const TERMINAL_TURN_STATUS: ReadonlySet<string> = new Set([
  "completed",
  "error",
  "interrupted",
]);

/**
 * True when the session recorded a terminal outcome, no turn is running and
 * the recorded clock says the session is not busy (`busy <= idle`, or no busy
 * stamp at all).
 */
export function isSettledAnalysis(analysis: Analysis | null): boolean {
  if (!analysis) return false;
  const session = analysis.session;
  if (!session) return false;
  const { busy, idle } = session.time ?? {};
  const active =
    typeof busy === "number" &&
    (typeof idle !== "number" || busy > idle);
  if (active) return false;
  const turns = Array.isArray(analysis.turns) ? analysis.turns : [];
  if (turns.some((turn) => turn.status === "running")) return false;
  if (session.outcome) return true;
  const last = turns[turns.length - 1];
  return last !== undefined && TERMINAL_TURN_STATUS.has(last.status);
}
