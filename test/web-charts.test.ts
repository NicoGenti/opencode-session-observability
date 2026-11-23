import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CHART_DATA_SUMMARY,
  CHART_GRID_ROWS,
  CHART_HEIGHT,
  CHART_LEGEND,
  CHART_PAD,
  CHART_SECTION_IDS,
  CHART_SECTIONS,
  CHART_TONE_CLASS,
  CHART_TONE_TOKEN,
  CHART_TONES,
  CHART_WIDTH,
  COST_AXIS_UNIT,
  COST_MODEL_TONES,
  DURATION_SEGMENTS,
  NOT_RECORDED_LABEL,
  TOKEN_SEGMENTS,
  axisTicks,
  barSize,
  chartA11y,
  chartAriaLabel,
  chartDomainMax,
  formatAxisValue,
  modelTone,
  swatchClass,
  tickEvery,
  toneClass,
} from "../src/web/lib/chart-config.ts";
import { normalizeContextBasis } from "../src/web/lib/chart-data.ts";

const CHART_SOURCES = [
  "../src/web/lib/chart-data.ts",
  "../src/web/lib/chart-config.ts",
  "../src/web/components/charts/ChartsPane.tsx",
  "../src/web/components/charts/ContextGrowthChart.tsx",
  "../src/web/components/charts/TokenChart.tsx",
  "../src/web/components/charts/CostChart.tsx",
  "../src/web/components/charts/DurationChart.tsx",
  "../src/web/components/charts/ChartDataList.tsx",
] as const;

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

async function chartStyleBlock(): Promise<string> {
  const css = await source("../src/web/styles/index.css");
  const marker = "/* ---------------------------------------------------------------- charts */";
  const start = css.indexOf(marker);
  assert.ok(start >= 0, "the charts style block is missing");
  return css.slice(start);
}

/* ------------------------------------------------------------------ canvas */

test("charts: the canvas keeps the legacy fixed 720x220 geometry", () => {
  assert.equal(CHART_WIDTH, 720);
  assert.equal(CHART_HEIGHT, 220);
  assert.deepEqual(
    { ...CHART_PAD },
    { left: 56, right: 16, top: 16, bottom: 30 },
  );
  assert.equal(CHART_GRID_ROWS, 4);
  assert.equal(CHART_GRID_ROWS + 1, axisTicks(1_000).length);
});

test("charts: every chart is a fixed canvas inside the horizontal scroll pane", async () => {
  for (const file of [
    "../src/web/components/charts/ContextGrowthChart.tsx",
    "../src/web/components/charts/TokenChart.tsx",
    "../src/web/components/charts/CostChart.tsx",
    "../src/web/components/charts/DurationChart.tsx",
  ] as const) {
    const text = await source(file);
    assert.match(text, /className="chart-scroll"/, file);
    assert.match(text, /width=\{CHART_WIDTH\}/, file);
    assert.match(text, /height=\{CHART_HEIGHT\}/, file);
    assert.doesNotMatch(text, /ResponsiveContainer/, file);
    assert.doesNotMatch(text, /useWindowSize|window\.innerWidth|autoSize/, file);
  }
});

/* ------------------------------------------------------------------- paint */

