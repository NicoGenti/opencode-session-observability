import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// @ts-expect-error - plain browser module without type declarations
import { axisLabels, chartDataListHtml, chartEmptyStateHtml, chartSectionHtml, contextGrowthChartHtml, costChartHtml, durationChartHtml, gridLines, polylineRuns, svgClose, svgOpen, tokenChartHtml } from "../src/ui/charts.js";

function styleAttributes(markup: string): string[] {
  return [...markup.matchAll(/style="([^"]*)"/g)].map((match) => match[1]);
}

function polylines(markup: string): string[] {
  return [...markup.matchAll(/<polyline [^>]*points="([^"]+)"/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// Fixtures in the shapes produced by src/ui/charts-data.js
// ---------------------------------------------------------------------------

const CONTEXT_SERIES = {
  basis: "latest",
  empty: false,
  points: [
    { turnIndex: 1, anchor: "evt_user_1", value: 100, basis: "measured", available: true },
    { turnIndex: 2, anchor: "evt_user_2", value: null, basis: "unavailable", available: false },
    { turnIndex: 3, anchor: null, value: 300, basis: "measured", available: true },
  ],
  markers: [
    {
      eventID: "evt_comp_1",
      turnIndex: 2,
      removedTokens: { value: 40, basis: "derived", available: true },
      label: "Compaction 1",
    },
  ],
  unplaced: 1,
  unavailableCount: 1,
};

const CONTEXT_GAP_SERIES = {
  basis: "latest",
  empty: false,
  points: [
    { turnIndex: 1, anchor: "evt_user_1", value: 100, basis: "measured", available: true },
    { turnIndex: 2, anchor: "evt_user_2", value: 150, basis: "measured", available: true },
    { turnIndex: 3, anchor: "evt_user_3", value: null, basis: "unavailable", available: false },
    { turnIndex: 4, anchor: "evt_user_4", value: 200, basis: "measured", available: true },
    { turnIndex: 5, anchor: "evt_user_5", value: 250, basis: "measured", available: true },
  ],
  markers: [],
  unplaced: 0,
  unavailableCount: 1,
};

const TOKEN_SERIES = {
  empty: false,
  partialCount: 1,
  points: [
    {
      turnIndex: 1,
      anchor: "evt_user_1",
      input: 10,
      cacheRead: 300,
      cacheWrite: 40,
      reasoning: 5,
      output: 20,
      partial: false,
      basis: "measured",
    },
    {
      turnIndex: 2,
      anchor: null,
      input: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      output: 0,
      partial: true,
      basis: "unavailable",
    },
  ],
};

const TOKEN_UNRECORDED_SERIES = {
  empty: false,
  partialCount: 0,
  points: [
    {
      turnIndex: 1,
      anchor: "evt_user_1",
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      output: 0,
      partial: false,
      basis: "unavailable",
    },
  ],
};

const COST_SERIES = {
  empty: false,
  unavailableCount: 1,
  points: [
    {
      turnIndex: 1,
      anchor: "evt_user_1",
      cost: { value: 0.5, basis: "measured", available: true },
      modelKey: "prov-a/model-a",
      modelLabel: "prov-a/model-a",
      providerLabel: "prov-a",
    },
    {
      turnIndex: 2,
      anchor: "evt_user_2",
      cost: { value: null, basis: "unavailable", available: false },
      modelKey: "prov-b/model-b",
      modelLabel: "prov-b/model-b",
      providerLabel: null,
    },
    {
      turnIndex: 3,
      anchor: "evt_user_3",
      cost: { value: 0.5, basis: "measured", available: true },
      modelKey: "prov-b/model-b",
      modelLabel: "prov-b/model-b",
      providerLabel: null,
    },
  ],
  models: [
    { key: "prov-a/model-a", label: "prov-a/model-a" },
    { key: "prov-b/model-b", label: "prov-b/model-b" },
  ],
  max: { value: 0.5, turnIndices: [1, 3] },
};

const DURATION_SERIES = {
  empty: false,
  unavailableCount: 1,
  points: [
    {
      label: "1.1",
      turnIndex: 1,
      stepIndex: 1,
      anchor: "evt_step_1_1",
      available: true,
      modelTime: { value: 300, basis: "measured", available: true },
      toolTime: { value: 100, basis: "measured", available: true },
      residualTime: { value: 100, basis: "derived", available: true },
    },
    {
      label: "1.2",
      turnIndex: 1,
      stepIndex: 2,
      anchor: null,
      available: true,
      modelTime: { value: 200, basis: "measured", available: true },
    },
    {
      label: "2.1",
      turnIndex: 2,
      stepIndex: 1,
      anchor: "evt_step_2_1",
      available: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

test("svgOpen carries role=img and an escaped chart-level aria-label", () => {
  const open = svgOpen({ label: 'Context "growth"' });

  assert.match(open, /^<svg /);
  assert.match(open, /class="chart-svg"/);
  assert.match(open, /viewBox="0 0 720 220"/);
  assert.match(open, /role="img"/);
  assert.match(open, /aria-label="Context &quot;growth&quot;"/);
  assert.equal(svgClose(), "</svg>");
});

test("gridLines emits one var(--grid) rule per row plus the frame edge", () => {
  const lines = gridLines({ rows: 4 });

  assert.equal((lines.match(/<line /g) ?? []).length, 5);
  assert.equal((lines.match(/style="stroke: var\(--grid\)"/g) ?? []).length, 5);
  assert.match(lines, /x1="56"/);
  assert.match(lines, /x2="704"/);
});

test("axisLabels labels the baseline only when nothing is available", () => {
  const none = axisLabels({ max: null });
  assert.equal((none.match(/<text /g) ?? []).length, 1);
  assert.match(none, />0</);

  const scaled = axisLabels({ max: 2_000 });
  assert.equal((scaled.match(/<text /g) ?? []).length, 5);
  assert.match(scaled, />2\.0k</);
  assert.match(scaled, /style="fill: var\(--muted\)"/);
});

test("polylineRuns splits into one polyline per contiguous available run", () => {
  const runs = polylines(polylineRuns(CONTEXT_GAP_SERIES.points, { max: 250 }));

  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.split(" ").length, 2);
    assert.match(run, /^\d+\.\d{2},\d+\.\d{2} \d+\.\d{2},\d+\.\d{2}$/);
  }

  const single = polylineRuns(CONTEXT_SERIES.points, { max: 300 });
  assert.equal(single, "");
});

// ---------------------------------------------------------------------------
// Context growth chart
// ---------------------------------------------------------------------------

test("context growth chart draws gapped runs, point datums and anchors", () => {
  const markup = contextGrowthChartHtml(CONTEXT_GAP_SERIES);

  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="Context growth per turn, latest basis"/);
  assert.equal(polylines(markup).length, 2);
  // No line segment spans the unavailable turn 3.
  for (const run of polylines(markup)) assert.equal(run.split(" ").length, 2);
  assert.equal((markup.match(/class="chart-point chart-datum-link"/g) ?? []).length, 4);
});

test("context growth datums drill only with a real anchor", () => {
  const markup = contextGrowthChartHtml(CONTEXT_SERIES);

  assert.match(
    markup,
    /<circle class="chart-point chart-datum-link" aria-label="Turn 1, context 100 \(M\)" data-event-id="evt_user_1"/,
  );
  assert.match(
    markup,
    /<circle class="chart-point" aria-label="Turn 3, context 300 \(M\), no event to open" cx=/,
  );
});

test("context growth counts unavailable turns and unplaced compactions", () => {
  const markup = contextGrowthChartHtml(CONTEXT_SERIES);

  assert.match(markup, /1 turn has no context recorded\./);
  assert.match(markup, /1 compaction could not be placed on a turn\./);
  assert.match(markup, /Unavailable gap/);
});

test("an unavailable context turn draws the dashed gap cue the legend promises", () => {
  const markup = contextGrowthChartHtml(CONTEXT_SERIES);

  assert.match(
    markup,
    /class="chart-unavailable chart-datum-link" aria-label="Turn 2, context not recorded \(—\)" data-event-id="evt_user_2"/,
  );
  assert.match(markup, /width="10" height="10" rx="2" fill="none" stroke-dasharray="3 3"/);
});

test("compaction markers are dashed vertical lines with their event ID", () => {
  const markup = contextGrowthChartHtml(CONTEXT_SERIES);

  assert.match(markup, /class="chart-marker chart-datum-link"/);
  assert.match(markup, /data-event-id="evt_comp_1"/);
  assert.match(markup, /stroke-dasharray="4 4"/);
  assert.match(markup, />Compaction 1<\/text>/);
  assert.match(markup, /removed 40 tokens \(D\)/);
});

// ---------------------------------------------------------------------------
// Token chart
// ---------------------------------------------------------------------------

test("token chart lists the five segments including reasoning", () => {
  const markup = tokenChartHtml(TOKEN_SERIES);
  const legend = markup.slice(markup.indexOf('class="chart-legend"'));

  assert.match(markup, /aria-label="Token usage per turn, five segments"/);
  for (const label of ["Input", "Cache read", "Cache write", "Reasoning", "Output"]) {
    assert.match(legend, new RegExp(`>${label}<`));
  }
  assert.match(markup, /Turn 1, input 10 tokens \(M\)/);
  assert.match(markup, /Turn 1, cache read 300 tokens \(M\)/);
  assert.match(markup, /Turn 1, cache write 40 tokens \(M\)/);
  assert.match(markup, /Turn 1, reasoning 5 tokens \(M\)/);
  assert.match(markup, /Turn 1, output 20 tokens \(M\)/);
});

test("a partial token turn gets the dashed cue and says so in aria", () => {
  const markup = tokenChartHtml(TOKEN_SERIES);

  assert.match(markup, /class="chart-partial"/);
  assert.match(markup, /stroke-dasharray="3 3"/);
  assert.match(markup, /Turn 2, input 5 tokens \(—\), partial: recorded subset only/);
  assert.match(markup, /1 turn recorded only part of its tokens\./);
  assert.match(markup, />Partial turn</);
});

test("a turn with no recorded tokens renders the dashed Not recorded slot", () => {
  const markup = tokenChartHtml(TOKEN_UNRECORDED_SERIES);

  assert.match(markup, /Turn 1, tokens not recorded \(—\)/);
  assert.match(markup, />Not recorded<\/text>/);
  assert.match(markup, /stroke-dasharray="3 3"/);
  assert.match(markup, /data-event-id="evt_user_1"/);
  assert.match(markup, /1 turn recorded no step tokens\./);
  assert.doesNotMatch(markup, /0 tokens \(M\)/);
  assert.doesNotMatch(markup, /class="chart-partial"/);
});

test("token datums without an anchor are not drill targets", () => {
  const markup = tokenChartHtml(TOKEN_SERIES);

  assert.match(markup, /data-event-id="evt_user_1"/);
  assert.match(
    markup,
    /Turn 2, input 5 tokens \(—\), partial: recorded subset only, no event to open/,
  );
  assert.doesNotMatch(markup, /data-event-id=""/);
  assert.doesNotMatch(markup, /data-jump-step=""/);
});

// ---------------------------------------------------------------------------
// Cost chart
// ---------------------------------------------------------------------------

test("cost chart marks every tied highest-cost turn with text and aria", () => {
  const markup = costChartHtml(COST_SERIES);

  assert.match(markup, /aria-label="Cost per turn by model, USD"/);
  assert.equal((markup.match(/>Highest cost<\/text>/g) ?? []).length, 2);
  assert.match(markup, /Turn 1, cost \$0\.5000 \(M\), prov-a\/model-a, provider prov-a, highest cost/);
  assert.match(markup, /Turn 3, cost \$0\.5000 \(M\), prov-b\/model-b, highest cost/);
  assert.doesNotMatch(markup, /Turn 2, cost not recorded \(—\), prov-b\/model-b, highest cost/);
});

test("cost chart reports a provider only where a step recorded one", () => {
  const markup = costChartHtml(COST_SERIES);

  assert.ok(markup.includes("provider prov-a"));
  assert.doesNotMatch(markup, /provider prov-b/);
  assert.match(markup, /prov-b\/model-b/);
});

test("cost chart renders a dashed Not recorded slot for a missing cost", () => {
  const markup = costChartHtml(COST_SERIES);

  assert.match(markup, /class="chart-unavailable chart-datum-link"/);
  assert.match(markup, /Turn 2, cost not recorded \(—\), prov-b\/model-b/);
  assert.match(markup, />Not recorded<\/text>/);
  assert.match(markup, /style="fill: none; stroke: var\(--border-strong\)"/);
  assert.match(markup, /1 turn recorded no cost\./);
});

test("cost legend groups the distinct models", () => {
  const markup = costChartHtml(COST_SERIES);
  const legend = markup.slice(markup.indexOf('class="chart-legend"'));

  assert.ok(legend.includes("prov-a/model-a"));
  assert.ok(legend.includes("prov-b/model-b"));
  assert.match(legend, />Not recorded</);
});

test("cost axis labels use the cost formatter below one dollar", () => {
  const series = {
    empty: false,
    unavailableCount: 0,
    points: [
      {
        turnIndex: 1,
        anchor: "evt_user_1",
        cost: { value: 0.4, basis: "measured", available: true },
        modelKey: "prov-a/model-a",
        modelLabel: "prov-a/model-a",
        providerLabel: null,
      },
    ],
    models: [{ key: "prov-a/model-a", label: "prov-a/model-a" }],
    max: { value: 0.4, turnIndices: [1] },
  };
  const markup = costChartHtml(series);

  assert.match(markup, /aria-label="Cost per turn by model, USD"/);
  assert.match(markup, />\$0\.4000<\/text>/);
  assert.match(markup, />\$0\.2000<\/text>/);
  assert.match(markup, />\$0<\/text>/);
  assert.doesNotMatch(markup, />400<\/text>/);
  assert.doesNotMatch(markup, />200<\/text>/);
});

test("an all-zero cost session draws no highest-cost mark", () => {
  const markup = costChartHtml({
    empty: false,
    unavailableCount: 0,
    points: [
      {
        turnIndex: 1,
        anchor: "evt_user_1",
        cost: { value: 0, basis: "measured", available: true },
        modelKey: "prov-a/model-a",
        modelLabel: "prov-a/model-a",
        providerLabel: null,
      },
    ],
    models: [{ key: "prov-a/model-a", label: "prov-a/model-a" }],
    max: { value: 0, turnIndices: [] },
  });

  assert.doesNotMatch(markup, /Highest cost/);
  assert.doesNotMatch(markup, /, highest cost/);
});

// ---------------------------------------------------------------------------
// Duration chart
// ---------------------------------------------------------------------------

test("duration chart stacks model, tool and residual per step", () => {
  const markup = durationChartHtml(DURATION_SERIES);

  assert.match(markup, /aria-label="Step duration breakdown"/);
  assert.match(markup, /Step 1\.1, model time 300 ms \(M\)/);
  assert.match(markup, /Step 1\.1, tool time 100 ms \(M\)/);
  assert.match(markup, /Step 1\.1, residual time 100 ms \(D\)/);
  assert.match(markup, /data-jump-step="evt_step_1_1"/);
});

test("duration segments missing from a step are omitted, not zero-filled", () => {
  const markup = durationChartHtml(DURATION_SERIES);

  assert.match(markup, /Step 1\.2, model time 200 ms \(M\), no event to open/);
  assert.doesNotMatch(markup, /Step 1\.2, tool time/);
  assert.doesNotMatch(markup, /Step 1\.2, residual time/);
});

test("a step with no durations renders the dashed Not recorded slot", () => {
  const markup = durationChartHtml(DURATION_SERIES);

  assert.match(markup, /Step 2\.1, durations not recorded \(—\)/);
  assert.match(markup, /data-jump-step="evt_step_2_1"/);
  assert.match(markup, />Not recorded<\/text>/);
  assert.match(markup, /1 step recorded no durations\./);
});

test("duration axis ticks keep the duration unit", () => {
  const markup = durationChartHtml(DURATION_SERIES);

  assert.match(markup, />500 ms<\/text>/);
  assert.match(markup, />0 ms<\/text>/);
});

// ---------------------------------------------------------------------------
// Empty states, section wrapper and the keyboard data list
// ---------------------------------------------------------------------------

test("every chart renders sentence-case empty copy instead of a frame", () => {
  const empty = { empty: true, reason: "no turns in this analysis", points: [] };

  for (const markup of [
    contextGrowthChartHtml(empty),
    tokenChartHtml(empty),
    costChartHtml(empty),
    durationChartHtml(empty),
  ]) {
    assert.match(markup, /class="chart-empty"/);
    assert.match(markup, />No turns in this analysis\.</);
    assert.doesNotMatch(markup, /<svg /);
  }

  assert.equal(chartEmptyStateHtml(""), '<p class="chart-empty">No chart data.</p>');
});

test("chartSectionHtml wraps a chart with its heading, caption and id", () => {
  const section = chartSectionHtml({
    id: "context",
    title: "Context growth",
    caption: "Session total — seq 1–10",
    inner: "<p>chart</p>",
  });

  assert.match(section, /^<section class="chart-section" id="chart-context" aria-labelledby="chart-context-title">/);
  assert.match(section, /<h3 class="chart-title" id="chart-context-title">Context growth<\/h3>/);
  assert.match(section, /<span class="chart-caption">Session total — seq 1–10<\/span>/);
  assert.match(section, /<p>chart<\/p>\s*<\/section>$/);
  assert.doesNotMatch(
    chartSectionHtml({ id: "cost", title: "Cost", caption: "", inner: "" }),
    /chart-caption/,
  );
});

test("the Chart data list is real buttons for both anchor kinds", () => {
  const list = chartDataListHtml([
    { label: "Turn 1", value: "context 100 (M)", anchor: "evt_user_1" },
    { label: "Step 1.1", value: "model time 300 ms (M)", anchor: "evt_step_1_1", kind: "step" },
    { label: "Turn 3", value: "context not recorded (—)", anchor: null },
  ]);

  assert.match(list, /^<details class="chart-data"><summary>Chart data<\/summary>/);
  assert.match(list, /<button type="button" class="chart-data-row" data-event-id="evt_user_1"/);
  assert.match(list, /<button type="button" class="chart-data-row" data-jump-step="evt_step_1_1"/);
  assert.match(
    list,
    /<button type="button" class="chart-data-row" aria-label="Turn 3, context not recorded \(—\), no event to open">/,
  );
  assert.equal((list.match(/<button /g) ?? []).length, 3);
  assert.equal(chartDataListHtml([]), "");
});

test("each rendered chart ends with its Chart data list", () => {
  for (const markup of [
    contextGrowthChartHtml(CONTEXT_SERIES),
    tokenChartHtml(TOKEN_SERIES),
    costChartHtml(COST_SERIES),
    durationChartHtml(DURATION_SERIES),
  ]) {
    assert.match(markup, /<details class="chart-data"><summary>Chart data<\/summary>/);
    assert.match(markup, /<\/details>$/);
  }
});

// ---------------------------------------------------------------------------
// Token hygiene
// ---------------------------------------------------------------------------

test("emitted paint uses var(--token) only, with no hex literal", () => {
  const markups = [
    contextGrowthChartHtml(CONTEXT_SERIES),
    tokenChartHtml(TOKEN_SERIES),
    costChartHtml(COST_SERIES),
    durationChartHtml(DURATION_SERIES),
  ];

  for (const markup of markups) {
    const styles = styleAttributes(markup);
    assert.ok(styles.length > 0);
    for (const style of styles) assert.doesNotMatch(style, /#/);
    // var() is invalid in SVG presentation attributes; paint must be inline style.
    assert.doesNotMatch(markup, /(?:fill|stroke)="var\(/);
    assert.match(markup, /var\(--/);
  }

  const allStyles = markups.flatMap(styleAttributes).join(" ");
  assert.match(allStyles, /var\(--accent\)/);
  assert.match(allStyles, /var\(--grid\)/);
  assert.match(allStyles, /var\(--border-strong\)/);
  assert.doesNotMatch(allStyles, /#[0-9a-fA-F]{3,8}\b/);
});

test("charts.js imports the two pure UI modules only and touches no DOM", async () => {
  const source = await readFile(new URL("../src/ui/charts.js", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(["./format.js", "./charts-data.js"].includes(specifier), specifier);
  }
  assert.ok(specifiers.includes("./format.js"));
  assert.doesNotMatch(source, /(^|[^\w.])document\./m);
  assert.doesNotMatch(source, /(^|[^\w.])window\./m);
});

// ---------------------------------------------------------------------------
// Statistics wiring (P3) — source-text assertions on app.js
// ---------------------------------------------------------------------------

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

/** Body of one top-level function, up to the next top-level declaration. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const next = source.indexOf("\nfunction ", start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("app.js imports the chart data builders and the renderers", async () => {
  const source = await appSource();

  assert.match(source, /} from "\.\/charts-data\.js";/);
  assert.match(source, /} from "\.\/charts\.js";/);
  for (const name of [
    "buildContextGrowthSeries",
    "buildTokenSeries",
    "buildCostSeries",
    "buildDurationSeries",
    "chartWindowCaption",
    "chartSectionHtml",
    "contextGrowthChartHtml",
    "tokenChartHtml",
    "costChartHtml",
    "durationChartHtml",
  ]) {
    assert.ok(source.includes(name), `${name} is not imported or used`);
  }
});

test("the Table/Charts sub-tab renders only after the Advanced gate", async () => {
  const statistics = functionBody(await appSource(), "function renderStatistics()");

  assert.match(
    statistics,
    /<div class="segmented" role="group" aria-label="Statistics view">/,
  );
  assert.match(
    statistics,
    /data-stats-tab="table" aria-pressed="\$\{state\.statsTab === "table"\}"/,
  );
  assert.match(
    statistics,
    /data-stats-tab="charts" aria-pressed="\$\{state\.statsTab === "charts"\}"/,
  );

  const gate = statistics.indexOf('if (state.viewMode === "basic")');
  assert.ok(gate >= 0, "the Basic/Advanced gate is missing");
  assert.ok(statistics.indexOf("renderStatisticsBasic()") > gate);
  assert.ok(statistics.indexOf("renderStatisticsBasic()") < statistics.indexOf("data-stats-tab"));
  assert.ok(statistics.indexOf("data-stats-tab") > gate);
});

test("the Charts pane replaces the table block and keeps the late sections", async () => {
  const statistics = functionBody(await appSource(), "function renderStatistics()");

  assert.match(statistics, /state\.statsTab === "charts"\s*\?\s*chartsPaneHtml\(analysis\)/);
  assert.match(statistics, /: `<div class="table-wrap">/);
  assert.ok(
    statistics.indexOf('state.statsTab === "charts"') < statistics.indexOf('class="basis-legend"'),
  );
  for (const kept of [
    "diagnosticsSectionHtml()",
    "compactionCardsHtml()",
    "Unattached events",
  ]) {
    assert.ok(statistics.indexOf(kept) > statistics.indexOf('state.statsTab === "charts"'), kept);
  }
});

test("renderStatisticsBasic stays free of chart markup and sub-tab controls", async () => {
  const basic = functionBody(await appSource(), "function renderStatisticsBasic()");

  assert.doesNotMatch(basic, /chart/i);
  assert.doesNotMatch(basic, /data-stats-tab|segmented/);
  assert.doesNotMatch(basic, /chartsPaneHtml/);
});

test("the Charts pane projects the loaded analysis with the current basis", async () => {
  const pane = functionBody(await appSource(), "function chartsPaneHtml(");

  assert.match(pane, /class="charts-pane"/);
  assert.match(pane, /chartWindowCaption\(analysis\)/);
  assert.match(pane, /buildContextGrowthSeries\(analysis, state\.contextBasis\)/);
  for (const builder of [
    "buildTokenSeries(analysis)",
    "buildCostSeries(analysis)",
    "buildDurationSeries(analysis)",
  ]) {
    assert.ok(pane.includes(builder), builder);
  }
  assert.equal((pane.match(/chartSectionHtml\(/g) ?? []).length, 4);
  // No new data path: charts reuse the analysis the tables render.
  assert.doesNotMatch(pane, /fetch\(|api\(|loadSessionData|state\.events/);
});

test("the four chart sections keep the documented order", async () => {
  const pane = functionBody(await appSource(), "function chartsPaneHtml(");
  const positions = ['id: "context"', 'id: "tokens"', 'id: "cost"', 'id: "duration"'].map((id) =>
    pane.indexOf(id),
  );

  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
  );
});

test("statsTab defaults to table and stays renderer-only state", async () => {
  const source = await appSource();
  const bind = functionBody(source, "function bindStatistics()");
  const loop = bind.slice(bind.indexOf("[data-stats-tab]"), bind.indexOf("const contextBasis"));

  assert.equal((source.match(/statsTab: "table"/g) ?? []).length, 1);
  assert.doesNotMatch(source, /get\("statsTab"\)|setSetting\("statsTab"/);
  assert.match(
    loop,
    /state\.statsTab = button\.dataset\.statsTab === "charts" \? "charts" : "table"/,
  );
  // The sub-tab re-renders through the existing renderer: no route, no setting.
  assert.match(loop, /renderStatistics\(\);/);
  assert.doesNotMatch(loop, /updateHash|parseHash|setSetting/);
});

test("the statistics drill wiring keeps exactly the existing selectors", async () => {
  const bind = functionBody(await appSource(), "function bindStatistics()");

  assert.equal((bind.match(/"\[data-jump-step\]"/g) ?? []).length, 1);
  assert.equal(
    (bind.match(/"\[data-event-id\]:not\(\[data-open-incident\]\)"/g) ?? []).length,
    1,
  );
  assert.match(bind, /jumpToEvent\(button\.dataset\.jumpStep\)/);
  assert.match(bind, /jumpToEvent\(eventID\)/);

  const selectors = [...bind.matchAll(/querySelectorAll\(\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    selectors.filter((selector) => selector.startsWith("[data-")),
    ["[data-stats-tab]", "[data-jump-step]", "[data-event-id]:not([data-open-incident])", "[data-session-id]"],
  );
});

test("table-only controls are skipped in Charts mode but kept for the table", async () => {
  const statistics = functionBody(await appSource(), "function renderStatistics()");
  const branch = /state\.statsTab === "table"\s*\n\s*\? `([\s\S]*?)`\s*\n\s*: ""/.exec(
    statistics,
  );

  assert.ok(branch, "the table-only control branch is missing");
  const tableOnly = branch[1];
  for (const id of ["show-event-rows", "response-limit", "expand-all"]) {
    assert.ok(tableOnly.includes(`id="${id}"`), id);
  }
  // Chart 1 follows the basis selector, so it stays visible in both modes.
  assert.ok(!tableOnly.includes('id="context-basis"'));
  assert.ok(statistics.includes('id="context-basis"'));
  // The copy actions are not table-specific either.
  assert.ok(!tableOnly.includes('id="copy-digest"'));
  assert.ok(statistics.includes('id="copy-digest"'));
});
