import { createSignal, untrack, type Accessor } from "solid-js";
import type { OpenCodeClient } from "@opencode/client";

import type { Analysis, Turn } from "../../../core/types.ts";
import { Observability } from "../../rpc.ts";
import { parseAnalysisResponse } from "../analysisResponse.ts";
import { clampIndex, moveSelection } from "../statistics/state.ts";

/**
 * Reactive state for the native trajectory panel (issue #6, phase 2).
 *
 * The panel shows the same turn/step projections the statistics panel consumes;
 * only the KPI banner differs, so this module reuses the pure selection helpers
 * and the shared response parser instead of growing a second table model.
 *
 * One request is issued per call; the view calls `fetchAnalysis` only when the
 * panel opens or the selected session changes. `fetchAnalysis` never reads a
 * signal inside its synchronous window, so it cannot re-trigger the effect that
 * called it. Responses are validated because the payload crosses the RPC
 * boundary. Derived values are plain accessors rather than memos: each derives
 * from one signal, and a memo would freeze outside a Solid root (the Node test
 * suite).
 */

export interface TrajectoryState {
  readonly analysis: Accessor<Analysis | null>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  readonly sessionID: Accessor<string>;
  readonly selectedIndex: Accessor<number>;
  readonly expandedTurns: Accessor<ReadonlySet<string>>;
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
export interface TrajectoryKeyboardHandlers {
  readonly moveSelection: (delta: number) => void;
  readonly toggleExpand: () => void;
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
export interface TrajectoryKeyboardBridge {
  handlers: TrajectoryKeyboardHandlers | null;
  focused: boolean | null;
}

/** The SDK slice the trajectory state reads. */
export type TrajectoryRpcClient = Pick<OpenCodeClient, "rpc">;

export function createTrajectoryState(
  client: TrajectoryRpcClient,
): TrajectoryState {
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

  const turns = (): readonly Turn[] => analysis()?.turns ?? [];

  function setSelectedIndex(index: number): void {
    setSelectedIndexSignal(clampIndex(index, turns().length));
  }

  function moveSelectionBy(delta: number): void {
    setSelectedIndexSignal((current) =>
      moveSelection(current, delta, turns().length),
    );
  }

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
    turns,
    setSelectedIndex,
    moveSelection: moveSelectionBy,
    toggleTurnExpand,
    isSelected,
    fetchAnalysis,
  };
}
