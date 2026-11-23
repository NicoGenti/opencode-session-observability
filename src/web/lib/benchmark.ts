/**
 * The standalone benchmark's pure half: the filter round-trip, the UTC-day
 * quantisation, the request path and the copy the four states render.
 *
 * Ported from `src/ui/benchmark.js:34-227`. The closed vocabularies are imported
 * from `src/core/benchmark.ts` instead of mirrored: the UI and the server must
 * agree on what `groupBy`, `outcome` and `taskType` accept, and Phase 1 already
 * locked that rule for the guardrail budgets.
 *
 * Representation: the filter object keeps the exact strings the hash and the
 * endpoint carry (`from`/`to` are epoch-millisecond strings, already quantised to
 * their UTC day bound), so parsing a hash and re-submitting it reproduces the
 * same query byte for byte.
 */

import {
  BENCHMARK_GROUP_BYS,
  BENCHMARK_OUTCOMES,
  BENCHMARK_TASK_TYPES,
  PATTERN_MIN_SESSIONS as CORE_PATTERN_MIN_SESSIONS,
} from "../../core/benchmark.ts";

export { BENCHMARK_GROUP_BYS, BENCHMARK_OUTCOMES, BENCHMARK_TASK_TYPES };

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
] as const);

export type BenchmarkFilterKey = (typeof BENCHMARK_FILTER_KEYS)[number];
export type BenchmarkGroupByValue = (typeof BENCHMARK_GROUP_BYS)[number];

/** The parsed filter set the form and the request read. */
export interface BenchmarkFilterSet {
  from?: string;
  to?: string;
  model?: string;
  provider?: string;
  agent?: string;
  directory?: string;
  outcome?: string;
  taskType?: string;
  groupBy?: string;
}

/** Longest filter value accepted from the hash; mirrors the server cap. */
export const MAX_BENCHMARK_FILTER_LENGTH = 120;

/** Mirrors `PATTERN_MIN_SESSIONS` for the card copy. */
export const PATTERN_MIN_SESSIONS = CORE_PATTERN_MIN_SESSIONS;

export const GROUP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  none: "Group",
  model: "Model",
  provider: "Provider",
  agent: "Agent",
  outcome: "Outcome",
  taskType: "Task type",
});

export const GROUP_OPTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  none: "None (overall only)",
  model: "Model",
  provider: "Provider",
  agent: "Agent",
  outcome: "Outcome",
  taskType: "Task type",
});

/** Column headers of the rollup table, in the legacy order (`benchmark.js:88-106`). */
export const BENCHMARK_COLUMN_HEADERS: readonly string[] = Object.freeze([
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

/** The untouched-form state (`benchmark.js:108-109`). */
export const BENCHMARK_IDLE_COPY =
  "Set at least one filter to compare sessions. The server compares at most 50 recently updated candidates and reports the cap in its notes.";

/** A valid comparison with no matching session (`benchmark.js:111`). */
export const BENCHMARK_EMPTY_COPY = "No session matched these filters.";

/** The in-flight state (`benchmark.js:486`). */
export const BENCHMARK_LOADING_COPY = "Comparing sessions…";

/** The failed-request prefix; the detail follows it (`benchmark.js:462-464`). */
export const BENCHMARK_ERROR_PREFIX = "Could not compare sessions";

export const BENCHMARK_TITLE = "Session benchmark";
export const BENCHMARK_SUBTITLE =
  "Descriptive rollups across recently updated sessions. No session, group or pattern is ranked.";
export const BENCHMARK_PATTERNS_TITLE = "Recurring patterns";
export const BENCHMARK_PATTERNS_NOTE = `A health rule or top failing tool recorded in at least ${PATTERN_MIN_SESSIONS} sessions. Nothing is ranked.`;

/** Longest server error detail echoed into the view (`benchmark.js:114`). */
export const MAX_BENCHMARK_ERROR_DETAIL = 200;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function clampText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.trim().slice(0, MAX_BENCHMARK_FILTER_LENGTH);
}

/**
 * A numeric epoch value quantised to its UTC day bound (`benchmark.js:135-142`):
 * day start for `from`, day end for `to`. Anything that is not a finite number
 * returns `undefined`, so a malformed bound is dropped instead of forwarded.
 */
export function quantiseDateBound(value: unknown, endOfDay = false): number | undefined {
  const text = (typeof value === "number" ? String(value) : clampText(value)).trim();
  if (text.length === 0) return undefined;
  const ms = Number(text);
  if (!Number.isFinite(ms)) return undefined;
  const day = Math.floor(ms / DAY_MS);
  return endOfDay ? (day + 1) * DAY_MS - 1 : day * DAY_MS;
}

/** One filter key as the query carries it, or `undefined` (`benchmark.js:149-155`). */
function queryValue(key: BenchmarkFilterKey, value: unknown): string | undefined {
  const text = clampText(value);
  if (text.length === 0) return undefined;
  if (key !== "from" && key !== "to") return text;
  const bound = quantiseDateBound(text, key === "to");
  return bound === undefined ? undefined : String(bound);
}

/** True when at least one criterion is set; `groupBy` alone asks for nothing. */
export function benchmarkHasFilters(filters: BenchmarkFilterSet = {}): boolean {
  return BENCHMARK_FILTER_KEYS.some((key) => queryValue(key, filters[key]) !== undefined);
}

/**
 * Reads the benchmark filters out of a hash query string (`benchmark.js:172-188`).
 * Unknown keys (the access token, a theme) are ignored, blank values are dropped
 * and a value outside a closed vocabulary is discarded rather than forwarded.
 * `from`/`to` come back quantised to their UTC day bound, so a re-submit is stable.
 */
export function parseBenchmarkFilters(query: unknown): BenchmarkFilterSet {
  const text = typeof query === "string" ? query.replace(/^\?/, "") : "";
  const params = new URLSearchParams(text);
  const filters: BenchmarkFilterSet = {};
  for (const key of BENCHMARK_FILTER_KEYS) {
    const value = queryValue(key, params.get(key));
    if (value !== undefined) filters[key] = value;
  }
  const groupBy = clampText(params.get("groupBy"));
  if ((BENCHMARK_GROUP_BYS as readonly string[]).includes(groupBy)) {
    filters.groupBy = groupBy;
  }
  if (filters.outcome && !(BENCHMARK_OUTCOMES as readonly string[]).includes(filters.outcome)) {
    delete filters.outcome;
  }
  if (
    filters.taskType &&
    !(BENCHMARK_TASK_TYPES as readonly string[]).includes(filters.taskType)
  ) {
    delete filters.taskType;
  }
  return filters;
}

/** Serializes the filters in a fixed key order so the hash is stable. */
export function serializeBenchmarkFilters(filters: BenchmarkFilterSet = {}): string {
  const params = new URLSearchParams();
  for (const key of [...BENCHMARK_FILTER_KEYS, "groupBy"] as const) {
    const value =
      key === "groupBy" ? clampText(filters[key]) : queryValue(key, filters[key]);
    if (value !== undefined && value.length > 0) params.set(key, value);
  }
  return params.toString();
}

/** The request path for one comparison (`benchmark.js:202-205`). */
export function benchmarkApiPath(filters: BenchmarkFilterSet = {}): string {
  const query = serializeBenchmarkFilters(filters);
  return query ? `/api/benchmark?${query}` : "/api/benchmark";
}

/**
 * A `<input type="date">` value to epoch milliseconds in UTC
 * (`benchmark.js:214-220`). `endOfDay` widens the bound to the last millisecond
 * of that day so "to 2026-01-02" includes the sessions recorded on the 2nd.
 */
export function dateInputToEpoch(value: unknown, endOfDay = false): number | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!DATE_PATTERN.test(text)) return undefined;
  const midnight = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(midnight)) return undefined;
  return endOfDay ? midnight + DAY_MS - 1 : midnight;
}

