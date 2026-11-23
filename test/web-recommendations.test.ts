import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RECOMMENDATION_ROWS,
  type Recommendation,
  type Recommendations,
} from "../src/core/recommendations.ts";
import { MAX_EVENT_LINKS } from "../src/core/health.ts";
import {
  HYPOTHESIS_DISCLAIMER,
  MAX_EVENT_LINKS as UI_MAX_EVENT_LINKS,
  MAX_RECOMMENDATION_ROWS as UI_MAX_RECOMMENDATION_ROWS,
  RECOMMENDATIONS_STANDING_NOTE,
  buildRecommendations,
} from "../src/web/lib/recommendations.ts";

function row(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "reduce-context:fact",
    kind: "fact",
    severity: "info",
    ruleID: "reduce-context",
    label: "Context grows across turns",
    note: "Longest growth run 3 turn(s); final context 90,000",
    eventIDs: ["evt-1"],
    turnIDs: ["turn-1"],
    ...overrides,
  };
}

function recommendations(overrides: Partial<Recommendations> = {}): Recommendations {
  return {
    rows: [row()],
    basisNotes: ["Every hypothesis ships with a fact row."],
    ...overrides,
  };
}

test("recommendations: a fact and its hypothesis render with counts and a source rail", () => {
  const model = buildRecommendations(
    recommendations({
      rows: [
        row(),
        row({
          id: "reduce-context:hypothesis",
          kind: "hypothesis",
          severity: "advisory",
          label: "Consider reducing context",
          note: "The context run reached 3 turn(s).",
        }),
      ],
    }),
  );
  assert.equal(model.empty, false);
  assert.equal(model.facts, 1);
  assert.equal(model.hypotheses, 1);
  assert.equal(model.counts, "1 fact · 1 hypothesis");
  assert.equal(model.rail, "Sources — health");
  assert.deepEqual(
    model.rows.map((entry) => entry.kindLabel),
    ["Fact", "Hypothesis"],
  );
});

test("recommendations: hypothesis rows keep the dashed disclaimer copy, facts stay plain", () => {
  const model = buildRecommendations(
    recommendations({
      rows: [row(), row({ id: "x:hypothesis", kind: "hypothesis", label: "Try this", note: "Because." })],
    }),
  );
  assert.equal(model.rows[0]?.disclaimer, null);
  assert.equal(model.rows[1]?.disclaimer, HYPOTHESIS_DISCLAIMER);
  assert.equal(HYPOTHESIS_DISCLAIMER, "hypothesis — not a diagnosis");
});

test("recommendations: the rail names every distinct source layer on screen", () => {
  const model = buildRecommendations(
    recommendations({
      rows: [
        row({ ruleID: "reduce-context" }),
        row({ id: "retry-failed-tool:fact", ruleID: "retry-failed-tool", label: "A tool failed twice", note: "Two failures." }),
        row({ id: "concentrated-file-cost:fact", ruleID: "concentrated-file-cost", label: "One file holds the cost", note: "Half the cost." }),
      ],
    }),
  );
  assert.equal(model.rail, "Sources — health · diagnostics · attribution");
});

test("recommendations: an absent, empty or malformed rider renders nothing", () => {
  assert.equal(buildRecommendations(null).empty, true);
  assert.equal(buildRecommendations({ rows: [], basisNotes: [] }).empty, true);
  assert.equal(buildRecommendations(undefined).empty, true);
  assert.equal(buildRecommendations(recommendations({ rows: [row({ label: "" })] })).empty, true);
});

test("recommendations: the UI caps mirror core", () => {
  assert.equal(UI_MAX_RECOMMENDATION_ROWS, MAX_RECOMMENDATION_ROWS);
  assert.equal(UI_MAX_EVENT_LINKS, MAX_EVENT_LINKS);
  assert.equal(MAX_RECOMMENDATION_ROWS, 11);
  assert.equal(MAX_EVENT_LINKS, 10);
});

test("recommendations: rows and evidence are capped in the model", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    row({
      id: `split-task:${index}`,
      ruleID: "split-task",
      label: `Row ${index + 1}`,
      note: "Fixed phrase.",
      eventIDs: Array.from({ length: 15 }, (_value, position) => `evt-${position + 1}`),
    }),
  );
  const model = buildRecommendations(recommendations({ rows }));
  assert.equal(model.rows.length, MAX_RECOMMENDATION_ROWS);
  assert.equal(model.rows[0]?.links.length, MAX_EVENT_LINKS);
});

test("recommendations: counts include only rows that actually render", () => {
  const model = buildRecommendations(
    recommendations({
      rows: [
        row(),
        row({ id: "x:hypothesis", kind: "hypothesis", label: "", note: "No label." }),
        row({ id: "y:fact", label: "Visible", note: "Kept." }),
      ],
    }),
  );
  assert.equal(model.rows.length, 2);
  assert.equal(model.facts, 2);
  assert.equal(model.hypotheses, 0);
  assert.equal(model.counts, "2 facts · 0 hypotheses");
  assert.equal(model.rail, "Sources — health");
});

test("recommendations: the standing note forbids ranking", () => {
  const model = buildRecommendations(recommendations());
  assert.equal(model.standingNote, RECOMMENDATIONS_STANDING_NOTE);
  assert.match(model.standingNote, /never ranked/);
  assert.doesNotMatch(JSON.stringify(model), /"score"/);
});

test("recommendations: evidence links keep their 1-based labels and drill ids", () => {
  const model = buildRecommendations(
    recommendations({ rows: [row({ eventIDs: ["evt-a", "evt-b"] })] }),
  );
  assert.deepEqual(
    model.rows[0]?.links.map((link) => [link.label, link.eventID]),
    [
      ["Event 1", "evt-a"],
      ["Event 2", "evt-b"],
    ],
  );
  assert.equal(model.rows[0]?.links[0]?.ariaLabel, "Open event 1 of recommendation 1 in Trajectory");
});

test("recommendations: an unknown rule falls back to the analysis source", () => {
  const model = buildRecommendations(
    recommendations({ rows: [row({ ruleID: "not-a-rule" as Recommendation["ruleID"] })] }),
  );
  assert.equal(model.rows[0]?.source, "analysis");
});
