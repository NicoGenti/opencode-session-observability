import type { Analysis } from "../../core/types.ts";

/**
 * Response validation shared by the native session panels.
 *
 * The payload crosses the RPC boundary, so it can arrive as the raw envelope
 * (`{ output: … }`), the handler result (`{ analysis, revealAllowed }`) or a
 * bare `Analysis`. This module owns that shape decision once so the statistics
 * and trajectory panels cannot drift apart.
 */

export type AnalysisParseOutcome =
  | { readonly ok: true; readonly analysis: Analysis }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeAnalysis(value: unknown): value is Analysis {
  return (
    isRecord(value) &&
    Array.isArray(value.turns) &&
    isRecord(value.totals) &&
    isRecord(value.session)
  );
}

/**
 * Accepts the raw RPC envelope (`{ output: … }`), the handler result
 * (`{ analysis, revealAllowed }`) and a bare `Analysis`. Anything else becomes
 * a short, non-leaking error message.
 */
export function parseAnalysisResponse(
  response: unknown,
): AnalysisParseOutcome {
  let current: unknown = response;
  for (let depth = 0; depth < 4; depth++) {
    if (!isRecord(current)) break;
    if (looksLikeAnalysis(current)) return { ok: true, analysis: current };
    if ("analysis" in current) {
      const inner = current.analysis;
      if (looksLikeAnalysis(inner)) return { ok: true, analysis: inner };
      return {
        ok: false,
        message: "No analysis is available for this session.",
      };
    }
    if ("output" in current) {
      current = current.output;
      continue;
    }
    if ("error" in current) {
      return { ok: false, message: "The analysis request returned an error." };
    }
    break;
  }
  return {
    ok: false,
    message: "The analysis response was not recognized.",
  };
}
