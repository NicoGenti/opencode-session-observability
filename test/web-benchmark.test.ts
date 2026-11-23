import test from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_GROUP_BYS as CORE_GROUP_BYS,
  BENCHMARK_OUTCOMES as CORE_OUTCOMES,
  BENCHMARK_TASK_TYPES as CORE_TASK_TYPES,
  PATTERN_MIN_SESSIONS as CORE_PATTERN_MIN_SESSIONS,
} from "../src/core/benchmark.ts";
import {
  BENCHMARK_COLUMN_HEADERS,
  BENCHMARK_EMPTY_COPY,
  BENCHMARK_GROUP_BYS,
  BENCHMARK_IDLE_COPY,
  BENCHMARK_LOADING_COPY,
  BENCHMARK_OUTCOMES,
  BENCHMARK_TASK_TYPES,
  MAX_BENCHMARK_FILTER_LENGTH,
  PATTERN_MIN_SESSIONS,
  benchmarkApiPath,
  benchmarkErrorMessage,
  benchmarkHasFilters,
  benchmarkIsEmpty,
  benchmarkResponseLands,
  benchmarkStateKind,
  dateInputToEpoch,
  epochToDateInput,
  filtersFromFormValues,
  groupLabel,
  parseBenchmarkFilters,
  patternSessionIDs,
  quantiseDateBound,
  serializeBenchmarkFilters,
  type BenchmarkFilterSet,
} from "../src/web/lib/benchmark.ts";
import {
  benchmarkFragment,
  parseHash,
  readRoute,
} from "../src/web/lib/hash.ts";

const DAY = 86_400_000;

test("the vocabularies are the core ones, not a second copy", () => {
  assert.deepEqual([...BENCHMARK_GROUP_BYS], ["none", "model", "provider", "agent", "outcome", "taskType"]);
  assert.equal(BENCHMARK_GROUP_BYS, CORE_GROUP_BYS);
  assert.equal(BENCHMARK_OUTCOMES, CORE_OUTCOMES);
  assert.equal(BENCHMARK_TASK_TYPES, CORE_TASK_TYPES);
  assert.equal(PATTERN_MIN_SESSIONS, CORE_PATTERN_MIN_SESSIONS);
});

test("filters round-trip through the query string in a fixed key order", () => {
  const filters: BenchmarkFilterSet = {
    from: "1704067200000",
    to: "1735689599999",
    model: "test-model",
    provider: "test-provider",
    agent: "build",
    directory: "C:/work",
    outcome: "failed",
    taskType: "delegation",
    groupBy: "model",
  };
  const query = serializeBenchmarkFilters(filters);
  assert.deepEqual(parseBenchmarkFilters(query), filters);
  assert.deepEqual(parseBenchmarkFilters(`?${query}`), filters);
  assert.ok(query.indexOf("from=") < query.indexOf("groupBy="));
  // The hash round-trip: serialize → fragment → parse → parse equals the input.
  const route = parseHash(benchmarkFragment(query));
  assert.equal(route.view, "benchmark");
  assert.deepEqual(parseBenchmarkFilters(route.benchmarkQuery), filters);
  assert.deepEqual(readRoute(benchmarkFragment("")).benchmarkQuery, "");
});

test("blank values, unknown keys and closed vocabularies are dropped", () => {
  assert.deepEqual(parseBenchmarkFilters(""), {});
  assert.deepEqual(parseBenchmarkFilters("agent=%20%20&model="), {});
  assert.deepEqual(parseBenchmarkFilters("agent=build&token=secret&theme=petalo"), {
    agent: "build",
  });
  assert.deepEqual(parseBenchmarkFilters("groupBy=directory"), {});
  assert.deepEqual(parseBenchmarkFilters("agent=build&outcome=pending"), { agent: "build" });
  assert.deepEqual(parseBenchmarkFilters("agent=build&taskType=retry"), { agent: "build" });
  const long = serializeBenchmarkFilters({ agent: "a".repeat(400) });
  assert.equal(new URLSearchParams(long).get("agent")?.length, MAX_BENCHMARK_FILTER_LENGTH);
});

