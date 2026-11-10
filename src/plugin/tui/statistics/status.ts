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
