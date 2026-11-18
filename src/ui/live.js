/**
 * Live-mode renderers and poll decisions: the liveness badge, the live warning
 * rows and the DOM-free helpers the poll loop runs on.
 *
 * DOM-free string builders in the same shape as `health.js`: they consume the
 * stored `LiveSnapshot` DTO and return escaped markup. Nothing is re-derived
 * here — the snapshot comes from `GET /api/sessions/:id/live` — and no request
 * is made. The only import is `./format.js`, so the module stays plain browser
 * ESM with no build step.
 *
 * The poll decisions (`shouldHeavyRefresh`, `nextLiveCursor`,
 * `withStaleMarker`, `shouldReplaceLiveWarnings`) are pure so they can be unit
 * tested without a browser; `app.js` only wires them to state and the DOM.
 *
 * Colour never carries state: every badge variant keeps its sentence-case
 * text, warning rows mirror the `.health-rule` rhythm, and the warning tint is
 * a border/background only.
 */

import { escapeAttr, escapeHtml, formatDateTime } from "./format.js";

/** The poll cadence the web UI uses while the Live toggle is on. */
export const LIVE_POLL_MS = 5_000;

/** Mirrors the core cap so a hostile payload cannot grow the row. */
export const MAX_LIVE_EVENT_LINKS = 10;

/** Longest poll-error detail echoed into the stale/unavailable marker. */
const MAX_ERROR_DETAIL = 90;

const BADGE_VIEWS = Object.freeze({
  running: { label: "Live — recording", kind: "live" },
  idle: { label: "Incomplete — no terminal outcome", kind: "incomplete" },
  unknown: { label: "Incomplete — no terminal outcome", kind: "incomplete" },
  ended: { label: "Historical — recording complete", kind: "historical" },
});

const STANDING_COPY = "Derived from recorded observability data.";

/** Collapses whitespace and caps a server message so a marker stays one line. */
function shortText(value) {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_ERROR_DETAIL) return flat;
  return `${flat.slice(0, MAX_ERROR_DETAIL - 1)}…`;
}

/** `+N events` affordance: how much the `since` cursor picked up. */
function newEventsHtml(newEvents) {
  if (!Array.isArray(newEvents) || newEvents.length === 0) return "";
  const count = newEvents.length;
  return `<span class="live-new-events" title="Events recorded since the last poll">+${count} event${
    count === 1 ? "" : "s"
  }</span>`;
}

/**
 * Liveness badge for the session header. `state` distinguishes the three
 * documented readings; `asOf` and the `derived` basis stay visible next to it.
 * The `since` cursor is user-meaningful only when its yield is rendered, so the
 * new-event count rides in the same badge.
 */
export function liveBadgeHtml(snapshot) {
  const view = BADGE_VIEWS[snapshot?.state] ?? BADGE_VIEWS.unknown;
  const stale =
    snapshot?.stale === true ? liveStaleHtml(snapshot?.staleError) : "";
  return `<span class="live-badge live-badge-${view.kind}" title="${escapeAttr(
    STANDING_COPY,
  )}"><span class="live-badge-state">${escapeHtml(
    view.label,
  )}</span><span class="live-badge-basis">derived · as of ${escapeHtml(
    formatDateTime(snapshot?.asOf),
  )}</span>${newEventsHtml(snapshot?.newEvents)}${stale}</span>`;
}

/**
 * The stale frame marker: the previous snapshot is kept while a poll retries.
 * The poll error is rendered (escaped, collapsed, capped) instead of being
 * carried as an unread field.
 */
export function liveStaleHtml(error) {
  const detail = shortText(error);
  return `<span class="live-stale" role="status">stale, retrying${
    detail ? ` — ${escapeHtml(detail)}` : ""
  }</span>`;
}

/**
 * No frame exists yet and the poll failed: without this the first-poll failure
 * is silent. Not `role="status"`: the marker is re-rendered on every failed
 * attempt and a live region here would announce each retry.
 */
