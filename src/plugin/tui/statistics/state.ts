import { createSignal, untrack, type Accessor } from "solid-js";
import type { OpenCodeClient } from "@opencode/client";

import type { Analysis, Metric, Turn } from "../../../core/types.ts";
import { Observability } from "../../rpc.ts";
import { isRecord, parseAnalysisResponse } from "../analysisResponse.ts";

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

/** Outcome of one review-prompt request; the file body or a short error. */
export type ReviewPromptOutcome =
  | {
      readonly ok: true;
      /** Session the prompt was rendered for, so the caller names the file right. */
      readonly sessionID: string;
      readonly filename: string;
      readonly content: string;
    }
  | { readonly ok: false; readonly error: string };

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
  /**
   * Asks the RPC for the redacted LLM review prompt of the current session.
   * No `reveal` flag is ever sent, so the result is redacted by construction.
   */
  fetchReviewPrompt(): Promise<ReviewPromptOutcome>;
}

/**
 * Panel-scoped keyboard actions. `src/plugin/tui.ts` owns the keymap layer and
 * forwards dispatch here, so the layer never imports Solid at runtime.
 */
export interface StatisticsKeyboardHandlers {
  readonly moveSelection: (delta: number) => void;
  readonly toggleExpand: () => void;
  /** Writes the redacted LLM review prompt to a temp file and toasts the path. */
  readonly reviewPrompt?: () => void;
}

/**
 * Mutable hand-off between the keymap layer and the mounted panel. The panel
 * installs its handlers on mount and clears them on cleanup, so commands are
 * no-ops whenever the panel is not rendered.
 *
 * `focused` mirrors the host's `PanelInput.focused` (`null` when the host did
 * not report it). The keymap layer refuses keys while it is `false`, so another
 * focusable surface cannot leak keystrokes into the panel; an unreported value
 * leaves the panel-name gate as the floor.
 */
export interface StatisticsKeyboardBridge {
  handlers: StatisticsKeyboardHandlers | null;
  focused: boolean | null;
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

const UNAVAILABLE: Metric = { value: null, basis: "unavailable" };

function asMetric(value: Metric | undefined): Metric {
  return value ?? UNAVAILABLE;
}

/**
 * Validates an export response the same way `parseAnalysisResponse` validates
 * the analysis: the payload crosses the RPC boundary, so it can arrive as the
 * raw envelope (`{ output: … }`), the handler result (`{ filename, content, … }`)
 * or something unexpected. Messages stay short and never echo payload text.
 * The requested `sessionID` rides along so the caller can name the file after
 * the session the prompt was actually rendered for.
 */
export function parseReviewPromptResponse(
  response: unknown,
  sessionID: string,
): ReviewPromptOutcome {
  let current: unknown = response;
  for (let depth = 0; depth < 4; depth++) {
    if (!isRecord(current)) break;
    if (
      typeof current.filename === "string" &&
      typeof current.content === "string"
    ) {
      return {
        ok: true,
        sessionID,
        filename: current.filename,
        content: current.content,
      };
    }
    if ("output" in current) {
      current = current.output;
      continue;
    }
    if ("error" in current) {
      return {
        ok: false,
        error: "The review prompt request returned an error.",
      };
    }
    break;
  }
  return {
    ok: false,
    error: "The review prompt response was not recognized.",
  };
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

  const totals = (): StatisticsTotals | null => {
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
  };

  // Plain accessors: each derives from the one analysis signal, so the view
  // tracks it through JSX. This also keeps the state usable outside a Solid
  // root, where `createMemo` would freeze at its first value.
  const turns = (): readonly Turn[] => analysis()?.turns ?? [];

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

  async function fetchReviewPrompt(): Promise<ReviewPromptOutcome> {
    const target = sessionID().trim();
    if (target.length === 0) {
      return { ok: false, error: "No session is selected." };
    }
    try {
      const response = await rpc.export({
        sessionID: target,
        format: "digest",
        prompt: true,
      });
      return parseReviewPromptResponse(response, target);
    } catch {
      return {
        ok: false,
        error: "The review prompt could not be generated.",
      };
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
    fetchReviewPrompt,
  };
}
