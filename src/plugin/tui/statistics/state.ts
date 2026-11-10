import { createMemo, createSignal, type Accessor } from "solid-js";
import type { OpenCodeClient } from "@opencode/client";

import type { Analysis, Metric, Turn } from "../../../core/types.ts";
import { Observability } from "../../rpc.ts";

/**
 * Reactive state for the native statistics panel.
 *
 * One request is issued per call; the view calls `fetchAnalysis` only when the
 * panel opens or the selected session changes. Responses are validated before
 * they reach the view because the payload crosses the RPC boundary and can be
 * absent, wrapped, or malformed.
 */

export interface StatisticsTotals {
  readonly totalContext: Metric;
  readonly cacheHitRate: Metric;
  readonly cost: Metric;
  readonly turns: number;
}

export interface StatisticsState {
  readonly analysis: Accessor<Analysis | null>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  readonly sessionID: Accessor<string>;
  readonly selectedIndex: Accessor<number>;
  readonly totals: Accessor<StatisticsTotals | null>;
  readonly turns: Accessor<readonly Turn[]>;
  setSelectedIndex(index: number): void;
  fetchAnalysis(sessionID: string): Promise<void>;
}

type RpcCapable = Pick<OpenCodeClient, "rpc">;

type ParseOutcome =
  | { readonly ok: true; readonly analysis: Analysis }
  | { readonly ok: false; readonly message: string };

const UNAVAILABLE: Metric = { value: null, basis: "unavailable" };

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
 * Accepts the raw `rpc.call` envelope (`{ output: … }`), the handler result
 * (`{ analysis, revealAllowed }`) and a bare `Analysis`. Anything else becomes
 * a short, non-leaking error message.
 */
function parseAnalysisResponse(response: unknown): ParseOutcome {
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

function asMetric(value: Metric | undefined): Metric {
  return value ?? UNAVAILABLE;
}

export function createStatisticsState(client: RpcCapable): StatisticsState {
  const [analysis, setAnalysis] = createSignal<Analysis | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sessionID, setSessionID] = createSignal("");
  const [selectedIndex, setSelectedIndexSignal] = createSignal(0);
  let request = 0;

  const totals = createMemo<StatisticsTotals | null>(() => {
    const value = analysis();
    if (!value) return null;
    const source = value.totals;
    return {
      totalContext: asMetric(source?.finalContext),
      cacheHitRate: asMetric(source?.cacheHitRate),
      cost: asMetric(source?.cost),
      turns:
        typeof source?.turns === "number"
          ? source.turns
          : (value.turns?.length ?? 0),
    };
  });

  const turns = createMemo<readonly Turn[]>(() => analysis()?.turns ?? []);

  function setSelectedIndex(index: number): void {
    setSelectedIndexSignal(
      Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0,
    );
  }

  async function fetchAnalysis(nextSessionID: string): Promise<void> {
    const target =
      typeof nextSessionID === "string" ? nextSessionID.trim() : "";
    const ticket = ++request;

    if (target !== sessionID()) setSelectedIndex(0);
    setSessionID(target);
    setAnalysis(null);
    setError(null);

    if (target.length === 0) {
      setLoading(false);
      setError("No session is selected.");
      return;
    }

    setLoading(true);
    try {
      const response = await client.rpc.call({
        rpcID: Observability.id,
        method: "analysis",
        input: { sessionID: target },
      });
      if (ticket !== request) return;
      const parsed = parseAnalysisResponse(response);
      if (!parsed.ok) {
        setAnalysis(null);
        setError(parsed.message);
        return;
      }
      setAnalysis(parsed.analysis);
    } catch {
      if (ticket !== request) return;
      setAnalysis(null);
      setError("The analysis could not be loaded. Reopen the panel to retry.");
    } finally {
      if (ticket === request) setLoading(false);
    }
  }

  return {
    analysis,
    loading,
    error,
    sessionID,
    selectedIndex,
    totals,
    turns,
    setSelectedIndex,
    fetchAnalysis,
  };
}