export function liveUnavailableHtml(error) {
  const detail = shortText(error);
  return `<span class="live-badge live-badge-unavailable"><span class="live-badge-state">Live unavailable</span><span class="live-badge-basis">poll failed${
    detail ? ` — ${escapeHtml(detail)}` : ""
  }</span></span>`;
}

/**
 * Whether a snapshot justifies the heavy `refreshCurrent()` pass: a new or
 * closed open turn, a different recorded event count, or a moved liveness
 * state. The first tick only establishes the frame (`previous` is null).
 */
export function shouldHeavyRefresh(previous, next) {
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
 * cursor where it was. Malformed entries are skipped, never trusted.
 */
export function nextLiveCursor(previousCursor, newEvents) {
  const cursor =
    typeof previousCursor === "string" && previousCursor.length > 0
      ? previousCursor
      : null;
  if (Array.isArray(newEvents)) {
    for (let index = newEvents.length - 1; index >= 0; index -= 1) {
      const orderKey = newEvents[index]?.orderKey;
      if (typeof orderKey === "string" && orderKey.length > 0) return orderKey;
    }
  }
  return cursor;
}

/**
 * Keeps the previous frame on a failed poll and marks it stale. Returns `null`
 * when there is no frame to keep, which is the caller's signal to render the
 * "Live unavailable" reading instead of an empty slot.
 */
export function withStaleMarker(previous, message) {
  if (!previous || typeof previous !== "object") return null;
  const detail = shortText(message);
  return {
    ...previous,
    stale: true,
    ...(detail ? { staleError: detail } : {}),
  };
}

/**
 * Compare-and-skip gate for the warning container. The container is an
 * `aria-live` region and is re-rendered on every poll, so identical markup is
 * left in place instead of being announced again.
 */
export function shouldReplaceLiveWarnings(previousMarkup, nextMarkup) {
  return previousMarkup !== nextMarkup;
}

function cappedEventIDs(warning) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(warning?.eventIDs) ? warning.eventIDs : []) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_LIVE_EVENT_LINKS) break;
  }
  return out;
}

function warningLinksHtml(warning) {
  const ids = cappedEventIDs(warning);
  if (ids.length === 0) return "";
  const links = ids
    .map(
      (eventID, position) =>
        `<button type="button" class="link-button health-rule-link" data-event-id="${escapeAttr(
          eventID,
        )}" aria-label="${escapeAttr(
          `Open event ${position + 1} in Trajectory`,
        )}">Event ${position + 1}</button>`,
    )
    .join("");
  return `<div class="health-rule-links">${links}</div>`;
}

function warningRowHtml(warning) {
  const level =
    warning?.level === "watch" || warning?.level === "strong"
      ? warning.level
      : null;
  const levelBadge = level
    ? `<span class="health-level health-level-${level}">${escapeHtml(
        level,
      )}</span>`
    : "";
  return `<li class="health-rule live-warning">
      <div class="health-rule-head">
        <span class="health-rule-label">${escapeHtml(
          warning?.label ?? "Rule",
        )}</span>
        ${levelBadge}
        <span class="health-rule-status">Triggered</span>
        <span class="grow"></span>
        ${warningLinksHtml(warning)}
      </div>
      <p class="small muted health-rule-note">${escapeHtml(
        warning?.note ?? "",
      )}</p>
    </li>`;
}

/**
 * The warning list rendered above the active pane. An empty list renders
 * nothing, so the container can stay present and be hidden by the caller.
 */
export function liveWarningsHtml(warnings) {
  const rows = Array.isArray(warnings) ? warnings : [];
  if (rows.length === 0) return "";
  return `<section class="live-warnings-section" aria-label="Live warnings">
      <div class="live-warnings-head">
        <h2 class="live-warnings-title">Live warnings</h2>
        <span class="muted small">derived · session in progress</span>
      </div>
      <ul class="health-rules live-warnings-list">${rows
        .map(warningRowHtml)
        .join("")}</ul>
      <p class="small muted live-warnings-note">Re-evaluated on every poll from the recorded health rules; never persisted or exported.</p>
    </section>`;
}
