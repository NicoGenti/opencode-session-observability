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

/** Mirrors the core turn cap; a warning never renders more turn anchors. */
export const MAX_TURN_LINKS = 6;

/** The standing advisory copy. Fixed, independent of the payload. */
export const GUARDRAIL_ADVISORY_COPY = "advisory — never blocks anything";

/**
 * Budgets may be fractional (cost in dollars, elapsed minutes), so the
 * threshold keeps up to two decimals. `formatNumber` rounds to whole units and
 * would report a `$12.75` budget as `13`; the row counts keep using it.
 */
const BUDGET_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function formatBudget(value) {
  return BUDGET_FORMAT.format(value);
}

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

/** `turn.trigger?.eventID ?? turn.eventIDs?.[0]`, the health-breakdown rule. */
function anchorOf(turn) {
  const anchor = turn?.trigger?.eventID ?? turn?.eventIDs?.[0] ?? null;
  return typeof anchor === "string" && anchor.length > 0 ? anchor : null;
}

/**
 * The evidence buttons: `Event N` links for the capped event ids, then
 * `Turn N` links for the capped turn ids. Both carry `data-event-id`, because a
 * turn's anchor *is* an event id, so the existing `jumpToEvent()` binding opens
 * the Trajectory row either way. A turn whose anchor cannot be resolved
 * renders no link — an id that cannot be opened is never shown.
 */
function evidenceLinksHtml(warning, label, turnByID) {
  const links = [];
  const ids = cappedIDs(warning?.eventIDs, MAX_EVENT_LINKS);
  ids.forEach((eventID, position) => {
    links.push(
      `<button type="button" class="link-button guardrail-link" data-event-id="${escapeAttr(
        eventID,
      )}" aria-label="${escapeAttr(
        `Open event ${position + 1} of ${label} in Trajectory`,
      )}">Event ${position + 1}</button>`,
    );
  });
  const turnIDs = cappedIDs(warning?.turnIDs, MAX_TURN_LINKS);
  for (const turnID of turnIDs) {
    const turn = turnByID.get(turnID);
    const anchor = anchorOf(turn);
    if (!anchor) continue;
    const turnLabel = `Turn ${turn.index}`;
    links.push(
      `<button type="button" class="link-button guardrail-link" data-event-id="${escapeAttr(
        anchor,
      )}" aria-label="${escapeAttr(
        `Open ${turnLabel} in Trajectory`,
      )}">${escapeHtml(turnLabel)}</button>`,
    );
  }
  if (links.length === 0) return "";
  return `<div class="guardrail-links">${links.join("")}</div>`;
}

function rowHtml(warning, position, turnByID) {
  const label = asText(warning?.label);
  const observed = asText(warning?.observed);
  const budget = Number.isFinite(warning?.threshold)
    ? formatBudget(warning.threshold)
    : "—";
  if (label.length === 0 || observed.length === 0) return "";
  const id = asText(warning?.id) || `budget-${position}`;
  return `<li class="guardrail-row" data-budget="${escapeAttr(id)}">
        <div class="guardrail-head">
          <span class="guardrail-label">${escapeHtml(label)}</span>
          <span class="guardrail-basis">derived</span>
          <span class="grow"></span>
          <span class="guardrail-advisory">advisory</span>
          ${evidenceLinksHtml(warning, label, turnByID)}
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
 * `turns` is the already-loaded `Analysis.turns`, used only to label and anchor
 * the `Turn N` evidence links of the event-only budgets (`tokens-total`,
 * `cost-total`, `context-run`); without it those budgets keep their observation
 * and simply render no turn button.
 *
 * A budget that could not be evaluated is reported as skipped instead of
 * guessed. Rows that cannot render (an empty label or observation) are skipped
 * before the count is built, so the header never claims a row the block does
 * not show.
 */
export function guardrailsHtml(guardrails, turns = []) {
  const turnByID = new Map();
  for (const turn of asArray(turns)) {
    if (turn && typeof turn.id === "string") turnByID.set(turn.id, turn);
  }
  const rows = [];
  for (const warning of asArray(guardrails?.warnings)) {
    const html = rowHtml(warning, rows.length + 1, turnByID);
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
  // The block is a native disclosure: the summary carries the header and the
  // standing count, so the frame stays visible while the rows are collapsed by
  // default. The body id is fixed because only one guardrail block ever renders;
  // `aria-controls`/`aria-expanded` are re-applied by the app after every write.
  return `<section class="guardrails-section" aria-label="Guardrail budgets">
      <details class="guardrails-block" id="guardrails-details">
        <summary class="guardrails-summary" id="guardrails-summary" aria-controls="guardrails-body" aria-expanded="false">
          <h2 class="guardrails-title">Guardrails</h2>
          <span class="guardrails-count">${escapeHtml(
            `${formatNumber(count)} advisory`,
          )}</span>
          <span class="muted small">basis derived</span>
        </summary>
        <div class="guardrails-body" id="guardrails-body">
          <p class="small muted guardrails-advisory">${escapeHtml(
            GUARDRAIL_ADVISORY_COPY,
          )}</p>
          ${listHtml}
          ${skippedHtml}
        </div>
      </details>
    </section>`;
}
