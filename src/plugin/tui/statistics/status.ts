import type { TurnStatus } from "../../../core/types.ts";

/**
 * Terminal-safe status vocabulary for the native statistics view.
 *
 * Symbols come from the locked plan-card table and are always rendered next to
 * the palette key's color, so color is never the only signal. Palette keys map
 * to the ones emitted by `themePalette` in `src/plugin/tui.ts`.
 */

export type StatusPaletteKey =
  | "good"
  | "warning"
  | "critical"
  | "accent"
  | "text2"
  | "muted";

export interface StatusMark {
  /** Short, ASCII-only symbol shown in the dense table. */
  readonly symbol: string;
  /** Human label shown in the banner. */
  readonly label: string;
  /** Palette key resolved by the view. */
  readonly paletteKey: StatusPaletteKey;
}

const MARKS: Readonly<Record<TurnStatus, StatusMark>> = {
  completed: { symbol: "OK", label: "Completed", paletteKey: "good" },
  error: { symbol: "ERR", label: "Error", paletteKey: "critical" },
  interrupted: { symbol: "INT", label: "Interrupted", paletteKey: "warning" },
  running: { symbol: "RUN", label: "Running", paletteKey: "accent" },
  incomplete: { symbol: "INC", label: "Incomplete", paletteKey: "warning" },
  unknown: { symbol: "?", label: "Unknown", paletteKey: "muted" },
};

const FALLBACK: StatusMark = MARKS.unknown;

export function statusMark(status: TurnStatus): StatusMark {
  return MARKS[status] ?? FALLBACK;
}

export function statusSymbol(status: TurnStatus): string {
  return statusMark(status).symbol;
}

export function statusLabel(status: TurnStatus): string {
  return statusMark(status).label;
}

export function statusPaletteKey(status: TurnStatus): StatusPaletteKey {
  return statusMark(status).paletteKey;
}

/**
 * The statistics panel's recommendation count line.
 *
 * The number counts `severity: "advisory"` rows — the hypotheses — and names
 * that vocabulary so the line can never read as a score, a priority or a
 * ranking. Non-finite and negative input degrades to `0 advisory`; the panel
 * has no recommendation detail surface, the browser is the primary one.
 */
export function recommendationsStatusLine(count: number): string {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `Recommendations: ${value} advisory`;
}

/**
 * The statistics panel's guardrail count line.
 *
 * The TUI evaluates the pure module with `DEFAULT_GUARDRAILS` — browser-owned
 * thresholds are localStorage state and never cross the RPC — so the line names
 * the defaults. The count is the number of crossed budgets; there is no detail
 * surface here (the browser is the primary one) and the word "advisory" keeps
 * the line from reading as a block, a score or a priority. Non-finite and
 * negative input degrades to `0 advisory`.
 */
export function guardrailsStatusLine(count: number): string {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `Guardrails (defaults): ${value} advisory`;
}
