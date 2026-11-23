/**
 * Export, copy and toast copy: the pure half of the Phase 6 actions.
 *
 * The identity of the target and the shape of the request are the Snyk
 * contracts (`issue #56`, `#81`): the selected id arrives from the document
 * location (`#/s/<id>/...`), so it is only ever a *lookup key*. The record the
 * request targets comes back from the server's own session list, and a session
 * that list does not carry aborts the operation with a toast.
 *
 * The filename is built from that same record — title, then slug, then the shared
 * `session` fallback — and the client clock, never from the response header or the
 * document location. `slugify` and `timestampForFilename` are imported from
 * `src/core/format.ts`; nothing about the name alphabet is mirrored here.
 *
 * The clipboard and the download anchor are DOM sinks, so they live in
 * `hooks/useExport.ts`; everything below is DOM-free and unit tested.
 */

import type { EventIndexEntry, NormalizedEvent, SessionMeta } from "../../core/types.ts";
import { slugify, timestampForFilename } from "../../core/format.ts";

/** The three downloadable formats, in the menu's order (`copy.ts:40-45`). */
export const EXPORT_FORMATS = Object.freeze(["json", "markdown", "html"] as const);
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The export request's `format` vocabulary, including the two copy formats. */
export type ExportRequestFormat = ExportFormat | "digest";

export interface ExportRequestOptions {
  format: ExportRequestFormat;
  reveal?: boolean;
  prompt?: boolean;
  includeEvents?: boolean;
}

/**
 * Relative request target for a session export (`app.js:2955-2964`). No origin
 * and no document location: the UI and `/api` share one, so a root-relative path
 * resolves exactly as an origin-anchored URL did.
 */
export function exportRequestPath(
  sessionID: string,
  options: ExportRequestOptions,
): string {
  const params = new URLSearchParams({ format: options.format });
  if (options.includeEvents) params.set("includeEvents", "1");
  if (options.prompt) params.set("prompt", "1");
  if (options.reveal) params.set("reveal", "1");
  return `/api/sessions/${encodeURIComponent(sessionID)}/export?${params.toString()}`;
}

/** The extension the download carries; Markdown is `.md`, not `.markdown`. */
export function exportExtension(format: ExportFormat): string {
  return format === "markdown" ? "md" : format;
}

/**
 * The download name for an export (`app.js:2914-2918`), built entirely
 * client-side as `<slug>-<stamp>.<ext>`. The stamp comes from the client clock
 * while the server stamps the analysis timestamp; the difference is deliberate,
 * so no response data sits upstream of the download anchor.
 */
export function exportFilename(
  displayName: string | null | undefined,
  format: ExportFormat,
  now: Date = new Date(),
): string {
  return `${slugify(displayName ?? "")}-${timestampForFilename(now.getTime())}.${exportExtension(format)}`;
}

/**
 * The name for a session export, taken from the server-provided record: its
 * title, then its slug, then the constant `session` fallback. The session id is
 * deliberately never a candidate (Snyk alert 1 / issue #56).
 */
export function sessionExportName(
  record: Pick<SessionMeta, "title" | "slug"> | null | undefined,
  format: ExportFormat,
  now: Date = new Date(),
): string {
  return exportFilename(record?.title ?? record?.slug ?? "", format, now);
}

/**
 * The one filename alphabet the download anchor accepts (`format.js:200-225`),
 * covering every name the export route produces and nothing else: separators,
 * quotes, control characters and markup fall back instead.
 */
const DOWNLOAD_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** The name a non-conforming download falls back to. */
export const DEFAULT_DOWNLOAD_NAME = "download";

/**
 * Normalizes a download name to the anchor's alphabet. Beyond the allowlist the
 * structural checks reject a trailing dot and any interior `..`, so a name can
 * never read as a relative path.
 */
export function safeDownloadName(
  name: unknown,
  fallback: string = DEFAULT_DOWNLOAD_NAME,
): string {
  if (typeof name !== "string") return fallback;
  if (!DOWNLOAD_FILENAME.test(name)) return fallback;
  if (name.endsWith(".") || name.includes("..")) return fallback;
  return name;
}

/** True when the name the sink would accept is this name. */
export function isSafeDownloadName(name: unknown): boolean {
  return safeDownloadName(name) === name;
}

/** Shown when the selected session is not in the loaded or refreshed list. */
export const EXPORT_SESSION_MISSING =
  "Session is not among the loaded sessions — it may be older than the most recent ones.";

/** The server record fields an export names itself from. */
export interface ExportRecord {
  id: string;
  title?: string;
  slug?: string;
}

export interface ExportTarget {
  /** The id to put in the request path; there is deliberately no fallback. */
  id: string;
  record: ExportRecord;
}

export interface ResolveExportTargetOptions {
  sessions: readonly ExportRecord[];
  /** Re-reads the unfiltered session list at the server's maximum depth. */
  refresh(): Promise<readonly ExportRecord[]>;
  notify(message: string): void;
}

/**
 * Resolves the target an export or digest request may use (`app.js:3005-3025`):
 * the matching record from the `/api/sessions` list, plus the id to put in the
 * request path. `sourceID` is only a lookup key; a session the server does not
 * return aborts the operation. A falsy `sourceID` returns `null` without
 * notifying or refreshing.
 */
