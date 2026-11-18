/**
 * Advisory guardrail renderers.
 *
 * DOM-free string builders in the same shape as `live.js` and `health.js`: they
 * consume the route-level `guardrails` sibling of the analysis response and
 * return escaped markup. Nothing is re-derived here — the evaluator lives in
 * core and every row arrives with its label, observed values, threshold and
 * capped evidence ids — and no request is made. The only import is
 * `./format.js`, so the module stays plain browser ESM with no build step.
 *
 * Guardrails are advisory by construction: the copy never claims a verdict and
 * the rows cannot block, interrupt or prompt anything. Rows keep the
 * `data-event-id` evidence buttons the existing `jumpToEvent()` binding routes
 * to the Trajectory view. Colour never carries state: every row keeps its text
 * label, the basis chip and the standing advisory line.
 */

import { escapeAttr, escapeHtml, formatNumber } from "./format.js";

/** Mirrors the core event cap; a hostile payload cannot grow the section. */
export const MAX_EVENT_LINKS = 10;

/** The standing advisory copy. Fixed, independent of the payload. */
export const GUARDRAIL_ADVISORY_COPY = "advisory — never blocks anything";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function cappedIDs(ids, limit) {
  const out = [];
  const seen = new Set();
  for (const id of asArray(ids)) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function eventLinksHtml(warning, label) {
  const ids = cappedIDs(warning?.eventIDs, MAX_EVENT_LINKS);
  if (ids.length === 0) return "";
  const links = ids
    .map(
      (eventID, position) =>
        `<button type="button" class="link-button guardrail-link" data-event-id="${escapeAttr(
          eventID,
        )}" aria-label="${escapeAttr(
          `Open event ${position + 1} of ${label} in Trajectory`,
        )}">Event ${position + 1}</button>`,
    )
    .join("");
  return `<div class="guardrail-links">${links}</div>`;
}

function rowHtml(warning, position) {
  const label = asText(warning?.label);
  const observed = asText(warning?.observed);
  const budget = Number.isFinite(warning?.threshold)
    ? formatNumber(warning.threshold)
    : "—";
  if (label.length === 0 || observed.length === 0) return "";
  const id = asText(warning?.id) || `budget-${position}`;
  return `<li class="guardrail-row" data-budget="${escapeAttr(id)}">
        <div class="guardrail-head">
          <span class="guardrail-label">${escapeHtml(label)}</span>
          <span class="guardrail-basis">derived</span>
          <span class="grow"></span>
          <span class="guardrail-advisory">advisory</span>
          ${eventLinksHtml(warning, label)}
        </div>
        <p class="small muted guardrail-note">${escapeHtml(
          `${observed} · budget ${budget}`,
        )}</p>
      </li>`;
}

/**
 * The block rendered above the active pane (directly below the live-warning
 * container), in both view modes. An absent, empty or malformed sibling
 * renders nothing, so a session under every budget leaves no frame behind.
 *
 * A budget that could not be evaluated is reported as skipped instead of
 * guessed. Rows that cannot render (an empty label or observation) are skipped
 * before the count is built, so the header never claims a row the block does
 * not show.
 */
export function guardrailsHtml(guardrails) {
  const rows = [];
  for (const warning of asArray(guardrails?.warnings)) {
    const html = rowHtml(warning, rows.length + 1);
    if (html.length > 0) rows.push(html);
  }
  const skipped = asArray(guardrails?.skipped)
    .map((entry) => {
      const label = asText(entry?.label);
      const note = asText(entry?.note);
      return label.length > 0 && note.length > 0 ? `${label}: ${note}` : "";
    })
    .filter((note) => note.length > 0);
  if (rows.length === 0 && skipped.length === 0) return "";

  const count = rows.length;
  const skippedHtml =
    skipped.length > 0
      ? `<p class="small muted guardrails-skipped">Not evaluated — ${escapeHtml(
          skipped.join(" · "),
        )}</p>`
      : "";
  const listHtml =
    rows.length > 0
      ? `<ul class="guardrails-list">${rows.join("")}</ul>`
      : "";
  return `<section class="guardrails-section" aria-label="Guardrail budgets">
      <div class="guardrails-head">
        <h2 class="guardrails-title">Guardrails</h2>
        <span class="guardrails-count">${escapeHtml(
          `${formatNumber(count)} advisory`,
        )}</span>
        <span class="muted small">basis derived</span>
      </div>
      <p class="small muted guardrails-advisory">${escapeHtml(
        GUARDRAIL_ADVISORY_COPY,
      )}</p>
      ${listHtml}
      ${skippedHtml}
    </section>`;
}
