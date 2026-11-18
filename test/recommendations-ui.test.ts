import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  HYPOTHESIS_DISCLAIMER,
  MAX_EVENT_LINKS,
  MAX_RECOMMENDATION_ROWS,
  recommendationsSectionHtml,
  // @ts-expect-error - plain browser module without type declarations
} from "../src/ui/recommendations.js";

interface Row {
  id: string;
  kind: "fact" | "hypothesis";
  severity: "info" | "advisory";
  ruleID: string;
  label: string;
  note: string;
  eventIDs: string[];
  turnIDs: string[];
}

function fact(overrides: Partial<Row> = {}): Row {
  return {
    id: "reduce-context:fact",
    kind: "fact",
    severity: "info",
    ruleID: "reduce-context",
    label: "Context growth",
    note: "Health rule \"Context growth\" is triggered (watch): 5 turn(s) added context.",
    eventIDs: [],
    turnIDs: [],
    ...overrides,
  };
}

function hypothesis(overrides: Partial<Row> = {}): Row {
  return {
    id: "reduce-context:hypothesis",
    kind: "hypothesis",
    severity: "advisory",
    ruleID: "reduce-context",
    label: "Trim or summarize in-turn context",
    note: "Hypothesis: trimming or summarizing in-turn context may keep the growth run shorter.",
    eventIDs: ["msg_a1:0"],
    turnIDs: [],
    ...overrides,
  };
}

