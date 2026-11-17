/**
 * Session health renderers: the Advanced Statistics badge and the rules
 * breakdown it toggles.
 *
 * DOM-free string builders in the same shape as `charts.js`: they consume the
 * stored DTO (`Analysis.health`) plus the already-loaded turns (for turn
 * labels and drill anchors) and return escaped markup. Nothing is re-derived
 * here — the evaluator lives in core — and no request is made.
 *
 * Every rule keeps its drill targets as plain `data-event-id` buttons, which
 * the existing `bindStatistics()` loop already routes through `jumpToEvent()`.
 */

import { escapeAttr, escapeHtml } from "./format.js";

/** Mirrors of the core caps; the breakdown stays scannable even on a hostile payload. */
export const MAX_EVENT_LINKS = 10;
export const MAX_TURN_LINKS = 6;

const BREAKDOWN_ID = "health-breakdown";

/** The standing copy: a derived signal, never a quality judgment or a score. */
const DISCLAIMER =
  "Derived signal from recorded observability data — not a quality judgment.";
const TOGGLE_HINT = `${DISCLAIMER} Select to see the rules.`;

const STATE_COPY = Object.freeze({
  healthy: "Healthy",
  watch: "Watch",
  degraded: "Degraded",
});

const LEVEL_COPY = Object.freeze({ watch: "Watch", strong: "Strong" });

/**
 * Insufficiency forces the attention wording: a thin or windowed session may
 * never read as healthy, and it keeps the dashed uncertain treatment.
 */
function presented(health) {
  const record = health ?? missingHealth();
  const insufficient = record?.insufficient === true;
  const state = insufficient ? "watch" : STATE_COPY[record?.state] ? record.state : "watch";
  return {
    state,
    word: STATE_COPY[state],
    insufficient,
    reasons: insufficient && Array.isArray(record.insufficientReasons)
      ? record.insufficientReasons
      : [],
    rules: Array.isArray(record?.rules) ? record.rules : [],
  };
}

/**
 * The shape rendered when `analysis.health` is absent (SC-6): watch with an
 * explicit insufficient-data sub-label, never a bare healthy badge.
 */
export function missingHealth() {
  return {
    state: "watch",
    insufficient: true,
    insufficientReasons: ["session health was not evaluated for this analysis"],
    rules: [],
    triggeredCount: 0,
  };
}

/**
 * Toolbar badge: a real button with `aria-expanded` so the rules panel state is
 * announced. The state is always carried by text, never by colour alone.
 */
export function healthBadgeHtml(health, expanded = false) {
  const view = presented(health);
  const classes = ["health-badge", `health-badge-${view.state}`];
  if (view.insufficient) classes.push("health-badge-insufficient");
  const sub = view.insufficient
    ? `<span class="health-badge-sub">insufficient data</span>`
    : "";
  const label = `${TOGGLE_HINT} Session health: ${view.word}${
    view.insufficient ? " — insufficient data" : ""
  }.`;
  return `<button type="button" class="${classes.join(" ")}" data-health-toggle aria-expanded="${
    expanded ? "true" : "false"
  }" aria-controls="${BREAKDOWN_ID}" title="${escapeAttr(
    TOGGLE_HINT,
  )}" aria-label="${escapeAttr(label)}"><span class="health-badge-state">Session health: ${escapeHtml(
    view.word,
  )}</span>${sub}</button>`;
}

/** Capped, de-duplicated list: the cap applies to what is rendered, not only upstream. */
function cappedIDs(ids, limit) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function ruleLinksHtml(rule, turnByID) {
  const links = [];
  const eventIDs = cappedIDs(rule?.eventIDs, MAX_EVENT_LINKS);
  eventIDs.forEach((eventID, position) => {
    links.push(
      `<button type="button" class="link-button health-rule-link" data-event-id="${escapeAttr(
        eventID,
      )}" aria-label="${escapeAttr(
        `Open event ${eventID} in Trajectory`,
      )}">Event ${position + 1}</button>`,
    );
  });
  const turnIDs = cappedIDs(rule?.turnIDs, MAX_TURN_LINKS);
  for (const turnID of turnIDs) {
    const turn = turnByID.get(turnID);
    // Charts precedent: the trigger event, then any turn event. No anchor means
    // no link — an id that cannot be opened is never rendered.
    const anchor = turn?.trigger?.eventID ?? turn?.eventIDs?.[0] ?? null;
    if (!anchor) continue;
    const label = `Turn ${turn.index}`;
    links.push(
      `<button type="button" class="link-button health-rule-link" data-event-id="${escapeAttr(
        anchor,
      )}" aria-label="${escapeAttr(
        `Open ${label} in Trajectory`,
      )}">${escapeHtml(label)}</button>`,
    );
  }
  if (links.length === 0) return "";
  return `<div class="health-rule-links">${links.join("")}</div>`;
}

function ruleStatus(rule) {
  if (rule?.evaluable === false) return "Not evaluable";
  return rule?.triggered ? "Triggered" : "Not triggered";
}

function healthRuleHtml(rule, turnByID) {
  const level = rule?.level === "watch" || rule?.level === "strong" ? rule.level : null;
  const levelBadge = level
    ? `<span class="health-level health-level-${level}">${escapeHtml(
        LEVEL_COPY[level],
      )}</span>`
    : "";
  return `<li class="health-rule">
      <div class="health-rule-head">
        <span class="health-rule-label">${escapeHtml(rule?.label ?? "Rule")}</span>
        ${levelBadge}
        <span class="health-rule-status">${escapeHtml(ruleStatus(rule))}</span>
        <span class="grow"></span>
        ${ruleLinksHtml(rule, turnByID)}
      </div>
      <p class="small muted health-rule-note">${escapeHtml(rule?.note ?? "")}</p>
    </li>`;
}

/**
 * The rules panel: every rule with its level badge, status, observed values and
 * drill links, insufficient-data reasons on top and the disclaimer at the foot.
 */
export function healthBreakdownHtml(health, turns = []) {
  const view = presented(health);
  const turnByID = new Map();
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (turn && typeof turn.id === "string") turnByID.set(turn.id, turn);
  }
  const reasons = view.reasons.length
    ? `<ul class="health-reasons">${view.reasons
        .map((reason) => `<li>${escapeHtml(reason)}</li>`)
        .join("")}</ul>`
    : "";
  const insufficient = view.insufficient
    ? `<div class="health-insufficient">
        <p class="small">Insufficient data: these rules were recorded, but they cannot claim a healthy session.</p>
        ${reasons}
      </div>`
    : "";
  const rules = view.rules.length
    ? `<ul class="health-rules">${view.rules
        .map((rule) => healthRuleHtml(rule, turnByID))
        .join("")}</ul>`
    : `<p class="small muted">No rule was evaluated for this analysis.</p>`;
  return `<section class="health-breakdown" id="${BREAKDOWN_ID}" aria-label="Session health rules">
      <div class="health-breakdown-head">
        <h2 class="stats-title">Session health rules</h2>
        <span class="health-level health-level-${view.state}">${escapeHtml(
          view.word,
        )}</span>
        <span class="muted small">${escapeHtml(DISCLAIMER)}</span>
      </div>
      ${insufficient}
      ${rules}
      <p class="small muted health-disclaimer">${escapeHtml(DISCLAIMER)}</p>
    </section>`;
}
