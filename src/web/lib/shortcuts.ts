/**
 * The documented keyboard model (`docs/UI.md:296-326`) as a pure decision
 * function. DOM-free on purpose: the listener lives in
 * `hooks/useKeyboardShortcuts.ts`, so this table can be exercised directly by
 * the test runner.
 *
 * Decision order matches `onKeyDown` in `src/ui/app.js:4449-4614`:
 *
 * 1. an open dialog or drawer swallows every shortcut (Radix owns Esc/Tab);
 *    the Shortcuts dialog itself still closes on `?`;
 * 2. `Esc` closes the mobile sidebar;
 * 3. anything typed into an input, textarea, select or contenteditable is left
 *    alone;
 * 4. `?`, `/`, `1`, `2`, `e`, `t`, `c`, `r`, `s`, `j`, `k`, `Enter`, `g`, `G`.
 *
 * Deliberate legacy parity: modifiers are not filtered, so `Ctrl`-combinations
 * behave exactly as they did before (the browser still owns its own shortcuts
 * because `preventDefault` is only called where legacy called it).
 */

import type { RouteView, SessionView } from "./hash.ts";

export type ShortcutTarget =
  | "input"
  | "textarea"
  | "select"
  | "contenteditable"
  | "other";

export type ShortcutOverlay = "dialog" | "shortcuts" | "drawer" | null;

export interface ShortcutState {
  view: RouteView;
  target: ShortcutTarget;
  overlay: ShortcutOverlay;
  /** The ledger cursor, or -1 when nothing is selected (Phase 3 supplies it). */
  selectedIndex: number;
  eventCount: number;
}

export type FilterShortcutKey =
  | "errorsOnly"
  | "compactionsOnly"
  | "retriesOnly"
  | "subagentsOnly"
  | "tools";

export type ShortcutCommand =
  | { type: "close-sidebar"; preventDefault: false }
  | { type: "toggle-shortcuts"; preventDefault: true }
  | { type: "close-shortcuts"; preventDefault: true }
  | { type: "focus-search"; preventDefault: true }
  | { type: "set-view"; view: SessionView; preventDefault: false }
  | { type: "toggle-filter"; filter: FilterShortcutKey; preventDefault: false }
  | { type: "select-event"; index: number; preventDefault: true }
  | { type: "open-selected"; preventDefault: false }
  | { type: "scroll"; to: "top" | "bottom"; preventDefault: false };

export interface ShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

const FILTER_KEYS: Record<string, FilterShortcutKey> = {
  e: "errorsOnly",
  c: "compactionsOnly",
  r: "retriesOnly",
  s: "subagentsOnly",
};

export function resolveShortcut(
  event: ShortcutEvent,
  state: ShortcutState,
): ShortcutCommand | null {
  if (state.overlay === "shortcuts") {
    return event.key === "?"
      ? { type: "close-shortcuts", preventDefault: true }
      : null;
  }
  if (state.overlay === "dialog" || state.overlay === "drawer") return null;

  if (event.key === "Escape") {
    return { type: "close-sidebar", preventDefault: false };
  }
  if (state.target !== "other") return null;

  if (event.key === "?") return { type: "toggle-shortcuts", preventDefault: true };
  if (event.key === "/") return { type: "focus-search", preventDefault: true };
  if (event.key === "1") return { type: "set-view", view: "trajectory", preventDefault: false };
  if (event.key === "2") return { type: "set-view", view: "statistics", preventDefault: false };

  const filter = FILTER_KEYS[event.key];
  if (filter) return { type: "toggle-filter", filter, preventDefault: false };
  if (event.key === "t") return { type: "toggle-filter", filter: "tools", preventDefault: false };

  if (state.view === "trajectory") {
    if (event.key === "j" || event.key === "k") {
      const index =
        event.key === "j"
          ? Math.min(state.eventCount - 1, state.selectedIndex + 1)
          : Math.max(0, state.selectedIndex - 1);
      if (index < 0 || index >= state.eventCount) return null;
      return { type: "select-event", index, preventDefault: true };
    }
    if (event.key === "g") return { type: "scroll", to: "top", preventDefault: false };
    if (event.key === "G") return { type: "scroll", to: "bottom", preventDefault: false };
  }

  if (
    event.key === "Enter" &&
    state.eventCount > 0 &&
    state.selectedIndex >= 0 &&
    state.selectedIndex < state.eventCount
  ) {
    return { type: "open-selected", preventDefault: false };
  }
  return null;
}

/** The filter state the shortcut keys toggle; Phase 3 renders the chips. */
export interface FilterToggles {
  errorsOnly: boolean;
  compactionsOnly: boolean;
  retriesOnly: boolean;
  subagentsOnly: boolean;
  /** The kind filter: `t` toggles `["tool"]` exactly as legacy did. */
  kinds: readonly string[];
}

export const EMPTY_FILTER_TOGGLES: FilterToggles = Object.freeze({
  errorsOnly: false,
  compactionsOnly: false,
  retriesOnly: false,
  subagentsOnly: false,
  kinds: [],
});

export function applyFilterShortcut(
  filters: FilterToggles,
  key: FilterShortcutKey,
): FilterToggles {
  if (key === "tools") {
    const active = filters.kinds.length === 1 && filters.kinds[0] === "tool";
    return { ...filters, kinds: active ? [] : ["tool"] };
  }
  return { ...filters, [key]: !filters[key] };
}

const FILTER_LABELS: ReadonlyArray<readonly [FilterShortcutKey, string]> = [
  ["errorsOnly", "Errors only"],
  ["tools", "Tool calls"],
  ["compactionsOnly", "Compactions"],
  ["retriesOnly", "Retries"],
  ["subagentsOnly", "Subagents"],
];

/** The active toggles, in the documented chip order, for quiet status copy. */
export function activeFilterLabels(filters: FilterToggles): string[] {
  const labels: string[] = [];
  for (const [key, label] of FILTER_LABELS) {
    if (key === "tools") {
      if (filters.kinds.length === 1 && filters.kinds[0] === "tool") labels.push(label);
    } else if (filters[key]) {
      labels.push(label);
    }
  }
  return labels;
}
