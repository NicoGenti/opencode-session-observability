/**
 * Cross-session benchmark renderers and route helpers.
 *
 * DOM-free string builders in the same shape as `health.js`, `live.js` and
 * `attribution.js`: they consume the stored `Benchmark` DTO and return escaped
 * markup. Nothing is re-derived here — the rollups, the averages and the
 * recurring-pattern group-bys come from core — and no request is made. The only
 * import is `./format.js`, so the module stays plain browser ESM with no build
 * step.
 *
 * The filter helpers are pure as well: the hash query string is the single
 * source of truth for the comparison, so `parseBenchmarkFilters` and
 * `serializeBenchmarkFilters` round-trip the same field names the endpoint
 * accepts. Date inputs are converted to epoch milliseconds in UTC day bounds on
 * both paths, so parsing a hash and re-submitting it reproduces the same query;
 * a non-numeric `from`/`to` never reaches the endpoint.
 *
 * Unavailable numbers are rendered as the literal text "Not recorded", never as
 * a zero: an average nobody recorded is not a cheap session. Colour never
 * carries state and every cell keeps its basis mark.
 */

import {
  basisLabel,
  basisMark,
  escapeAttr,
  escapeHtml,
  formatCost,
  formatDuration,
  formatNumber,
  formatPercent,
} from "./format.js";

/** Mirrors of the core contract; a hostile payload cannot widen the form. */
export const BENCHMARK_GROUP_BYS = Object.freeze([
  "none",
  "model",
  "provider",
  "agent",
  "outcome",
  "taskType",
]);

export const BENCHMARK_OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "interrupted",
]);

export const BENCHMARK_TASK_TYPES = Object.freeze(["user", "delegation"]);

/** The filter fields the hash and the endpoint share (`groupBy` is not one). */
export const BENCHMARK_FILTER_KEYS = Object.freeze([
  "from",
  "to",
  "model",
  "provider",
  "agent",
  "directory",
  "outcome",
  "taskType",
]);

/** Longest filter value accepted from the hash; mirrors the server cap. */
export const MAX_BENCHMARK_FILTER_LENGTH = 120;

/** Mirrors `PATTERN_MIN_SESSIONS` for the card copy. */
export const PATTERN_MIN_SESSIONS = 3;

const GROUP_LABELS = Object.freeze({
  none: "Group",
  model: "Model",
  provider: "Provider",
  agent: "Agent",
  outcome: "Outcome",
  taskType: "Task type",
});

const GROUP_OPTION_LABELS = Object.freeze({
  none: "None (overall only)",
  model: "Model",
  provider: "Provider",
  agent: "Agent",
  outcome: "Outcome",
  taskType: "Task type",
});

const COLUMN_HEADERS = Object.freeze([
  "Sessions",
  "Turns",
  "Steps",
  "Tokens",
  "Cost (sum)",
  "Avg cost / session",
  "Avg duration / session",
  "Cache hit (avg)",
  "Retries",
  "Errors",
  "Tool failures",
  "Compactions",
  "Succeeded",
  "Failed",
  "Interrupted",
  "Unrecorded",
  "Windowed",
]);

const IDLE_COPY =
  "Set at least one filter to compare sessions. The server compares at most 50 recently updated candidates and reports the cap in its notes.";

const EMPTY_COPY = "No session matched these filters.";

/** Longest server error detail echoed into the view. */
const MAX_ERROR_DETAIL = 200;

