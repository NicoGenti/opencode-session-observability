/**
 * The number and time formatters the sidebar needs, copied verbatim from
 * `src/ui/format.js` so the React UI and its legacy predecessor print the same
 * strings. The rest of that module is view-specific and lands with its view.
 */

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return numberFormat.format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function formatDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Date(value).toISOString();
}

/** `HH:mm:ss.SSS` in UTC, the ledger gutter stamp (`format.js:61-64`). */
export function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Date(value).toISOString().slice(11, 23);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  if (abs < 1_000) return `${Math.round(ms)} ms`;
  if (abs < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  if (abs < 3_600_000) {
    const minutes = Math.floor(abs / 60_000);
    const seconds = Math.round((abs % 60_000) / 1_000);
    return `${ms < 0 ? "-" : ""}${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.round((abs % 3_600_000) / 60_000);
  return `${ms < 0 ? "-" : ""}${hours}h ${minutes}m`;
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export interface ModelRefLike {
  providerID: string;
  id: string;
  variant?: string;
}

/** `provider/id[#variant]`, as `modelLabel()` prints it. */
export function modelLabel(model: ModelRefLike | null | undefined): string {
  if (!model) return "—";
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

export function formatRelative(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const diff = Date.now() - value;
  if (diff < 0) return formatDateTime(value);
  const seconds = Math.round(diff / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