/** Epoch milliseconds back to the `YYYY-MM-DD` a date input expects. */
export function epochToDateInput(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** The filter set a submitted form produces (`app.js:4124-4140`). */
export function filtersFromFormValues(values: {
  from?: string;
  to?: string;
  model?: string;
  provider?: string;
  agent?: string;
  directory?: string;
  outcome?: string;
  taskType?: string;
  groupBy?: string;
}): BenchmarkFilterSet {
  const filters: BenchmarkFilterSet = {
    model: values.model,
    provider: values.provider,
    agent: values.agent,
    directory: values.directory,
    outcome: values.outcome,
    taskType: values.taskType,
    groupBy: values.groupBy,
  };
  const from = dateInputToEpoch(values.from);
  if (from !== undefined) filters.from = String(from);
  const to = dateInputToEpoch(values.to, true);
  if (to !== undefined) filters.to = String(to);
  return filters;
}

/** The group's display label: its recorded label, key, or "Not recorded". */
export function groupLabel(group: { label?: unknown; key?: unknown } | null | undefined): string {
  const label = typeof group?.label === "string" ? group.label : "";
  if (label.length > 0) return label;
  const key = typeof group?.key === "string" ? group.key : "";
  return key.length > 0 ? key : "Not recorded";
}

/** A capped, de-duplicated list of pattern session ids (`benchmark.js:402-406`). */
export function patternSessionIDs(
  pattern: { sessionIDs?: unknown } | null | undefined,
  cap = 10,
): { shown: string[]; rest: number } {
  const ids = Array.isArray(pattern?.sessionIDs)
    ? pattern.sessionIDs.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return { shown: ids.slice(0, cap), rest: Math.max(0, ids.length - cap) };
}

/** The failed-request sentence, capped to one line (`benchmark.js:460-465`). */
export function benchmarkErrorMessage(message: unknown): string {
  const detail =
    typeof message === "string"
      ? message.replace(/\s+/g, " ").trim().slice(0, MAX_BENCHMARK_ERROR_DETAIL)
      : "";
  return detail ? `${BENCHMARK_ERROR_PREFIX}: ${detail}` : `${BENCHMARK_ERROR_PREFIX}.`;
}

/** The four distinct states the view can render, in precedence order. */
export type BenchmarkStateKind = "error" | "loading" | "results" | "idle";

export function benchmarkStateKind(view: {
  error?: string | null;
  loading?: boolean;
  benchmark?: { overall?: { count?: number } } | null;
}): BenchmarkStateKind {
  if (view.error) return "error";
  if (view.loading) return "loading";
  if (view.benchmark) return "results";
  return "idle";
}

/** A results payload with no matching session renders the empty copy. */
export function benchmarkIsEmpty(
  benchmark: { overall?: { count?: number } } | null | undefined,
): boolean {
  return !benchmark || !benchmark.overall || (benchmark.overall.count ?? 0) === 0;
}

/**
 * The guard both benchmark response paths apply before they may paint: the
 * ticket must still be the newest one taken on the controller, and the
 * benchmark route must still own the view.
 *
 * The controller bumps its sequence on a newer run, on `invalidate()` (session
 * select, route leave) and on unmount, so a response that lost the race is
 * dropped even when the route is still owned; a response that outlived the
 * route is dropped even when its ticket is still current. Both checks are
 * separate and both must hold, exactly as the legacy renderer wrote them
 * (`app.js:4156`, `:4160`).
 */
export function benchmarkResponseLands(
  ticket: number,
  sequence: number,
  routeOwned: boolean,
): boolean {
  return ticket === sequence && routeOwned;
}