test("charts: each tone names one token and one CSS class defined in index.css", async () => {
  const css = await chartStyleBlock();
  const seen = new Set<string>();

  for (const tone of CHART_TONES) {
    const className = CHART_TONE_CLASS[tone];
    const token = CHART_TONE_TOKEN[tone];
    assert.equal(seen.has(className), false, `${className} is reused`);
    seen.add(className);
    assert.match(className, /^chart-series-[a-z]+$/);
    assert.match(token, /^--(accent|good|warning|serious|critical|muted)$/);

    const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`);
    const match = rule.exec(css);
    assert.ok(match, `.${className} is missing from index.css`);
    assert.match(match[1] ?? "", new RegExp(`fill:\\s*var\\(${token}\\)`));
    assert.match(match[1] ?? "", new RegExp(`stroke:\\s*var\\(${token}\\)`));
    assert.match(css, new RegExp(`\\.chart-swatch-${tone}\\s*\\{\\s*background:\\s*var\\(${token}\\)`));
  }
});

test("charts: --warning never paints text", async () => {
  const css = await chartStyleBlock();
  assert.doesNotMatch(css, /color:\s*var\(--warning\)/);
  assert.doesNotMatch(css, /--warning[^;]*text/i);

  const warningRule = /\.chart-series-warning\s*\{([^}]*)\}/.exec(css);
  assert.ok(warningRule);
  assert.doesNotMatch(warningRule[1] ?? "", /color\s*:/);
  assert.equal(CHART_TONE_CLASS.warning, "chart-series-warning");
  assert.equal(
    TOKEN_SEGMENTS.find((segment) => segment.key === "cacheWrite")?.tone,
    "warning",
  );
});

test("charts: grid, axes, legend and marks resolve to the DESIGN tokens", async () => {
  const css = await chartStyleBlock();
  assert.match(css, /\.chart-canvas \.recharts-cartesian-grid line\s*\{[^}]*var\(--grid\)/);
  assert.match(css, /\.chart-axis-label\s*\{[^}]*fill:\s*var\(--muted\)/);
  assert.match(css, /\.chart-highest\s*\{[^}]*fill:\s*var\(--text-2\)/);
  assert.match(css, /\.chart-unavailable-slot\s*\{[^}]*stroke:\s*var\(--border-strong\)/);
  assert.match(css, /\.chart-unavailable-slot\s*\{[^}]*stroke-dasharray:\s*3 3/);
  assert.match(css, /\.chart-partial\s*\{[^}]*stroke:\s*var\(--border-strong\)/);
  assert.match(css, /\.chart-marker line\s*\{[^}]*stroke:\s*var\(--accent\)/);
  assert.match(css, /\.chart-marker line\s*\{[^}]*stroke-dasharray:\s*4 4/);
  assert.match(css, /\.chart-marker text\s*\{[^}]*fill:\s*var\(--muted\)/);
  assert.match(css, /\.chart-legend[^}]*color:\s*var\(--muted\)/);
});

test("charts: no chart source contains a colour literal or an SVG var() attribute", async () => {
  for (const file of CHART_SOURCES) {
    const text = await source(file);
    assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/, `${file} has a hex literal`);
    assert.doesNotMatch(text, /\brgba?\s*\(/, `${file} has an rgb literal`);
    assert.doesNotMatch(text, /\bhsla?\s*\(/, `${file} has an hsl literal`);
    assert.doesNotMatch(text, /(?:fill|stroke|color)="var\(--/, file);
    assert.doesNotMatch(text, /style=\{\{/, `${file} injects an inline style`);
  }

  const css = await chartStyleBlock();
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\brgba?\s*\(/);
  assert.doesNotMatch(css, /\bhsla?\s*\(/);
});

test("charts: series colours stay one accent first with quiet neutrals", () => {
  assert.deepEqual([...COST_MODEL_TONES], [
    "accent",
    "good",
    "serious",
    "warning",
    "critical",
    "muted",
  ]);
  assert.equal(modelTone(0), "accent");
  assert.equal(modelTone(6), "accent");
  assert.equal(modelTone(-1), "muted");
  assert.equal(toneClass("accent"), "chart-series-accent chart-datum");
  assert.equal(swatchClass("muted"), "chart-swatch chart-swatch-muted");
  assert.deepEqual(
    DURATION_SEGMENTS.map((segment) => segment.tone),
    ["accent", "good", "muted"],
  );
  assert.deepEqual(
    TOKEN_SEGMENTS.map((segment) => segment.tone),
    ["accent", "good", "warning", "serious", "muted"],
  );
});

test("charts: scaffolding classes the components use exist in the token stylesheet", async () => {
  const css = await chartStyleBlock();
  for (const className of [
    "charts-pane",
    "chart-section",
    "chart-section-head",
    "chart-title",
    "chart-caption",
    "chart-scroll",
    "chart-canvas",
    "chart-axis-label",
    "chart-unavailable-slot",
    "chart-unavailable-label",
    "chart-partial",
    "chart-marker",
    "chart-highest",
    "chart-datum-link",
    "chart-legend",
    "chart-legend-item",
    "chart-swatch",
    "chart-note",
    "chart-empty",
    "chart-data",
    "chart-data-row",
    "chart-data-label",
    "chart-data-value",
  ]) {
    assert.ok(css.includes(`.${className}`), `.${className} is missing`);
  }
});

/* ---------------------------------------------------------------- structure */

test("charts: the four sections keep the documented order and titles", () => {
  assert.deepEqual([...CHART_SECTION_IDS], ["context", "tokens", "cost", "duration"]);
  assert.deepEqual(
    CHART_SECTIONS.map((section) => section.id),
    ["context", "tokens", "cost", "duration"],
  );
  assert.deepEqual(
    CHART_SECTIONS.map((section) => section.title),
    ["Context growth", "Token usage", "Cost", "Step duration"],
  );
});

test("charts: each chart exposes role=img with exactly one chart-level label", () => {
  const labels = CHART_SECTION_IDS.map((id) => chartA11y(id));
  for (const attrs of labels) {
    assert.equal(attrs.role, "img");
    assert.equal(Object.keys(attrs).length, 2);
    assert.equal(typeof attrs["aria-label"], "string");
    assert.ok(attrs["aria-label"].length > 0);
  }
  assert.equal(labels.length, CHART_SECTIONS.length);
  assert.equal(chartAriaLabel("context", "latest"), "Context growth per turn, latest basis");
  assert.equal(
    chartAriaLabel("context", "cumulative"),
    "Context growth per turn, cumulative basis",
  );
  assert.match(chartAriaLabel("cost"), /USD/);
  assert.match(chartAriaLabel("tokens"), /five segments/);
  assert.equal(chartAriaLabel("duration"), "Step duration breakdown");
});

test("charts: the pane renders section shells, not a second heading per chart", async () => {
  const pane = await source("../src/web/components/charts/ChartsPane.tsx");
  assert.match(pane, /className="charts-pane"/);
  assert.match(pane, /className="chart-section"/);
  assert.match(pane, /aria-labelledby=\{headingID\}/);
  assert.equal((pane.match(/<ChartSection/g) ?? []).length, 1);
  assert.equal((pane.match(/CHART_SECTIONS\.map/g) ?? []).length, 1);
  for (const chart of [
    "ContextGrowthChart",
    "TokenChart",
    "CostChart",
    "DurationChart",
  ]) {
    assert.ok(pane.includes(`<${chart} `), chart);
  }
});

/* --------------------------------------------------------------- drill list */

test("charts: the drill list is a native details element with real buttons", async () => {
  const text = await source("../src/web/components/charts/ChartDataList.tsx");
  assert.match(text, /<details className="chart-data">/);
  assert.match(text, /<summary>\{CHART_DATA_SUMMARY\}<\/summary>/);
  assert.match(text, /<button/);
  assert.match(text, /type="button"/);
  assert.match(text, /"data-event-id": anchor/);
  assert.match(text, /"data-jump-step": anchor/);
  assert.match(text, /onClick = \(\) => onDrill\(anchor\)/);
  assert.match(text, /no event to open/);
  assert.equal(CHART_DATA_SUMMARY, "Chart data");
  assert.equal(NOT_RECORDED_LABEL, "Not recorded");
  assert.equal(CHART_LEGEND.notRecorded, "Not recorded");
  assert.doesNotMatch(text, /slice\(0, ?\d+\)|MAX_EVENT_LINKS|MAX_TURN_LINKS/);
});

/* ------------------------------------------------------------------ scales */

test("charts: cost ticks are USD and duration ticks keep their legacy unit", () => {
  assert.equal(COST_AXIS_UNIT, "USD");
  assert.equal(formatAxisValue("cost", 0.4), "$0.4000");
  assert.equal(formatAxisValue("cost", 0), "$0");
  assert.equal(formatAxisValue("duration", 500), "500 ms");
  assert.equal(formatAxisValue("duration", 1_500), "1.50 s");
  assert.equal(formatAxisValue("compact", 2_000), "2.0k");

  assert.deepEqual([...axisTicks(null)], [0]);
  assert.deepEqual([...axisTicks(0)], [0]);
  assert.deepEqual([...axisTicks(100)], [0, 25, 50, 75, 100]);
  assert.equal(chartDomainMax(null), 1);
  assert.equal(chartDomainMax(100), 100);
});

test("charts: label decimation and bar width keep the legacy geometry", () => {
  assert.equal(tickEvery(10), 1);
  assert.equal(tickEvery(25), 2);
  assert.equal(tickEvery(48), 2);
  assert.equal(tickEvery(100), 5);
  assert.equal(barSize(1), 34);
  assert.equal(barSize(3), 34);
  assert.equal(barSize(200), 4);
  assert.ok(Math.abs(barSize(30) - 11.88) < 1e-9);
  assert.equal(normalizeContextBasis("cumulative"), "cumulative");
  assert.equal(normalizeContextBasis("anything"), "latest");
});

/* ------------------------------------------------------------ no new fetch */

test("charts: the pane projects props.analysis straight through with no fetch", async () => {
  const pane = await source("../src/web/components/charts/ChartsPane.tsx");
  for (const builder of [
    "buildContextGrowthSeries(analysis, contextBasis)",
    "buildTokenSeries(analysis)",
    "buildCostSeries(analysis)",
    "buildDurationSeries(analysis)",
    "chartWindowCaption(analysis)",
  ]) {
    assert.ok(pane.includes(builder), builder);
  }
  assert.doesNotMatch(pane, /\bfetch\s*\(/);
  assert.doesNotMatch(pane, /useSessionAnalysis|useQuery|useMutation/);
  assert.doesNotMatch(pane, /\buseEffect\b|\buseState\b/);
  assert.doesNotMatch(pane, /\/api\/|analysis\?/);

  for (const file of CHART_SOURCES) {
    const text = await source(file);
    assert.doesNotMatch(text, /\bfetch\s*\(/, file);
  }

  const advanced = await source("../src/web/components/StatisticsAdvanced.tsx");
  assert.match(advanced, /<ChartsPane analysis=\{analysis\} contextBasis=\{contextBasis\} onDrill=\{onDrill\}/);
  assert.match(advanced, /statsTab === "charts"/);
  assert.doesNotMatch(advanced, /CHARTS_PLACEHOLDER/);
});

/* ---------------------------------------------------------------- no hover */

test("charts: no tooltip component or hover interaction beyond legacy click drill", async () => {
  for (const file of CHART_SOURCES) {
    const text = await source(file);
    assert.doesNotMatch(text, /<Tooltip|from "recharts"[^;]*Tooltip/s, file);
    assert.doesNotMatch(text, /onMouseEnter|onMouseMove|hoveredIndex|activeIndex/, file);
  }
  for (const file of [
    "../src/web/components/charts/ContextGrowthChart.tsx",
    "../src/web/components/charts/TokenChart.tsx",
    "../src/web/components/charts/CostChart.tsx",
    "../src/web/components/charts/DurationChart.tsx",
  ] as const) {
    const text = await source(file);
    assert.match(text, /isAnimationActive=\{false\}/, file);
    assert.match(text, /accessibilityLayer=\{false\}/, file);
  }
});
