/**
 * Recommendation renderers for Advanced Statistics.
 *
 * DOM-free string builders in the same shape as `health.js` and
 * `attribution.js`: they consume the stored `Analysis.recommendations` DTO and
 * return escaped markup. Nothing is re-derived here — the evaluator lives in
 * core, every row arrives with its `kind`, `severity` and evidence ids — and no
 * request is made. The only import is `./format.js`, so the module stays plain
 * browser ESM with no build step.
 *
 * The section keeps the two kinds structurally apart: a fact row is a plain,
 * neutral card, while a hypothesis row carries the dashed uncertain treatment
 * and the standing "hypothesis — not a diagnosis" copy. Rows keep the
 * `data-event-id` evidence buttons the existing `bindStatistics()` loop already
 * routes through `jumpToEvent()`. There is no ordering control, no count to
 * sort by and no ranking: rows render in the DTO's fixed rule order.
 */

import { escapeAttr, escapeHtml, formatNumber } from "./format.js";

/** Mirrors of the core caps; a hostile payload cannot grow the section. */
export const MAX_RECOMMENDATION_ROWS = 11;
export const MAX_EVENT_LINKS = 10;

/** The standing hypothesis copy. Fixed, independent of the payload. */
export const HYPOTHESIS_DISCLAIMER = "hypothesis — not a diagnosis";

const STANDING_NOTE =
  "Local and deterministic — derived from recorded data, never ranked.";

/**
 * The analysis layer each rule reads. The section's provenance rail lists the
 * distinct sources on screen, so the origin of every row stays visible.
 */
const SOURCE_BY_RULE = Object.freeze({
  "reduce-context": "health",
  "retry-failed-tool": "diagnostics",
  "split-task": "turns",
  "reuse-subagent": "totals",
  "avoid-unnecessary-compaction": "compactions",
  "concentrated-file-cost": "attribution",
});

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

function eventLinksHtml(ids, label) {
  const capped = cappedIDs(ids, MAX_EVENT_LINKS);
  if (capped.length === 0) return "";
  const links = capped
    .map(
      (eventID, position) =>
        `<button type="button" class="link-button recommendation-link" data-event-id="${escapeAttr(
          eventID,
        )}" aria-label="${escapeAttr(
          `Open event ${position + 1} of ${label} in Trajectory`,
        )}">Event ${position + 1}</button>`,
    )
    .join("");
  return `<div class="recommendation-links">${links}</div>`;
}

function sourceOf(ruleID) {
  const source = SOURCE_BY_RULE[ruleID];
  return typeof source === "string" ? source : "analysis";
}

function rowHtml(row, position) {
  const ruleID = asText(row?.ruleID);
  const kind = row?.kind === "hypothesis" ? "hypothesis" : "fact";
  const label = asText(row?.label);
  const note = asText(row?.note);
  if (label.length === 0 || note.length === 0) return "";
  const source = sourceOf(ruleID);
  const kindCopy = kind === "fact" ? "Fact" : "Hypothesis";
  const disclaimer =
    kind === "hypothesis"
      ? `<span class="recommendation-disclaimer">${escapeHtml(
          HYPOTHESIS_DISCLAIMER,
        )}</span>`
      : "";
  return `<li class="recommendation-row recommendation-${kind}" data-rule="${escapeAttr(
    ruleID,
  )}" data-source="${escapeAttr(source)}">
        <div class="recommendation-head">
          <span class="recommendation-kind">${escapeHtml(kindCopy)}</span>
          <span class="recommendation-label">${escapeHtml(label)}</span>
          <span class="recommendation-source">${escapeHtml(source)}</span>
          ${disclaimer}
          <span class="grow"></span>
          ${eventLinksHtml(
            row?.eventIDs,
            `recommendation ${position}`,
          )}
        </div>
        <p class="small muted recommendation-note">${escapeHtml(note)}</p>
      </li>`;
}

function countLabel(count, noun) {
  const plural = noun === "hypothesis" ? "hypotheses" : "facts";
  return `${formatNumber(count)} ${count === 1 ? noun : plural}`;
}

/**
 * The section rendered in Advanced Statistics. An absent, empty or malformed
 * rider renders nothing, so a session with nothing to say leaves no frame
 * behind.
 *
 * Rows that cannot render (an empty label or note) are skipped before the
 * counts, the provenance rail and the list are built, so the header never
 * claims a row the section does not show. One pass collects all four.
 */
export function recommendationsSectionHtml(recommendations) {
  const rows = asArray(recommendations?.rows).slice(0, MAX_RECOMMENDATION_ROWS);
  const rendered = [];
  const sources = [];
  let facts = 0;
  let hypotheses = 0;
  for (const row of rows) {
    const html = rowHtml(row, rendered.length + 1);
    if (html.length === 0) continue;
    rendered.push(html);
    if (row?.kind === "hypothesis") hypotheses += 1;
    else facts += 1;
    const source = sourceOf(row?.ruleID);
    if (!sources.includes(source)) sources.push(source);
  }
  if (rendered.length === 0) return "";

  const rail = `Sources — ${sources.join(" · ")}`;
  const notes = asArray(recommendations?.basisNotes).filter(
    (note) => typeof note === "string" && note.length > 0,
  );
  const notesHtml =
    notes.length > 0
      ? `<ul class="recommendation-notes">${notes
          .map((note) => `<li>${escapeHtml(note)}</li>`)
          .join("")}</ul>`
      : "";
  return `<section class="recommendations-section" aria-label="Recommendations">
      <div class="recommendations-head">
        <h2 class="stats-title">Recommendations</h2>
        <span class="recommendation-counts">${escapeHtml(
          `${countLabel(facts, "fact")} · ${countLabel(hypotheses, "hypothesis")}`,
        )}</span>
        <span class="muted small">${escapeHtml(rail)}</span>
      </div>
      <ul class="recommendation-rows">${rendered.join("")}</ul>
      <p class="recommendation-standing">${escapeHtml(STANDING_NOTE)}</p>
      ${notesHtml}
    </section>`;
}
