/**
 * The live-mode decisions, a pure port of `src/ui/live.js:100-156` plus the
 * badge vocabulary (`:31-98`).
 *
 * Nothing here touches a document, a timer or the network: the poll loop
 * (`hooks/useLivePoll.ts`) wires these helpers to state, and the badge and
 * warning components only render what the snapshot already carries. The
 * snapshot comes from `GET /api/sessions/:id/live`; no value is re-derived here.
 *
 * Colour never carries state: every badge variant keeps its sentence-case text,
 * and the warning tint is a border/background only.
 */

import type { EventIndexEntry } from "../../core/types.ts";
import type { LiveSnapshot, LiveState } from "../../core/live.ts";

/** The poll cadence the web UI uses while the Live toggle is on (`live.js:23`). */
export const LIVE_POLL_MS = 5_000;

/** Mirrors the core cap so a hostile payload cannot grow the row (`live.js:26`). */
export const MAX_LIVE_EVENT_LINKS = 10;

/** Longest poll-error detail echoed into the stale/unavailable marker. */
export const MAX_ERROR_DETAIL = 90;

export type LiveBadgeKind = "live" | "incomplete" | "historical" | "unavailable";

export interface LiveBadgeView {
  label: string;
  kind: LiveBadgeKind;
}

/** The four documented readings (`live.js:31-36`, `live.js:93-98`). */
export const BADGE_VIEWS: Readonly<Record<LiveState, LiveBadgeView>> = Object.freeze({
  running: Object.freeze({ label: "Live — recording", kind: "live" }),
  idle: Object.freeze({
    label: "Incomplete — no terminal outcome",
    kind: "incomplete",
  }),
  unknown: Object.freeze({
    label: "Incomplete — no terminal outcome",
    kind: "incomplete",
  }),
  ended: Object.freeze({
    label: "Historical — recording complete",
    kind: "historical",
  }),
});

export const LIVE_UNAVAILABLE_VIEW: LiveBadgeView = Object.freeze({
  label: "Live unavailable",
  kind: "unavailable",
});

/** The badge tooltip the legacy markup carried on the chip. */
export const LIVE_BADGE_TITLE = "Derived from recorded observability data.";

/** The stale frame marker's standing text, before any poll error is appended. */
export const LIVE_STALE_LABEL = "stale, retrying";

/** The `aria-live` container's two standing lines (`live.js:222-227`). */
export const LIVE_WARNINGS_TITLE = "Live warnings";
export const LIVE_WARNINGS_BASIS = "derived · session in progress";
export const LIVE_WARNINGS_NOTE =
  "Re-evaluated on every poll from the recorded health rules; never persisted or exported.";

/** The row status word; a triggered rule is always reported as this. */
export const LIVE_WARNING_STATUS = "Triggered";

/**
 * Collapses whitespace and caps a server message so a marker stays one line
 * (`live.js:40-46`). Ported verbatim, including the `…` truncation.
 */
export function liveErrorDetail(value: unknown): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_ERROR_DETAIL) return flat;
  return `${flat.slice(0, MAX_ERROR_DETAIL - 1)}…`;
}

/** The reading for one snapshot, with `unknown` as the incomplete fallback. */
export function liveBadgeView(
  snapshot: { state?: unknown } | null | undefined,
): LiveBadgeView {
  const state = snapshot?.state;
  if (state === "running" || state === "idle" || state === "ended" || state === "unknown") {
    return BADGE_VIEWS[state];
  }
  return BADGE_VIEWS.unknown;
}

/** `+N events`, or `null` when the cursor picked up nothing (`live.js:49-55`). */
export function newEventsLabel(newEvents: unknown): string | null {
  if (!Array.isArray(newEvents) || newEvents.length === 0) return null;
  const count = newEvents.length;
  return `+${count} event${count === 1 ? "" : "s"}`;
}

/** The stale marker text: standing words, then the escaped detail (`live.js:81-86`). */
export function liveStaleText(error?: unknown): string {
  const detail = liveErrorDetail(error);
  return detail ? `${LIVE_STALE_LABEL} — ${detail}` : LIVE_STALE_LABEL;
}

/** The unavailable basis: `poll failed`, then the detail (`live.js:93-98`). */
export function liveUnavailableText(error?: unknown): string {
  const detail = liveErrorDetail(error);
  return detail ? `poll failed — ${detail}` : "poll failed";
}

/** A snapshot kept after a failed poll: `stale`, plus the collapsed detail. */
export type LiveFrame = LiveSnapshot & {
  stale?: boolean;
  staleError?: string;
};

