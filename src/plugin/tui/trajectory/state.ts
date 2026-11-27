import { createSignal, untrack, type Accessor } from "solid-js";
import type { OpenCodeClient } from "@opencode/client";

import type { Analysis, Turn } from "../../../core/types.ts";
import { Observability } from "../../rpc.ts";
import { parseAnalysisResponse } from "../analysisResponse.ts";
import { isSettledAnalysis } from "../polling.ts";
import { clampIndex, moveSelection } from "../statistics/state.ts";
import { LIVE_POLL_MS } from "../statistics/state.ts";

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
  /** Starts the 5 s re-fetch used while the view is open. */
  startLivePolling(sessionID: string): void;
  /** Clears the poll timer. Safe to call when nothing is polling. */
  stopLivePolling(): void;
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
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let liveTarget = "";
  let liveInFlight = false;

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

    // The compute phase of the calling effect tracks only `props.sessionID`, so
    // this call already runs untracked; `untrack` stays as belt and braces for
    // the live-poll path, which is not owned by a tracked effect. A tracked read
    // would otherwise subscribe the caller to the `setSessionID` write below and
    // issue a second request per open/session change.
    //
    // Staged writes: signals expose the committed value, so the read below only
    // sees a `setSessionID` after the microtask that applies it. Two
    // `fetchAnalysis` calls in the same frame would therefore compare against a
    // stale value, report `sameSession === false` and blank the turn table. Not
    // reachable today: the live poll is a macrotask timer, so each tick starts
    // after the previous frame committed.
    const previous = untrack(sessionID);
    const sameSession = target === previous;
    if (!sameSession) {
      // Written signal-level rather than through `setSelectedIndex`, which
      // reads `turns()` and would re-subscribe the effect to the response.
      setSelectedIndexSignal(0);
      setExpandedTurns(new Set<string>());
    }
    setSessionID(target);
    // A same-session live poll keeps the previous frame until the response
    // lands; a session change must not show the old session's turn table.
    if (!sameSession) setAnalysis(null);
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
        // Same policy as the catch branch: a malformed live response keeps the
        // last good frame when it belongs to the session on screen.
        if (!sameSession) setAnalysis(null);
        setError(parsed.message);
        return;
      }
      reconcile(parsed.analysis);
      setAnalysis(parsed.analysis);
    } catch {
      if (ticket !== request) return;
      // Keep the last good frame on a failed live poll; only a fresh session
      // falls back to the error state.
      if (!sameSession) setAnalysis(null);
      setError("The analysis could not be loaded. Reopen the panel to retry.");
    } finally {
      if (ticket === request) setLoading(false);
    }
  }

  /** Clears the live poll timer and its in-flight guard. */
  function stopLivePolling(): void {
    if (liveTimer !== null) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    liveTarget = "";
    liveInFlight = false;
  }

  /**
   * Re-fetches the current analysis every `LIVE_POLL_MS` while the panel is
   * open. The RPC is the existing `analysis` one — no new surface — and one
   * request at a time keeps a slow host from piling up polls. A settled
   * session (terminal outcome, nothing busy, no running turn) stops the timer:
   * there is nothing left to re-fetch.
   */
  function startLivePolling(nextSessionID: string): void {
    stopLivePolling();
    const target =
      typeof nextSessionID === "string" ? nextSessionID.trim() : "";
    if (target.length === 0) return;
    liveTarget = target;
    liveTimer = setInterval(() => {
      if (liveInFlight) return;
      liveInFlight = true;
      void fetchAnalysis(liveTarget).finally(() => {
        liveInFlight = false;
        if (isSettledAnalysis(analysis())) stopLivePolling();
      });
    }, LIVE_POLL_MS);
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
    startLivePolling,
    stopLivePolling,
  };
}