function recommendations(overrides: Record<string, unknown> = {}) {
  return {
    rows: [fact(), hypothesis()],
    basisNotes: [
      "Recommendations are derived from this analysis: diagnostics incidents, session health rules, turns, compactions and attribution rows.",
      "Rows follow the fixed rule order, fact before its hypothesis; no numeric ordering artifact is computed.",
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test("the section lists a fact and its hypothesis with counts and a rail", () => {
  const markup = recommendationsSectionHtml(recommendations());

  assert.match(markup, /class="recommendations-section"/);
  assert.match(markup, /aria-label="Recommendations"/);
  assert.match(markup, /Recommendations<\/h2>/);
  assert.match(markup, /1 fact · 1 hypothesis/);
  assert.match(markup, /Sources — health/);
  assert.match(markup, /class="recommendation-row recommendation-fact"/);
  assert.match(markup, /class="recommendation-row recommendation-hypothesis"/);
  assert.match(markup, /data-rule="reduce-context"/);
  assert.match(markup, /data-source="health"/);
});

test("facts and hypotheses are visually distinguished, never by colour alone", () => {
  const markup = recommendationsSectionHtml(recommendations());
  const factRow = markup.slice(
    markup.indexOf('recommendation-fact"'),
    markup.indexOf('recommendation-hypothesis"'),
  );
  const hypothesisRow = markup.slice(markup.indexOf('recommendation-hypothesis"'));

  // The kind is carried as text in both rows.
  assert.match(factRow, />Fact</);
  assert.doesNotMatch(factRow, /recommendation-disclaimer/);
  assert.match(hypothesisRow, />Hypothesis</);
  assert.match(hypothesisRow, /class="recommendation-disclaimer"/);
  // Only the hypothesis carries the uncertain copy.
  assert.equal((markup.match(/hypothesis — not a diagnosis/g) ?? []).length, 1);
  assert.ok(HYPOTHESIS_DISCLAIMER.includes("not a diagnosis"));
});

test("evidence drills through the existing data-event-id binding", () => {
  const markup = recommendationsSectionHtml(
    recommendations({
      rows: [
        fact({
          ruleID: "retry-failed-tool",
          label: "Unrecovered tool failures",
          note: "1 incident(s) across 1 tool(s) have no recovery evidence.",
          eventIDs: ["msg_a1:1"],
        }),
      ],
    }),
  );

  assert.match(markup, /data-event-id="msg_a1:1"/);
  assert.match(markup, /class="link-button recommendation-link"/);
  assert.match(markup, /aria-label="Open event 1 of recommendation 1 in Trajectory"/);
  assert.equal((markup.match(/aria-label="Open event/g) ?? []).length, 1);
  assert.match(markup, /data-source="diagnostics"/);
});

test("the provenance rail names each source layer on screen", () => {
  const markup = recommendationsSectionHtml(
    recommendations({
      rows: [
        fact(),
        hypothesis(),
        fact({
          id: "concentrated-file-cost:fact",
          ruleID: "concentrated-file-cost",
          label: "Concentrated file cost",
          note: "src/hot.ts carries 67% of the attributed file cost ($0.02 across 1 turn(s)).",
          eventIDs: ["msg_a1:0"],
        }),
        hypothesis({
          id: "retry-failed-tool:hypothesis",
          ruleID: "retry-failed-tool",
          label: "Verify the tool precondition before retrying",
          note: "Hypothesis: retrying shell immediately may repeat the same failure.",
          eventIDs: ["msg_a1:1"],
        }),
      ],
    }),
  );

  assert.match(markup, /Sources — health · attribution · diagnostics/);
  assert.match(markup, /data-source="attribution"/);
  assert.match(markup, /2 facts · 2 hypotheses/);
});

test("an absent, empty or malformed rider renders nothing", () => {
  assert.equal(recommendationsSectionHtml(undefined), "");
  assert.equal(recommendationsSectionHtml(null), "");
  assert.equal(recommendationsSectionHtml({}), "");
  assert.equal(recommendationsSectionHtml({ rows: [] }), "");
  assert.equal(recommendationsSectionHtml({ rows: "nope" }), "");
  assert.equal(recommendationsSectionHtml({ rows: [{ id: "x" }] }), "");
});

test("rows and evidence are capped in the renderer", () => {
  const rows = Array.from({ length: MAX_RECOMMENDATION_ROWS + 6 }, (_, index) =>
    fact({
      id: `rule${index}:fact`,
      ruleID: "split-task",
      label: `Finding ${index}`,
      note: `Turn ${index} recorded 12 step(s).`,
      eventIDs: Array.from({ length: MAX_EVENT_LINKS + 4 }, (_, id) => `evt_${index}_${id}`),
    }),
  );
  const markup = recommendationsSectionHtml(recommendations({ rows }));

  assert.equal((markup.match(/class="recommendation-row /g) ?? []).length, MAX_RECOMMENDATION_ROWS);
  assert.equal(
    (markup.match(/data-event-id="evt_0_\d+"/g) ?? []).length,
    MAX_EVENT_LINKS,
  );
});

test("every dynamic string is escaped", () => {
  const markup = recommendationsSectionHtml({
    rows: [
      fact({
        ruleID: '<img src=x onerror="alert(1)">',
        label: "<script>alert(1)</script>",
        note: '<b>note</b> "quoted"',
        eventIDs: ['evt"1'],
      }),
    ],
    basisNotes: ["<i>basis</i>"],
  });

  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /<img /);
  assert.doesNotMatch(markup, /<b>note<\/b>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;b&gt;note&lt;\/b&gt;/);
  assert.match(markup, /data-event-id="evt&quot;1"/);
  assert.match(markup, /&lt;i&gt;basis&lt;\/i&gt;/);
});

test("the builder carries the standing determinism note and no ranking attributes", () => {
  const markup = recommendationsSectionHtml(recommendations());

  assert.match(markup, /Local and deterministic — derived from recorded data, never ranked\./);
  assert.match(markup, /Rows follow the fixed rule order/);
  assert.doesNotMatch(markup, /data-(score|priority|rank|weight)=/i);
  assert.doesNotMatch(markup, /\b(best|top pick|winner)\b/i);
});

test("the builder module is DOM-free and only imports ./format.js", async () => {
  const source = await readFile(
    new URL("../src/ui/recommendations.js", import.meta.url),
    "utf8",
  );
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(specifiers, ["./format.js"]);
  assert.doesNotMatch(source, /(^|[^\w.])document\./m);
  assert.doesNotMatch(source, /(^|[^\w.])window\./m);
  assert.doesNotMatch(source, /fetch\(/);
});

// ---------------------------------------------------------------------------
// app.js wiring
// ---------------------------------------------------------------------------

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

/** One function's source, up to the first `}` in column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  let end = -1;
  for (
    let index = source.indexOf("\n}", start + header.length);
    index !== -1;
    index = source.indexOf("\n}", index + 2)
  ) {
    const after = source[index + 2];
    if (after === undefined || after === "\n" || after === "\r") {
      end = index + 2;
      break;
    }
  }
  return source.slice(start, end === -1 ? source.length : end);
}

test("renderStatistics renders the section after attribution and before the legend", async () => {
  const source = await appSource();
  const body = functionBody(source, "function renderStatistics()");

  const attribution = body.indexOf("attributionSectionHtml(analysis.attribution)");
  const section = body.indexOf("recommendationsSectionHtml(analysis.recommendations)");
  const legend = body.indexOf('<div class="basis-legend">');

  assert.ok(attribution >= 0 && section >= 0 && legend >= 0);
  assert.ok(section > attribution, "the section sits after task attribution");
  assert.ok(section < legend, "the section sits above the basis legend");
  assert.match(
    source,
    /import \{ recommendationsSectionHtml \} from "\.\/recommendations\.js";/,
  );
});

test("Basic mode renders no recommendation markup", async () => {
  const source = await appSource();
  const basic = functionBody(source, "function renderStatisticsBasic()");

  assert.ok(basic.length > 0);
  assert.doesNotMatch(basic, /recommendation/i);
});

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

test("recommendation styles reuse tokens only and never warn as text", async () => {
  const css = await readFile(
    new URL("../src/ui/styles.css", import.meta.url),
    "utf8",
  );
  const start = css.lastIndexOf("/*", css.indexOf("recommendations */"));
  const end = css.lastIndexOf("/*", css.indexOf("drawer */"));
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end);

  assert.match(block, /\.recommendations-section \{/);
  assert.match(block, /\.recommendation-row \{/);
  assert.match(block, /\.recommendation-hypothesis \{/);
  assert.match(block, /border-style: dashed/);
  assert.match(block, /var\(--surface-2\)/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(block, /color:\s*var\(--warning\)/);
  assert.doesNotMatch(block, /!important/);
});