function asText(value) {
  return typeof value === "string" ? value : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampText(value) {
  return asText(value).trim().slice(0, MAX_BENCHMARK_FILTER_LENGTH);
}

const DAY_MS = 86_400_000;

/**
 * A numeric epoch value quantised to its UTC day bound: day start for `from`,
 * day end for `to`. Returns `undefined` for anything that is not a finite
 * number, so a malformed bound is dropped instead of forwarded.
 */
export function quantiseDateBound(value, endOfDay = false) {
  const text = (typeof value === "number" ? String(value) : asText(value)).trim();
  if (text.length === 0) return undefined;
  const ms = Number(text);
  if (!Number.isFinite(ms)) return undefined;
  const day = Math.floor(ms / DAY_MS);
  return endOfDay ? (day + 1) * DAY_MS - 1 : day * DAY_MS;
}

/**
 * One filter key as the query carries it, or `undefined` when it carries
 * nothing. `from`/`to` must be finite epoch milliseconds and are quantised to
 * their UTC day bound; every other key is trimmed text.
 */
function queryValue(key, value) {
  const text = clampText(value);
  if (text.length === 0) return undefined;
  if (key !== "from" && key !== "to") return text;
  const bound = quantiseDateBound(text, key === "to");
  return bound === undefined ? undefined : String(bound);
}

// ---------------------------------------------------------------------------
// Filters and the hash query
// ---------------------------------------------------------------------------

/** True when at least one criterion is set; `groupBy` alone asks for nothing. */
export function benchmarkHasFilters(filters = {}) {
  return BENCHMARK_FILTER_KEYS.some((key) => queryValue(key, filters[key]) !== undefined);
}

/**
 * Reads the benchmark filters out of a hash query string. Unknown keys (the
 * access token, a theme) are ignored, blank values are dropped and a value
 * outside a closed vocabulary is discarded rather than forwarded. `from`/`to`
 * come back quantised to their UTC day bound, so a re-submit is stable.
 */
export function parseBenchmarkFilters(query) {
  const params = new URLSearchParams(asText(query).replace(/^\?/, ""));
  const filters = {};
  for (const key of BENCHMARK_FILTER_KEYS) {
    const value = queryValue(key, params.get(key));
    if (value !== undefined) filters[key] = value;
  }
  const groupBy = clampText(params.get("groupBy"));
  if (BENCHMARK_GROUP_BYS.includes(groupBy)) filters.groupBy = groupBy;
  if (filters.outcome && !BENCHMARK_OUTCOMES.includes(filters.outcome)) {
    delete filters.outcome;
  }
  if (filters.taskType && !BENCHMARK_TASK_TYPES.includes(filters.taskType)) {
    delete filters.taskType;
  }
  return filters;
}

/** Serializes the filters in a fixed key order so the hash is stable. */
export function serializeBenchmarkFilters(filters = {}) {
  const params = new URLSearchParams();
  for (const key of [...BENCHMARK_FILTER_KEYS, "groupBy"]) {
    const value =
      key === "groupBy" ? clampText(filters[key]) : queryValue(key, filters[key]);
    if (value !== undefined && value.length > 0) params.set(key, value);
  }
  return params.toString();
}

/** The request path for one comparison; `app.js` only calls it with filters. */
export function benchmarkApiPath(filters = {}) {
  const query = serializeBenchmarkFilters(filters);
  return query ? `/api/benchmark?${query}` : "/api/benchmark";
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `<input type="date">` value to epoch milliseconds (UTC). `endOfDay` widens
 * the bound to the last millisecond of that day so "to 2026-01-02" includes the
 * sessions recorded on the 2nd.
 */
export function dateInputToEpoch(value, endOfDay = false) {
  const text = asText(value).trim();
  if (!DATE_PATTERN.test(text)) return undefined;
  const midnight = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(midnight)) return undefined;
  return endOfDay ? midnight + DAY_MS - 1 : midnight;
}

/** Epoch milliseconds back to the `YYYY-MM-DD` a date input expects. */
export function epochToDateInput(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "";
  return new Date(value).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Filter form
// ---------------------------------------------------------------------------

function field(label, id, control) {
  return `<div class="benchmark-field"><label for="${escapeAttr(
    id,
  )}">${escapeHtml(label)}</label>${control}</div>`;
}

function textInput(id, name, value, placeholder) {
  return `<input id="${escapeAttr(id)}" name="${escapeAttr(
    name,
  )}" type="text" value="${escapeAttr(
    asText(value),
  )}" placeholder="${escapeAttr(placeholder)}" maxlength="${MAX_BENCHMARK_FILTER_LENGTH}" autocomplete="off" spellcheck="false">`;
}

function selectInput(id, name, value, options) {
  const rendered = options
    .map(
      ([optionValue, optionLabel]) =>
        `<option value="${escapeAttr(optionValue)}"${
          optionValue === asText(value) ? " selected" : ""
        }>${escapeHtml(optionLabel)}</option>`,
    )
    .join("");
  return `<select id="${escapeAttr(id)}" name="${escapeAttr(name)}">${rendered}</select>`;
}

/**
 * The filter form. Date inputs show `YYYY-MM-DD`; the filter object keeps epoch
 * milliseconds, so the hash and the endpoint stay on one representation.
 */
export function benchmarkFilterFormHtml(filters = {}) {
  return `<form class="benchmark-filters" data-benchmark-form>
${field(
  "From",
  "benchmark-from",
  `<input id="benchmark-from" name="from" type="date" value="${escapeAttr(
    epochToDateInput(filters.from),
  )}">`,
)}
${field(
  "To",
  "benchmark-to",
  `<input id="benchmark-to" name="to" type="date" value="${escapeAttr(
    epochToDateInput(filters.to),
  )}">`,
)}
${field("Model", "benchmark-model", textInput("benchmark-model", "model", filters.model, "Any model"))}
${field("Provider", "benchmark-provider", textInput("benchmark-provider", "provider", filters.provider, "Any provider"))}
${field("Agent", "benchmark-agent", textInput("benchmark-agent", "agent", filters.agent, "Any agent"))}
${field(
  "Directory",
  "benchmark-directory",
  textInput("benchmark-directory", "directory", filters.directory, "Any directory"),
)}
${field(
  "Outcome",
  "benchmark-outcome",
  selectInput("benchmark-outcome", "outcome", filters.outcome, [
    ["", "Any outcome"],
    ...BENCHMARK_OUTCOMES.map((outcome) => [outcome, outcome]),
  ]),
)}
${field(
  "Task type",
  "benchmark-task-type",
  selectInput("benchmark-task-type", "taskType", filters.taskType, [
    ["", "Any task type"],
    ...BENCHMARK_TASK_TYPES.map((kind) => [kind, kind]),
  ]),
)}
${field(
  "Group by",
  "benchmark-group-by",
  selectInput(
    "benchmark-group-by",
    "groupBy",
    asText(filters.groupBy) || "none",
    BENCHMARK_GROUP_BYS.map((groupBy) => [groupBy, GROUP_OPTION_LABELS[groupBy]]),
  ),
)}
<div class="benchmark-actions"><button type="submit" class="btn">Compare</button></div>
</form>`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function metricCell(metric, formatter) {
  const available =
    metric && typeof metric.value === "number" && Number.isFinite(metric.value);
  if (!available) {
    const note = metric && asText(metric.note) ? asText(metric.note) : "unavailable";
    return `<td class="num"><span class="metric unavailable" title="${escapeAttr(
      note,
    )}">Not recorded</span></td>`;
  }
  const title = `${basisLabel(metric.basis)}${
    metric.note ? `: ${metric.note}` : ""
  }`;
  return `<td class="num"><span class="metric metric-${escapeAttr(
    metric.basis,
  )}" title="${escapeAttr(title)}">${escapeHtml(
    formatter(metric.value),
  )}<sup>${escapeHtml(basisMark(metric.basis))}</sup></span></td>`;
}