test("a criterion is required and groupBy never counts as one", () => {
  assert.equal(benchmarkHasFilters({}), false);
  assert.equal(benchmarkHasFilters({ groupBy: "model" }), false);
  assert.equal(benchmarkHasFilters({ agent: "   " }), false);
  assert.equal(benchmarkHasFilters({ from: "0" }), true);
  for (const key of ["model", "provider", "agent", "directory", "outcome", "taskType"] as const) {
    assert.equal(benchmarkHasFilters({ [key]: "x" }), true, key);
  }
});

test("a non-numeric date bound is dropped instead of forwarded", () => {
  assert.equal(benchmarkHasFilters({ from: "yesterday" }), false);
  assert.equal(benchmarkHasFilters({ to: "12e" }), false);
  assert.equal(benchmarkApiPath({ from: "nope" }), "/api/benchmark");
  assert.equal(benchmarkApiPath({ from: "nope", agent: "build" }), "/api/benchmark?agent=build");
  assert.deepEqual(parseBenchmarkFilters("from=nope&agent=build"), { agent: "build" });
  assert.deepEqual(parseBenchmarkFilters("to=12e"), {});
  assert.equal(serializeBenchmarkFilters({ to: "nope", model: "m" }), "model=m");
});

test("hash date bounds quantise to UTC days so a re-submit is stable", () => {
  const noon = Date.UTC(2026, 0, 2, 12, 34, 56, 789);
  assert.equal(quantiseDateBound(noon), Date.UTC(2026, 0, 2));
  assert.equal(quantiseDateBound(noon, true), Date.UTC(2026, 0, 3) - 1);
  assert.equal(quantiseDateBound(noon), quantiseDateBound(String(noon)));
  assert.equal(quantiseDateBound("", true), undefined);
  assert.equal(quantiseDateBound("nope"), undefined);
  assert.equal(quantiseDateBound(Number.NaN), undefined);

  const filters = parseBenchmarkFilters(`from=${noon}&to=${noon}&agent=build`);
  assert.equal(filters.from, String(Date.UTC(2026, 0, 2)));
  assert.equal(filters.to, String(Date.UTC(2026, 0, 3) - 1));

  const query = serializeBenchmarkFilters(filters);
  assert.equal(
    query,
    `from=${Date.UTC(2026, 0, 2)}&to=${Date.UTC(2026, 0, 3) - 1}&agent=build`,
  );
  assert.deepEqual(parseBenchmarkFilters(query), filters);

  // The form path lands on the very same bounds as the hash path.
  assert.equal(
    serializeBenchmarkFilters({
      from: String(dateInputToEpoch("2026-01-02")),
      to: String(dateInputToEpoch("2026-01-02", true)),
    }),
    query.replace("&agent=build", ""),
  );
});

test("the API path carries exactly the set filters", () => {
  assert.equal(benchmarkApiPath({}), "/api/benchmark");
  assert.equal(
    benchmarkApiPath({ agent: "build", groupBy: "none" }),
    "/api/benchmark?agent=build&groupBy=none",
  );
  assert.equal(
    benchmarkApiPath({ from: "1", to: "2" }),
    "/api/benchmark?from=0&to=86399999",
  );
});

test("date inputs convert to UTC epoch bounds", () => {
  assert.equal(dateInputToEpoch("2026-01-02"), Date.UTC(2026, 0, 2));
  assert.equal(dateInputToEpoch("2026-01-02", true), Date.UTC(2026, 0, 2) + DAY - 1);
  assert.equal(dateInputToEpoch("", true), undefined);
  assert.equal(dateInputToEpoch("02/01/2026"), undefined);
  assert.equal(dateInputToEpoch("2026-13-45"), undefined);
  assert.equal(epochToDateInput(Date.UTC(2026, 0, 2)), "2026-01-02");
  assert.equal(epochToDateInput(undefined), "");
  assert.equal(epochToDateInput("not-a-number"), "");
});

