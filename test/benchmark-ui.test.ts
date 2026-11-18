import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BENCHMARK_GROUP_BYS,
  MAX_BENCHMARK_FILTER_LENGTH,
  PATTERN_MIN_SESSIONS,
  benchmarkApiPath,
  benchmarkEmptyHtml,
  benchmarkErrorHtml,
  benchmarkFilterFormHtml,
  benchmarkHasFilters,
  benchmarkIdleHtml,
  benchmarkNotesHtml,
  benchmarkPatternsHtml,
  benchmarkTableHtml,
  benchmarkViewHtml,
  dateInputToEpoch,
  epochToDateInput,
  parseBenchmarkFilters,
  serializeBenchmarkFilters,
  // @ts-expect-error - plain browser module without type declarations
} from "../src/ui/benchmark.js";

const DAY = 86_400_000;

function rollups(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessions: 3,
    turns: 9,
    steps: 12,
    tokens: { input: 900, output: 90, reasoning: 0, cacheRead: 100, cacheWrite: 0 },
    tokensTotal: 1_090,
    costSum: { value: 0.9, basis: "derived", note: "sum across 3 session(s)" },
    costPerSession: { value: 0.3, basis: "derived", note: "3 of 3 comparable session(s)" },
    durationPerSession: { value: 12_000, basis: "derived", note: "3 of 3 comparable" },
    cacheHitRate: { value: 0.42, basis: "derived", note: "3 of 3 comparable" },
    retries: 4,
    errors: 2,
    toolFailures: 1,
    compactions: 0,
    completions: { succeeded: 2, failed: 1, interrupted: 0, unrecorded: 0 },
    windowedCount: 0,
    averagedSessions: 3,
    ...overrides,
  };
}

function benchmark(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groupBy: "agent",
    groups: [
      { key: "build", label: "build", count: 2, rollups: rollups({ sessions: 2 }) },
      {
        key: "explorer",
        label: "explorer",
        count: 1,
        rollups: rollups({
          sessions: 1,
          costSum: {
            value: null,
            basis: "unavailable",
            note: "no session recorded a cost value",
          },
        }),
      },
    ],
    overall: { count: 3, rollups: rollups() },
    recurringPatterns: [
      {
        kind: "health-rule",
        key: "retry-count",
        sessionCount: 3,
        sessionIDs: ["ses_new", "ses_mid", "ses_old"],
      },
      {
        kind: "failing-tool",
        key: "grep",
        sessionCount: 3,
        sessionIDs: ["ses_new", "ses_mid", "ses_old"],
      },
    ],
    sessionsCapped: false,
    candidatesConsidered: 3,
    basisNotes: [
      "Compared 3 of 3 candidate session(s).",
      "Windowed sessions (coverage.complete = false) are counted in sums and completion counts and excluded from averages; 0 of 3 compared session(s) are windowed.",
      "Averages are derived: cost per session, duration per session and cache hit rate skip a session whose value was not recorded.",
      "Recurring patterns are deterministic group-bys: a health rule or a top failing tool recorded in at least 3 sessions. Nothing is ranked.",
    ],
    ...overrides,
  };
}

async function uiSource(name: string): Promise<string> {
  return readFile(new URL(`../src/ui/${name}`, import.meta.url), "utf8");
}