function countCell(value) {
  return `<td class="num">${escapeHtml(formatNumber(value))}</td>`;
}

function rollupCells(rollups = {}) {
  const completions = rollups.completions ?? {};
  return [
    countCell(rollups.sessions),
    countCell(rollups.turns),
    countCell(rollups.steps),
    countCell(rollups.tokensTotal),
    metricCell(rollups.costSum, formatCost),
    metricCell(rollups.costPerSession, formatCost),
    metricCell(rollups.durationPerSession, formatDuration),
    metricCell(rollups.cacheHitRate, formatPercent),
    countCell(rollups.retries),
    countCell(rollups.errors),
    countCell(rollups.toolFailures),
    countCell(rollups.compactions),
    countCell(completions.succeeded),
    countCell(completions.failed),
    countCell(completions.interrupted),
    countCell(completions.unrecorded),
    countCell(rollups.windowedCount),
  ].join("");
}

/**
 * The results table in the existing ledger/table idiom: one row per group, one
 * pinned `total-row` for the overall rollup. A group with no recorded average
 * says "Not recorded" instead of reporting zero.
 */
export function benchmarkTableHtml(benchmark) {
  const overall = benchmark && benchmark.overall;
  if (!overall || !overall.rollups) return "";
  const groupBy = asText(benchmark.groupBy) || "none";
  const heading = GROUP_LABELS[groupBy] ?? GROUP_LABELS.none;
  const groups = asArray(benchmark.groups);
  const head = COLUMN_HEADERS.map(
    (label) => `<th scope="col" class="num">${escapeHtml(label)}</th>`,
  ).join("");
  const rows = groups
    .map(
      (group) =>
        `<tr class="benchmark-group-row"><th scope="row" class="benchmark-group-key">${escapeHtml(
          asText(group.label) || asText(group.key) || "Not recorded",
        )}</th>${rollupCells(group.rollups)}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="stats-table benchmark-table"><caption class="sr-only">Session benchmark rollups by ${escapeHtml(
    heading.toLowerCase(),
  )}</caption><thead><tr><th scope="col">${escapeHtml(
    heading,
  )}</th>${head}</tr></thead><tbody>${rows}<tr class="total-row benchmark-overall-row"><td>Overall</td>${rollupCells(
    overall.rollups,
  )}</tr></tbody></table></div>`;
}

function patternCard(pattern) {
  const kind = asText(pattern.kind);
  const kindLabel = kind === "failing-tool" ? "Failing tool" : "Health rule";
  const key = asText(pattern.key) || "Not recorded";
  const ids = asArray(pattern.sessionIDs).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  const shown = ids.slice(0, 10);
  const rest = ids.length - shown.length;
  return `<li class="benchmark-pattern">
<div class="benchmark-pattern-head"><span class="badge badge-neutral">${escapeHtml(
    kindLabel,
  )}</span><strong class="benchmark-pattern-key">${escapeHtml(
    key,
  )}</strong><span class="benchmark-pattern-count">${escapeHtml(
    formatNumber(pattern.sessionCount),
  )} sessions</span></div>
<p class="benchmark-pattern-sessions">${escapeHtml(shown.join(" · "))}${
    rest > 0 ? ` · +${rest} more` : ""
  }</p>
</li>`;
}

/** Recurring-pattern cards: a rule or tool, its session count and its sessions. */
export function benchmarkPatternsHtml(patterns) {
  const rows = asArray(patterns);
  if (rows.length === 0) return "";
  return `<section class="benchmark-patterns" aria-label="Recurring patterns"><h3 class="benchmark-subtitle">Recurring patterns</h3><p class="muted small">A health rule or top failing tool recorded in at least ${PATTERN_MIN_SESSIONS} sessions. Nothing is ranked.</p><ul class="benchmark-pattern-list">${rows
    .map(patternCard)
    .join("")}</ul></section>`;
}

/** Provenance: the cap note, the windowed-exclusion note and the basis notes. */
export function benchmarkNotesHtml(benchmark) {
  const notes = asArray(benchmark && benchmark.basisNotes).filter(
    (note) => typeof note === "string" && note.length > 0,
  );
  if (notes.length === 0) return "";
  const capped = benchmark.sessionsCapped === true;
  return `<ul class="benchmark-notes"${
    capped ? ' data-sessions-capped="true"' : ""
  }>${notes
    .map(
      (note, index) =>
        `<li class="benchmark-note${
          capped && index === 0 ? " benchmark-note-cap" : ""
        }">${escapeHtml(note)}</li>`,
    )
    .join("")}</ul>`;
}

/** The first-arrival state: no filter is set, so nothing has been asked yet. */
export function benchmarkIdleHtml() {
  return `<p class="benchmark-empty muted">${escapeHtml(IDLE_COPY)}</p>`;
}

/** A valid comparison with no matching session. */
export function benchmarkEmptyHtml() {
  return `<p class="benchmark-empty muted">${escapeHtml(EMPTY_COPY)}</p>`;
}

/** A failed request, capped and escaped so a server message stays one line. */
export function benchmarkErrorHtml(message) {
  const detail = asText(message).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_DETAIL);
  return `<p class="benchmark-error" role="alert">Could not compare sessions${
    detail ? `: ${escapeHtml(detail)}` : "."
  }</p>`;
}

function resultsHtml(benchmark) {
  const empty = !benchmark.overall || benchmark.overall.count === 0;
  return `<div class="benchmark-results">${
    empty ? benchmarkEmptyHtml() : benchmarkTableHtml(benchmark)
  }${benchmarkPatternsHtml(benchmark.recurringPatterns)}${benchmarkNotesHtml(
    benchmark,
  )}</div>`;
}

/**
 * The whole `#/benchmark` view: one standalone page, no session selected. The
 * form is always rendered so the filters stay editable while a comparison is
 * loading, failing or empty.
 */
export function benchmarkViewHtml(view = {}) {
  const filters = view.filters ?? {};
  let body;
  if (view.error) body = benchmarkErrorHtml(view.error);
  else if (view.loading) {
    body = '<p class="benchmark-loading muted" role="status">Comparing sessions…</p>';
  } else if (view.benchmark) body = resultsHtml(view.benchmark);
  else body = benchmarkIdleHtml();
  return `<section class="benchmark-view">
<div class="benchmark-head"><h2 class="benchmark-title">Session benchmark</h2><p class="muted small">Descriptive rollups across recently updated sessions. No session, group or pattern is ranked.</p></div>
${benchmarkFilterFormHtml(filters)}
<div class="benchmark-body" role="status" aria-live="polite">${body}</div>
</section>`;
}