test("a submitted form produces the same filter set as the hash does", () => {
  const filters = filtersFromFormValues({
    from: "2026-01-02",
    to: "2026-01-02",
    model: "m",
    provider: "",
    agent: "build",
    directory: "",
    outcome: "failed",
    taskType: "",
    groupBy: "model",
  });
  assert.equal(filters.from, String(Date.UTC(2026, 0, 2)));
  assert.equal(filters.to, String(Date.UTC(2026, 0, 2) + DAY - 1));
  assert.equal(filters.model, "m");
  assert.equal(filters.outcome, "failed");
  assert.equal(filters.groupBy, "model");
  // An empty select value is dropped by the serializer, not by the form: the
  // query only carries the criteria that were set.
  const query = serializeBenchmarkFilters(filters);
  assert.doesNotMatch(query, /(^|&)(provider|directory|taskType)=/);
  assert.deepEqual(parseBenchmarkFilters(query), {
    from: filters.from,
    to: filters.to,
    model: "m",
    agent: "build",
    outcome: "failed",
    groupBy: "model",
  });
});

test("the four states are distinct and keep the legacy copy", () => {
  assert.equal(benchmarkStateKind({ error: "x", loading: true }), "error");
  assert.equal(benchmarkStateKind({ loading: true, benchmark: { overall: { count: 3 } } }), "loading");
  assert.equal(benchmarkStateKind({ benchmark: { overall: { count: 3 } } }), "results");
  assert.equal(benchmarkStateKind({}), "idle");
  assert.match(BENCHMARK_IDLE_COPY, /Set at least one filter/);
  assert.match(BENCHMARK_IDLE_COPY, /at most 50/);
  assert.equal(BENCHMARK_EMPTY_COPY, "No session matched these filters.");
  assert.equal(BENCHMARK_LOADING_COPY, "Comparing sessions…");
  assert.equal(benchmarkIsEmpty(null), true);
  assert.equal(benchmarkIsEmpty({ overall: { count: 0 } }), true);
  assert.equal(benchmarkIsEmpty({ overall: { count: 1 } }), false);
});

test("a benchmark response paints only while its ticket is newest and the route owns the view", () => {
  // The newest ticket on an owned route lands.
  assert.equal(benchmarkResponseLands(7, 7, true), true);
  // A newer run took a ticket after this response started: it must not paint.
  assert.equal(benchmarkResponseLands(6, 7, true), false);
  // `invalidate()` (session select, route leave) bumped the sequence.
  assert.equal(benchmarkResponseLands(7, 8, true), false);
  // A response that outlived the route must not paint, newest ticket or not.
  assert.equal(benchmarkResponseLands(7, 7, false), false);
  // The guards are separate: losing either one is enough.
  assert.equal(benchmarkResponseLands(7, 8, false), false);
});

test("the error sentence is capped and never a zero state", () => {
  assert.equal(benchmarkErrorMessage(""), "Could not compare sessions.");
  assert.equal(benchmarkErrorMessage("   "), "Could not compare sessions.");
  assert.equal(benchmarkErrorMessage("network down"), "Could not compare sessions: network down");
  const long = benchmarkErrorMessage(`${"x".repeat(400)}\n\nrest`);
  assert.ok(long.length < 240);
  assert.doesNotMatch(long, /\n/);
});

test("group labels and pattern session lists stay within their caps", () => {
  assert.equal(groupLabel({ label: "build", key: "b" }), "build");
  assert.equal(groupLabel({ key: "explorer" }), "explorer");
  assert.equal(groupLabel({}), "Not recorded");
  const many = Array.from({ length: 13 }, (_, index) => `ses_${index}`);
  const { shown, rest } = patternSessionIDs({ sessionIDs: many });
  assert.equal(shown.length, 10);
  assert.equal(rest, 3);
  assert.equal(patternSessionIDs({ sessionIDs: [1, "", "ses_a"] }).shown.join(), "ses_a");
  assert.deepEqual(patternSessionIDs(null), { shown: [], rest: 0 });
});

test("the results table header order is the legacy order", () => {
  assert.deepEqual(
    [...BENCHMARK_COLUMN_HEADERS],
    [
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
    ],
  );
});
