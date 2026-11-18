/**
 * Live-mode renderers: the liveness badge and the live warning rows.
 *
 * DOM-free string builders in the same shape as `health.js`: they consume the
 * stored `LiveSnapshot` DTO and return escaped markup. Nothing is re-derived
 * here — the snapshot comes from `GET /api/sessions/:id/live` — and no request
 * is made. The only import is `./format.js`, so the module stays plain browser
 * ESM with no build step.
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

const BADGE_VIEWS = Object.freeze({
  running: { label: "Live — recording", kind: "live" },
  idle: { label: "Incomplete — no terminal outcome", kind: "incomplete" },
  unknown: { label: "Incomplete — no terminal outcome", kind: "incomplete" },
  ended: { label: "Historical — recording complete", kind: "historical" },
});

const STANDING_COPY = "Derived from recorded observability data.";

/**
 * Liveness badge for the session header. `state` distinguishes the three
 * documented readings; `asOf` and the `derived` basis stay visible next to it.
 */
export function liveBadgeHtml(snapshot) {
  const view = BADGE_VIEWS[snapshot?.state] ?? BADGE_VIEWS.unknown;
  const stale = snapshot?.stale === true ? liveStaleHtml() : "";
  return `<span class="live-badge live-badge-${view.kind}" title="${escapeAttr(
    STANDING_COPY,
  )}"><span class="live-badge-state">${escapeHtml(
    view.label,
  )}</span><span class="live-badge-basis">derived · as of ${escapeHtml(
    formatDateTime(snapshot?.asOf),
  )}</span>${stale}</span>`;
}

/** The stale frame marker: the previous snapshot is kept while a poll retries. */
export function liveStaleHtml() {
  return `<span class="live-stale" role="status">stale, retrying</span>`;
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
