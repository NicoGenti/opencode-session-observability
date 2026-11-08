import type { Basis, Metric } from "./types.ts";

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

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

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString();
}

export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  return `${date.toISOString().slice(11, 23)}Z`;
}

export function metricText(
  metric: Metric,
  formatter: (value: number | null) => string,
): string {
  return formatter(metric.value);
}

export function basisLabel(basis: Basis): string {
  return basis === "unavailable" ? "n/a" : basis;
}

export function basisMark(basis: Basis): string {
  if (basis === "measured") return "M";
  if (basis === "derived") return "D";
  if (basis === "estimated") return "E";
  return "—";
}

export function slugify(value: string, max = 60): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "session";
}

export function timestampForFilename(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

/**
 * Escapes text interpolated into a Markdown line so it cannot open raw HTML
 * or a Markdown link/code span. Emphasis markers are left alone to keep
 * identifiers readable.
 */
export function escapeMarkdownInline(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/[`[\]<>&]/g, "\\$&")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function escapeMarkdownCell(value: string): string {
  return escapeMarkdownInline(value).replaceAll("|", "\\|");
}