/**
 * Whether a snapshot justifies the heavy refresh pass (`live.js:105-114`): a
 * new or closed open turn, a different recorded event count, or a moved
 * liveness state. The first tick only establishes the frame (`previous` null).
 */
export function shouldHeavyRefresh(
  previous: LiveFrame | null | undefined,
  next: LiveFrame | null | undefined,
): boolean {
  if (!previous || !next) return false;
  const previousOpen = previous.openTurn?.id ?? null;
  const nextOpen = next.openTurn?.id ?? null;
  return (
    previousOpen !== nextOpen ||
    (next.totalInSession ?? 0) !== (previous.totalInSession ?? 0) ||
    next.state !== previous.state
  );
}

/**
 * Advances the `since` cursor to the last new event; an empty page keeps the
 * cursor where it was (`live.js:120-132`). Malformed entries are skipped.
 */
export function nextLiveCursor(
  previousCursor: string | null | undefined,
  newEvents: unknown,
): string | null {
  const cursor =
    typeof previousCursor === "string" && previousCursor.length > 0
      ? previousCursor
      : null;
  if (Array.isArray(newEvents)) {
    for (let index = newEvents.length - 1; index >= 0; index -= 1) {
      const candidate = newEvents[index] as { orderKey?: unknown } | null | undefined;
      const orderKey = candidate?.orderKey;
      if (typeof orderKey === "string" && orderKey.length > 0) return orderKey;
    }
  }
  return cursor;
}

/**
 * The cursor sent to the next poll (`live.js:4038-4043`): the tracked cursor,
 * else the last event of the live frame, else the last event of the loaded
 * analysis. Preferring the frame keeps a long-running panel from re-reading an
 * analysis it does not own.
 */
export function liveSinceCursor(
  trackedCursor: string | null | undefined,
  frame: { newEvents?: EventIndexEntry[] | null } | null | undefined,
  lastSeenOrderKey: string | null | undefined,
): string | null {
  if (typeof trackedCursor === "string" && trackedCursor.length > 0) {
    return trackedCursor;
  }
  return nextLiveCursor(null, frame?.newEvents) ?? (lastSeenOrderKey ?? null);
}

/**
 * Keeps the previous frame on a failed poll and marks it stale (`live.js:139-147`).
 * Returns `null` when there is no frame to keep, the caller's signal to render
 * the "Live unavailable" reading instead of an empty slot.
 */
export function withStaleMarker(
  previous: LiveFrame | null | undefined,
  message: unknown,
): LiveFrame | null {
  if (!previous || typeof previous !== "object") return null;
  const detail = liveErrorDetail(message);
  return {
    ...previous,
    stale: true,
    ...(detail ? { staleError: detail } : {}),
  };
}

/**
 * Compare-and-skip gate for the warning region (`live.js:154-156`). The
 * container is an `aria-live` region and is re-evaluated on every poll, so an
 * unchanged rule set is left in place instead of being announced again.
 */
export function shouldReplaceLiveWarnings(
  previousMarkup: string | null | undefined,
  nextMarkup: string,
): boolean {
  return previousMarkup !== nextMarkup;
}

/**
 * A stable identity for one warning set. The poller compares it through
 * `shouldReplaceLiveWarnings`, so an unchanged rule set keeps the previous array
 * reference and React does not re-render (announce) the region.
 */
export function liveWarningsSignature(warnings: unknown): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  const rows = warnings.map((warning) => {
    const record =
      warning && typeof warning === "object"
        ? (warning as Record<string, unknown>)
        : {};
    return [
      typeof record.id === "string" ? record.id : "",
      typeof record.level === "string" ? record.level : "",
      typeof record.label === "string" ? record.label : "",
      typeof record.note === "string" ? record.note : "",
      Array.isArray(record.eventIDs)
        ? record.eventIDs.filter((id) => typeof id === "string").join(",")
        : "",
    ].join("\u0001");
  });
  return rows.join("\u0000");
}

/**
 * The capped, de-duplicated evidence ids for one warning (`live.js:158-168`).
 */
export function cappedEventIDs(warning: { eventIDs?: unknown } | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const ids = Array.isArray(warning?.eventIDs) ? warning.eventIDs : [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_LIVE_EVENT_LINKS) break;
  }
  return out;
}

/** The accessible name of one evidence button (`live.js:176-181`). */
export function eventLinkLabel(position: number): string {
  return `Open event ${position + 1} in Trajectory`;
}

/** A warning row's level, restricted to the two rendered kinds (`live.js:186-195`). */
export function liveWarningLevel(level: unknown): "watch" | "strong" | null {
  return level === "watch" || level === "strong" ? level : null;
}
