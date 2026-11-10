import { createMemo, createSignal, untrack, type Accessor } from "solid-js";
import type { OpenCodeClient } from "@opencode/client";

import type { Analysis, Metric, Turn } from "../../../core/types.ts";
import { Observability } from "../../rpc.ts";

/**
 * Reactive state for the native statistics panel.
 *
 * One request is issued per call; the view calls `fetchAnalysis` only when the
 * panel opens or the selected session changes. `fetchAnalysis` never reads a
 * signal inside its synchronous window, so it cannot re-trigger the effect that
 * called it. Responses are validated before they reach the view because the
 * payload crosses the RPC boundary and can be absent, wrapped, or malformed.
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
  readonly expandedTurns: Accessor<ReadonlySet<string>>;
  readonly totals: Accessor<StatisticsTotals | null>;
  readonly turns: Accessor<readonly Turn[]>;
  setSelectedIndex(index: number): void;
  moveSelection(delta: number): void;
  toggleTurnExpand(turnID: string): void;
  isSelected(turn: Turn): boolean;
  fetchAnalysis(sessionID: string): Promise<void>;
}

/**
 * Panel-scoped keyboard actions. `src/plugin/tui.ts` owns the keymap layer and
 * forwards dispatch here, so the layer never imports Solid at runtime.
 */
export interface StatisticsKeyboardHandlers {
  readonly moveSelection: (delta: number) => void;
  readonly toggleExpand: () => void;
}

/**
 * Mutable hand-off between the keymap layer and the mounted panel. The panel
 * installs its handlers on mount and clears them on cleanup, so commands are
 * no-ops whenever the panel is not rendered.
 */
export interface StatisticsKeyboardBridge {
  handlers: StatisticsKeyboardHandlers | null;
}

/** Clamps an index into `[0, count - 1]`; an empty list always yields 0. */
export function clampIndex(index: number, count: number): number {
  const total = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (total === 0) return 0;
  const value = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(Math.max(value, 0), total - 1);
}

/**
 * Pure selection step. Exported for phase-4 unit tests: given the current
 * index, a delta and the turn count, it returns the clamped next index.
 */
export function moveSelection(
  current: number,
  delta: number,
  count: number,
): number {
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const base = Number.isFinite(current) ? Math.trunc(current) : 0;
  return clampIndex(base + step, count);
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
 * Accepts the raw RPC envelope (`{ output: … }`), the handler result
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
  const rpc = client.rpc(Observability);
  const [analysis, setAnalysis] = createSignal<Analysis | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sessionID, setSessionID] = createSignal("");
  const [selectedIndex, setSelectedIndexSignal] = createSignal(0);
  const [expandedTurns, setExpandedTurns] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
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
    setSelectedIndexSignal(clampIndex(index, turns().length));
  }

  function moveSelectionBy(delta: number): void {
    setSelectedIndexSignal((current) =>
      moveSelection(current, delta, turns().length),
    );
  }

  /**
   * Toggles one turn's accordion row. Turns carry no per-turn transient view
   * state today, so there is nothing else to reset when a turn expands.
   */
  function toggleTurnExpand(turnID: string): void {
    const id = typeof turnID === "string" ? turnID.trim() : "";
    if (id.length === 0) return;
    setExpandedTurns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function isSelected(turn: Turn): boolean {
    const list = turns();
    const index = selectedIndex();
    return index >= 0 && index < list.length && list[index] === turn;
  }

  /** Drops expanded ids that no longer exist and clamps the selection. */
  function reconcile(analysisValue: Analysis): void {
    const list = analysisValue.turns ?? [];
    setSelectedIndexSignal((current) => clampIndex(current, list.length));
    const alive = new Set(list.map((turn) => turn.id));
    setExpandedTurns((current) => {
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }

  async function fetchAnalysis(nextSessionID: string): Promise<void> {
    const target =
      typeof nextSessionID === "string" ? nextSessionID.trim() : "";
    const ticket = ++request;

    // `untrack` keeps this read out of the calling effect's dependency set: a
    // tracked read would subscribe the effect to the `setSessionID` write below
    // and issue a second request per open/session change.
    const previous = untrack(sessionID);
    if (target !== previous) {
      // Written signal-level rather than through `setSelectedIndex`, which
      // reads `turns()` and would re-subscribe the effect to the response.
      setSelectedIndexSignal(0);
      setExpandedTurns(new Set<string>());
    }
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
      const response = await rpc.analysis({ sessionID: target });
      if (ticket !== request) return;
      const parsed = parseAnalysisResponse(response);
      if (!parsed.ok) {
        setAnalysis(null);
        setError(parsed.message);
        return;
      }
      reconcile(parsed.analysis);
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
    expandedTurns,
    totals,
    turns,
    setSelectedIndex,
    moveSelection: moveSelectionBy,
    toggleTurnExpand,
    isSelected,
    fetchAnalysis,
  };
}