function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const next = source.indexOf("\nfunction ", start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

test("the table renders group rows and a pinned overall row in the ledger idiom", () => {
  const markup = benchmarkTableHtml(benchmark());

  assert.match(markup, /class="table-wrap"/);
  assert.match(markup, /class="stats-table benchmark-table"/);
  assert.match(markup, /<tr class="benchmark-group-row">/);
  assert.match(markup, /build/);
  assert.match(markup, /explorer/);
  assert.match(markup, /<tr class="total-row benchmark-overall-row"><td>Overall<\/td>/);
  for (const header of [
    "Sessions",
    "Turns",
    "Avg cost / session",
    "Avg duration / session",
    "Cache hit (avg)",
    "Tool failures",
    "Compactions",
    "Succeeded",
    "Failed",
    "Windowed",
  ]) {
    assert.ok(markup.includes(`>${header}<`), header);
  }
  // The group dimension is named from the DTO, not hard-coded.
  assert.match(markup, /<th scope="col">Agent<\/th>/);
  assert.match(
    benchmarkTableHtml(benchmark({ groupBy: "taskType" })),
    /<th scope="col">Task type<\/th>/,
  );
});

test("an unavailable average reads Not recorded, never a zero", () => {
  const markup = benchmarkTableHtml(benchmark());
  const explorerRow = markup.slice(markup.indexOf("explorer"));
  const cells = explorerRow.slice(0, explorerRow.indexOf("</tr>"));

  assert.match(cells, /Not recorded/);
  assert.match(cells, /class="metric unavailable"/);
  assert.doesNotMatch(cells, /\$0\.00/);
  assert.doesNotMatch(cells, />0\.00</);

  // A recorded average keeps its derived mark and its note.
  const buildRow = markup.slice(markup.indexOf("build"), markup.indexOf("explorer"));
  assert.match(buildRow, /\$0\.3000<sup>D<\/sup>/);
  assert.match(buildRow, /title="derived: 3 of 3 comparable session\(s\)"/);
});

test("every dynamic string in the table is escaped", () => {
  const hostile = benchmark({
    groupBy: "agent",
    groups: [
      {
        key: "<script>alert(1)</script>",
        label: `<img src=x onerror="alert(2)">`,
        count: 1,
        rollups: rollups({ sessions: 1 }),
      },
      {
        key: "second",
        label: "<script>alert(5)</script>",
        count: 1,
        rollups: rollups({ sessions: 1 }),
      },
    ],
    basisNotes: ["<b>note</b>"],
    recurringPatterns: [
      {
        kind: "failing-tool",
        key: `"><script>alert(3)</script>`,
        sessionCount: 3,
        sessionIDs: ["<script>alert(4)</script>"],
      },
    ],
  });

  const markup = `${benchmarkTableHtml(hostile)}${benchmarkPatternsHtml(
    hostile.recurringPatterns,
  )}${benchmarkNotesHtml(hostile)}`;
  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /<img src=x/);
  assert.doesNotMatch(markup, /<b>note<\/b>/);
  assert.match(markup, /&lt;script&gt;alert\(5\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/);
  assert.match(markup, /&quot;&gt;&lt;script&gt;alert\(3\)/);
  assert.match(markup, /&lt;b&gt;note&lt;\/b&gt;/);
});

test("a malformed benchmark renders nothing instead of throwing", () => {
  assert.equal(benchmarkTableHtml(null), "");
  assert.equal(benchmarkTableHtml({}), "");
  assert.equal(benchmarkTableHtml({ overall: { count: 3 } }), "");
  assert.equal(benchmarkPatternsHtml(undefined), "");
  assert.equal(benchmarkNotesHtml({}), "");
  assert.equal(benchmarkNotesHtml(null), "");
});

// ---------------------------------------------------------------------------
// Patterns and provenance
// ---------------------------------------------------------------------------

test("recurring-pattern cards name the rule or tool and its session count", () => {
  const markup = benchmarkPatternsHtml(benchmark().recurringPatterns);
  assert.match(markup, /class="benchmark-patterns"/);
  assert.match(markup, /Recurring patterns/);
  assert.match(markup, /Health rule/);
  assert.match(markup, /retry-count/);
  assert.match(markup, /Failing tool/);
  assert.match(markup, /grep/);
  assert.match(markup, /3 sessions/);
  assert.match(markup, /ses_new · ses_mid · ses_old/);
  assert.match(
    markup,
    new RegExp(`at least ${PATTERN_MIN_SESSIONS} sessions`),
  );
  assert.doesNotMatch(markup, /class="benchmark-pattern-count">3<\/span>$/);
});

test("pattern session lists are capped and say how many are hidden", () => {
  const many = Array.from({ length: 13 }, (_, index) => `ses_${index}`);
  const markup = benchmarkPatternsHtml([
    { kind: "failing-tool", key: "grep", sessionCount: 13, sessionIDs: many },
  ]);
  assert.match(markup, /\+3 more/);
  assert.doesNotMatch(markup, /ses_12/);
});

test("provenance notes carry the cap and the windowed-exclusion note", () => {
  const plain = benchmarkNotesHtml(benchmark());
  assert.match(plain, /class="benchmark-notes"/);
  assert.doesNotMatch(plain, /data-sessions-capped/);
  assert.match(plain, /excluded from averages/);

  const capped = benchmarkNotesHtml(
    benchmark({
      sessionsCapped: true,
      candidatesConsidered: 120,
      basisNotes: [
        "Compared the 50 most recently updated of 120 candidate session(s); older candidates were not loaded.",
      ],
    }),
  );
  assert.match(capped, /data-sessions-capped="true"/);
  assert.match(capped, /benchmark-note benchmark-note-cap/);
  assert.match(capped, /120 candidate session\(s\)/);
});

// ---------------------------------------------------------------------------
// Idle, empty and error states
// ---------------------------------------------------------------------------

test("the idle, empty and error states are distinct", () => {
  const idle = benchmarkIdleHtml();
  assert.match(idle, /Set at least one filter/);
  assert.match(idle, /at most 50/);

  const empty = benchmarkEmptyHtml();
  assert.match(empty, /No session matched these filters/);

  const error = benchmarkErrorHtml(`boom <script>alert(1)</script>`);
  assert.match(error, /role="alert"/);
  assert.match(error, /Could not compare sessions/);
  assert.doesNotMatch(error, /<script>/);
  assert.match(error, /&lt;script&gt;/);

  assert.match(benchmarkErrorHtml(""), /Could not compare sessions\./);
  assert.equal(benchmarkErrorHtml("x".repeat(500)).length < 320, true);
});

test("an empty comparison keeps the table out but shows the notes", () => {
  const markup = benchmarkViewHtml({
    filters: { agent: "nobody" },
    benchmark: benchmark({
      groups: [],
      overall: { count: 0, rollups: rollups({ sessions: 0 }) },
      recurringPatterns: [],
    }),
  });
  assert.match(markup, /No session matched these filters/);
  assert.doesNotMatch(markup, /benchmark-table/);
  assert.match(markup, /benchmark-notes/);
});

// ---------------------------------------------------------------------------
// Filters and the hash query
// ---------------------------------------------------------------------------

test("filters round-trip through the query string", () => {
  const filters = {
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
  // Fixed key order keeps a deep link stable.
  assert.ok(query.indexOf("from=") < query.indexOf("groupBy="));
});

test("blank values, unknown keys and closed vocabularies are dropped", () => {
  assert.deepEqual(parseBenchmarkFilters(""), {});
  assert.deepEqual(parseBenchmarkFilters("agent=%20%20&model="), {});
  assert.deepEqual(
    parseBenchmarkFilters("agent=build&token=secret&theme=petalo"),
    { agent: "build" },
  );
  assert.deepEqual(parseBenchmarkFilters("groupBy=directory"), {});
  assert.deepEqual(parseBenchmarkFilters("agent=build&outcome=pending"), {
    agent: "build",
  });
  assert.deepEqual(parseBenchmarkFilters("agent=build&taskType=retry"), {
    agent: "build",
  });
  // Serialization caps an oversized value at the server limit.
  const long = serializeBenchmarkFilters({ agent: "a".repeat(400) });
  assert.equal(
    new URLSearchParams(long).get("agent")?.length,
    MAX_BENCHMARK_FILTER_LENGTH,
  );
});

test("a criterion is required and groupBy never counts as one", () => {
  assert.equal(benchmarkHasFilters({}), false);
  assert.equal(benchmarkHasFilters({ groupBy: "model" }), false);
  assert.equal(benchmarkHasFilters({ agent: "   " }), false);
  assert.equal(benchmarkHasFilters({ from: "0" }), true);
  for (const key of [
    "from",
    "to",
    "model",
    "provider",
    "agent",
    "directory",
    "outcome",
    "taskType",
  ]) {
    assert.equal(benchmarkHasFilters({ [key]: "x" }), true, key);
  }
});

test("the API path carries exactly the set filters", () => {
  assert.equal(benchmarkApiPath({}), "/api/benchmark");
  assert.equal(
    benchmarkApiPath({ agent: "build", groupBy: "none" }),
    "/api/benchmark?agent=build&groupBy=none",
  );
  assert.equal(
    benchmarkApiPath({ from: "1", to: "2" }),
    "/api/benchmark?from=1&to=2",
  );
});

test("date inputs convert to UTC epoch bounds", () => {
  assert.equal(dateInputToEpoch("2026-01-02"), Date.UTC(2026, 0, 2));
  assert.equal(
    dateInputToEpoch("2026-01-02", true),
    Date.UTC(2026, 0, 2) + DAY - 1,
  );
  assert.equal(dateInputToEpoch("", true), undefined);
  assert.equal(dateInputToEpoch("02/01/2026"), undefined);
  assert.equal(dateInputToEpoch("2026-13-45"), undefined);
  assert.equal(epochToDateInput(Date.UTC(2026, 0, 2)), "2026-01-02");
  assert.equal(epochToDateInput(undefined), "");
  assert.equal(epochToDateInput("not-a-number"), "");
});

// ---------------------------------------------------------------------------
// Page assembly and the route
// ---------------------------------------------------------------------------

test("the view assembles the form, the results and the notes", () => {
  const markup = benchmarkViewHtml({ benchmark: benchmark(), filters: { agent: "build" } });
  assert.match(markup, /class="benchmark-view"/);
  assert.match(markup, /Session benchmark/);
  assert.match(markup, /data-benchmark-form/);
  assert.match(markup, /name="agent" type="text" value="build"/);
  assert.match(markup, /class="benchmark-body" role="status" aria-live="polite"/);
  assert.match(markup, /benchmark-table/);

  const idle = benchmarkViewHtml({});
  assert.match(idle, /Set at least one filter/);
  assert.doesNotMatch(idle, /benchmark-table/);

  const loading = benchmarkViewHtml({ filters: { agent: "build" }, loading: true });
  assert.match(loading, /Comparing sessions…/);
  assert.doesNotMatch(loading, /benchmark-table/);

  const failed = benchmarkViewHtml({ filters: { agent: "build" }, error: "network down" });
  assert.match(failed, /Could not compare sessions: network down/);
});

test("the filter form offers every filter and the six group-by options", () => {
  const markup = benchmarkFilterFormHtml({});
  for (const name of [
    "from",
    "to",
    "model",
    "provider",
    "agent",
    "directory",
    "outcome",
    "taskType",
    "groupBy",
  ]) {
    assert.match(markup, new RegExp(`name="${name}"`), name);
  }
  for (const groupBy of ["none", "model", "provider", "agent", "outcome", "taskType"]) {
    assert.match(markup, new RegExp(`<option value="${groupBy}"`), groupBy);
  }
  assert.deepEqual([...BENCHMARK_GROUP_BYS], [
    "none",
    "model",
    "provider",
    "agent",
    "outcome",
    "taskType",
  ]);
  assert.match(markup, /<option value="none" selected>None \(overall only\)<\/option>/);
  assert.match(markup, /<option value="succeeded">succeeded<\/option>/);
});

test("the builder module is DOM-free and only imports ./format.js", async () => {
  const source = await uiSource("benchmark.js");
  assert.doesNotMatch(source, /\bdocument\./);
  assert.doesNotMatch(source, /\bwindow\./);
  assert.doesNotMatch(source, /\bquerySelector\b/);
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["./format.js"]);
});

test("the benchmark is a standalone hash route with a header nav link", async () => {
  const app = await uiSource("app.js");
  const routing = functionBody(app, "function parseHash()");
  assert.match(routing, /parts\[0\] === "benchmark"/);
  assert.match(routing, /parseBenchmarkFilters\(params\.toString\(\)\)/);
  assert.match(app, /function enterBenchmark\(/);
  assert.match(app, /await renderBenchmark\(filters\)/);
  assert.match(app, /data-benchmark-form/);
  // Leaving the benchmark must never write a session URL with a benchmark view.
  assert.match(app, /state\.view = view === "statistics" \? "statistics" : "trajectory";/);

  const html = await uiSource("index.html");
  const liveToggle = html.indexOf('id="live-toggle"');
  const link = html.indexOf('id="benchmark-link"');
  assert.ok(liveToggle >= 0 && link > liveToggle, "nav link sits beside the live toggle");
  assert.match(html, /href="#\/benchmark"/);
});

test("the benchmark never leaks Basic-mode markup or a second table idiom", () => {
  const markup = benchmarkViewHtml({ benchmark: benchmark(), filters: {} });
  assert.doesNotMatch(markup, /basic-stats/);
  assert.doesNotMatch(markup, /data-view-mode-option/);
  assert.doesNotMatch(markup, /health-rule\b/);
  assert.equal(
    markup.match(/class="stats-table benchmark-table"/g)?.length,
    1,
  );
});

test("benchmark styles reuse tokens only and never carry state by colour", async () => {
  const css = await uiSource("styles.css");
  const start = css.indexOf("/* ------------------------------------------------------- session benchmark */");
  assert.ok(start >= 0, "benchmark style block present");
  const block = css.slice(start);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(block, /\brgb\(/);
  assert.match(block, /var\(--surface\)/);
  assert.match(block, /var\(--warning\)/);
  assert.match(block, /\.benchmark-table \{ min-width:/);
});