export async function resolveExportTarget(
  sourceID: string | null | undefined,
  options: ResolveExportTargetOptions,
): Promise<ExportTarget | null> {
  if (!sourceID) return null;
  const lookup = (list: readonly ExportRecord[] | null | undefined): ExportRecord | null => {
    if (!Array.isArray(list)) return null;
    return list.find((session) => session.id === sourceID) ?? null;
  };
  let record = lookup(options.sessions);
  if (!record) record = lookup(await options.refresh());
  if (!record) {
    options.notify(EXPORT_SESSION_MISSING);
    return null;
  }
  return { id: record.id, record };
}

// ---------------------------------------------------------------------------
// Toast copy
// ---------------------------------------------------------------------------

/** The toast's auto-dismiss delay (`app.js:370-372`). */
export const TOAST_MS = 2_400;

/**
 * The one toast vocabulary. Every string is the legacy string verbatim: short,
 * sentence case, and without a trailing period unless it is a full sentence
 * (the reveal-disabled and export-target misses keep theirs).
 */
export const TOAST = Object.freeze({
  copied: "Copied",
  copyFailed: "Copy failed",
  metricsCopied: "Metrics copied",
  turnChainCopied: "Turn chain copied",
  noTurnAttribution: "This event has no turn attribution.",
  clipboardBlocked: "Copy failed — the browser blocked the clipboard",
  exportedRedacted: "Exported (credentials redacted)",
  exportedUnredacted: "Exported with raw secrets",
  revealDisabled: "Reveal is disabled by the server (start it with --reveal).",
  exportSessionMissing: EXPORT_SESSION_MISSING,
});

/** Shown before copying while reveal is active (`digestCopy.js:13-18`). */
export const REVEAL_COPY_WARNING = Object.freeze({
  title: "Copy unredacted review material?",
  message:
    "Reveal is active, so API keys, tokens and credentials may appear in the copied text and on your clipboard. Treat the clipboard as sensitive and turn reveal off when you are finished.",
  acceptLabel: "Copy unredacted",
});

/** The reveal confirmation (`app.js:3128-3133`). */
export const REVEAL_CONFIRM = Object.freeze({
  title: "Reveal raw payloads?",
  message:
    "API keys, tokens and credentials may appear on screen and in exports. Turn reveal off when you are finished.",
  acceptLabel: "Reveal secrets",
});

/** The persistent banner while reveal is on (`index.html:64`). Body text stays ink. */
export const REVEAL_BANNER = "Secrets are visible. Do not share this screen or its exports.";

/** The copy confirmation for the digest actions (`digestCopy.js:21-26`). */
export function digestToastMessage(prompt: boolean, reveal: boolean): string {
  const subject = prompt ? "Review prompt" : "Session digest";
  return reveal
    ? `${subject} copied (unredacted — contains secrets)`
    : `${subject} copied (credentials redacted)`;
}

/** The export confirmation, honest about the redaction state (`app.js:3062-3066`). */
export function exportToastMessage(reveal: boolean): string {
  return reveal ? TOAST.exportedUnredacted : TOAST.exportedRedacted;
}

/** `format === "digest"` names the two copy formats for the UI. */
export function copySubject(prompt: boolean): string {
  return prompt ? "Review prompt" : "Session digest";
}

// ---------------------------------------------------------------------------
// Drawer copy builders
// ---------------------------------------------------------------------------

/**
 * The tab-separated metrics line the drawer copies (`app.js:2813-2840`).
 * `prompt` is `input + cacheRead + cacheWrite`, the documented prompt total.
 */
export function metricsLine(event: NormalizedEvent | null | undefined): string {
  if (!event) return "";
  const tokens = event.tokens;
  const prompt = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null;
  return [
    `event=${event.id}`,
    `turn=${event.turnID ?? ""}`,
    `step=${event.stepID ?? ""}`,
    `kind=${event.kind}`,
    `status=${event.status ?? ""}`,
    `prompt=${prompt ?? ""}`,
    `input=${tokens?.input ?? ""}`,
    `output=${tokens?.output ?? ""}`,
    `reasoning=${tokens?.reasoning ?? ""}`,
    `cache_read=${tokens?.cacheRead ?? ""}`,
    `cache_write=${tokens?.cacheWrite ?? ""}`,
    `cost=${event.cost ?? ""}`,
    `duration_ms=${
      event.endTimestamp !== null && event.endTimestamp !== undefined
        ? event.endTimestamp - event.timestamp
        : ""
    }`,
  ].join("\t");
}

/** `HH:mm:ss.SSS` in UTC, the turn-chain line's leading column. */
function timeOfDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23);
}

/**
 * The turn-chain text: one line per event of the event's turn, in recorded
 * order (`app.js:2848-2861`). Returns `null` when the event has no turn
 * attribution, which the caller reports instead of copying.
 */
export function turnChainText(
  event: Pick<NormalizedEvent, "turnID"> | null | undefined,
  events: readonly EventIndexEntry[],
): string | null {
  if (!event || !event.turnID) return null;
  return events
    .filter((item) => item.turnID === event.turnID)
    .map((item) =>
      [
        timeOfDay(item.timestamp),
        item.kind,
        item.title,
        item.status ?? "",
        item.toolName ?? "",
        item.preview ?? "",
      ].join("\t"),
    )
    .join("\n");
}
