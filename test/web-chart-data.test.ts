import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildContextGrowthSeries,
  buildCostSeries,
  buildDurationSeries,
  buildTokenSeries,
  chartWindowCaption,
  contextDataRows,
  contextMax,
  contextNotes,
  costDataRows,
  costNotes,
  durationDataRows,
  durationMax,
  durationNotes,
  durationTotal,
  metricPoint,
  sentenceCase,
  stepAnchor,
  tokenDataRows,
  tokenMax,
  tokenNotes,
  tokenTotal,
  turnAnchor,
} from "../src/web/lib/chart-data.ts";
import type {
  Analysis,
  Basis,
  Capabilities,
  CompactionTransaction,
  Coverage,
  Metric,
  ModelRef,
  Step,
  TokenUsage,
  Totals,
  Turn,
} from "../src/core/types.ts";

/* ------------------------------------------------------------------ fixtures */

const MODEL_A: ModelRef = { providerID: "prov-a", id: "model-a" };
const MODEL_B: ModelRef = { providerID: "prov-b", id: "model-b" };

const UNAVAILABLE: Metric = { value: null, basis: "unavailable" };

const ZERO_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function measured(value: number): Metric {
  return { value, basis: "measured" };
}

function derived(value: number): Metric {
  return { value, basis: "derived" };
}

function capabilities(): Capabilities {
  return {
    source: "sqlite",
    ttft: false,
    approvals: true,
    requestHeaders: false,
    toolSetChanges: true,
    tokenUsage: true,
    reasoning: true,
    cacheUsage: true,
    cost: true,
    retries: true,
    compactions: true,
    subagents: true,
    contextNotices: true,
    modelSwitches: true,
    routeChanges: true,
    forkResumeMarkers: true,
    toolDurations: true,
    promptTokenBreakdown: "recorded",
    notes: [],
  };
}

function totals(overrides: Partial<Totals> = {}): Totals {
  return {
    scope: "session",
    turns: 1,
    steps: 1,
    toolCalls: 0,
    subagentCalls: 0,
    errors: { total: 0, tool: 0, step: 0, session: 0 },
    retries: 0,
    compactions: 0,
    tokens: ZERO_TOKENS,
    tokensComplete: true,
    stepTokens: ZERO_TOKENS,
    compactionTokens: ZERO_TOKENS,
    cacheHitRate: UNAVAILABLE,
    cost: measured(0.01),
    modelTime: measured(300),
    toolTime: measured(100),
    activeTurnTime: measured(500),
    wallClockTime: measured(500),
    outputSpeed: derived(10),
    finalContext: measured(100),
    cumulativePrompt: measured(100),
    ...overrides,
  };
}

function coverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    fromSeq: 1,
    toSeq: 10,
    minSeq: 1,
    maxSeq: 10,
    complete: true,
    messages: 10,
    windowMessages: 10,
    ...overrides,
  };
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: "stp_1_1",
    turnID: "trn_1",
    index: 1,
    trigger: "User message",
    startTime: 1_000,
    endTime: 1_500,
    startUnknown: false,
    agent: null,
    model: MODEL_A,
    provider: null,
    finish: "stop",
    toolNames: [],
    toolCalls: [],
    tokens: ZERO_TOKENS,
    cost: 0.01,
    promptTokens: measured(100),
    cacheHitRate: UNAVAILABLE,
    ttft: UNAVAILABLE,
    modelTime: measured(300),
    toolTime: measured(100),
    totalTime: measured(500),
    residualTime: derived(100),
    outputSpeed: derived(10),
    status: "completed",
    subagentSessionIDs: [],
    eventIDs: ["evt_step_1_1"],
    responseText: "",
    reasoningText: "",
    uncertainty: [],
    ...overrides,
  };
}

function turnAt(index: number, overrides: Partial<Turn> = {}): Turn {
  const id = `trn_${index}`;
  return {
    id,
    index,
    trigger: { kind: "user", eventID: `evt_user_${index}`, label: "User message" },
    startTime: 1_000 * index,
    endTime: 1_000 * index + 1_000,
    status: "completed",
    steps: [
      step({
        id: `stp_${index}_1`,
        turnID: id,
        index: 1,
        startTime: 1_000 * index,
        endTime: 1_000 * index + 500,
        eventIDs: [`evt_step_${index}_1`],
      }),
    ],
    eventIDs: [`evt_user_${index}`, `evt_step_${index}_1`],
    nonStepEventIDs: [],
    firstStepStart: 1_000 * index,
    lastStepEnd: 1_000 * index + 500,
    tokens: ZERO_TOKENS,
    tokensComplete: true,
    promptTokensLatest: measured(100 * index),
    promptTokensCumulative: measured(100 * index),
    cacheHitRate: UNAVAILABLE,
    contextDelta: UNAVAILABLE,
    cost: measured(0.01),
    modelTime: measured(300),
    toolTime: measured(100),
    totalTime: measured(500),
    residualTime: derived(100),
    outputSpeed: derived(10),
    uncertainty: [],
    ...overrides,
  };
}

function compaction(overrides: Partial<CompactionTransaction> = {}): CompactionTransaction {
  return {
    eventID: "evt_comp_1",
    turnID: null,
    timestamp: 1_500,
    status: "completed",
    reason: "context overflow",
    model: MODEL_A,
    provider: "prov-a",
    tokens: ZERO_TOKENS,
    cost: 0.02,
    summaryChars: 1_200,
    summaryPreview: "summary",
    contextBefore: derived(500),
    contextAfter: derived(120),
    contextDelta: derived(-380),
    removedTokens: derived(380),
    duration: UNAVAILABLE,
    uncertainty: [],
    ...overrides,
  };
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    version: 1,
    session: { id: "ses_charts", time: { created: 900 } },
    family: { rootID: "ses_charts", parent: null, children: [] },
    capabilities: capabilities(),
    coverage: coverage(),
    events: [],
    turns: [turnAt(1)],
    compactions: [],
    totals: totals(),
    unattachedEventIDs: [],
    generatedAt: 1_700_000_000_000,
    redacted: true,
    ...overrides,
  };
}

function basisOf(value: Basis): Metric {
  return { value: 1, basis: value };
}

/* ------------------------------------------------------------------ metrics */

test("chart data: metricPoint keeps a recorded value and never zero-fills", () => {
  assert.deepEqual(metricPoint(measured(1_234)), {
    value: 1_234,
    basis: "measured",
    available: true,
  });
  assert.deepEqual(metricPoint(UNAVAILABLE), {
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.deepEqual(metricPoint({ value: Number.NaN, basis: "measured" }), {
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.deepEqual(metricPoint(undefined), {
    value: null,
    basis: "unavailable",
    available: false,
  });
});

test("chart data: drill anchors are the recorded event IDs only", () => {
  assert.equal(turnAnchor(turnAt(1)), "evt_user_1");
  assert.equal(
    turnAnchor(turnAt(1, { trigger: { kind: "orphan", eventID: null, label: "Orphan" } })),
    "evt_user_1",
  );
  assert.equal(
    turnAnchor(
      turnAt(1, {
        trigger: { kind: "orphan", eventID: null, label: "Orphan" },
        eventIDs: [],
      }),
    ),
    null,
  );
  assert.equal(stepAnchor(step()), "evt_step_1_1");
  assert.equal(stepAnchor(step({ eventIDs: [] })), null);
});

/* ---------------------------------------------------------- context growth */

test("chart data: context growth defaults to the latest basis and gaps, not zeros", () => {
  const series = buildContextGrowthSeries(
    analysis({ turns: [turnAt(1, { promptTokensLatest: UNAVAILABLE }), turnAt(2)] }),
    undefined,
  );

  assert.equal(series.basis, "latest");
  assert.equal(series.empty, false);
  assert.deepEqual(series.points[0], {
    turnIndex: 1,
    anchor: "evt_user_1",
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.notEqual(series.points[0]?.value, 0);
  assert.equal(series.unavailableCount, 1);
  assert.equal(series.points[1]?.value, 200);
});

test("chart data: context growth follows the cumulative basis on request", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [
        turnAt(1, {
          promptTokensLatest: measured(320),
          promptTokensCumulative: measured(1_800),
        }),
      ],
    }),
    "cumulative",
  );

  assert.equal(series.basis, "cumulative");
  assert.equal(series.points[0]?.value, 1_800);
});

test("chart data: compaction markers are placed by turnID before the timestamp", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1), turnAt(2), turnAt(3)],
      compactions: [compaction({ turnID: "trn_2", timestamp: 5_000 })],
    }),
    "latest",
  );

  assert.equal(series.markers.length, 1);
  assert.deepEqual(series.markers[0], {
    eventID: "evt_comp_1",
    turnIndex: 2,
    removedTokens: { value: 380, basis: "derived", available: true },
    label: "Compaction 1",
  });
  assert.equal(series.unplaced, 0);
});

test("chart data: the timestamp fallback applies only when turnID is null", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1), turnAt(2), turnAt(3)],
      compactions: [
        compaction({ eventID: "evt_comp_1", turnID: null, timestamp: 2_500 }),
        compaction({ eventID: "evt_comp_2", turnID: "trn_2", timestamp: 9_999 }),
        compaction({ eventID: "evt_comp_outside", turnID: "trn_outside", timestamp: 2_000 }),
      ],
    }),
    "latest",
  );

  assert.deepEqual(
    series.markers.map((marker) => [marker.eventID, marker.turnIndex]),
    [
      ["evt_comp_1", 2],
      ["evt_comp_2", 2],
    ],
  );
  assert.equal(series.unplaced, 1);
});

test("chart data: compactions before the first turn stay unplaced, counted not drawn", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1), turnAt(2)],
      compactions: [
        compaction({ eventID: "evt_comp_1", turnID: null, timestamp: 500 }),
        compaction({ eventID: "evt_comp_2", turnID: null, timestamp: 2_000 }),
      ],
    }),
    "latest",
  );

  assert.equal(series.unplaced, 1);
  assert.equal(series.markers.length, 1);
  assert.equal(series.markers[0]?.eventID, "evt_comp_2");
  // The label keeps the analysis order, so an unplaced compaction shifts nothing.
  assert.equal(series.markers[0]?.label, "Compaction 2");
});

test("chart data: a recorded turnID outside the loaded turns is unplaced", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1), turnAt(2)],
      compactions: [
        compaction({ eventID: "evt_comp_1", turnID: "trn_outside_window", timestamp: 2_000 }),
      ],
    }),
    "latest",
  );

  assert.deepEqual(series.markers, []);
  assert.equal(series.unplaced, 1);
});

test("chart data: an unrecorded removed-token metric stays unavailable", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1)],
      compactions: [compaction({ turnID: "trn_1", removedTokens: UNAVAILABLE })],
    }),
    "latest",
  );

  assert.deepEqual(series.markers[0]?.removedTokens, {
    value: null,
    basis: "unavailable",
    available: false,
  });
});

test("chart data: empty context growth is flagged, not synthesized", () => {
  const empty = buildContextGrowthSeries(
    analysis({ turns: [], compactions: [compaction({ turnID: "trn_1" })] }),
    "latest",
  );

  assert.equal(empty.empty, true);
  assert.match(empty.reason ?? "", /turns/i);
  assert.deepEqual(empty.points, []);
  assert.deepEqual(empty.markers, []);
  assert.equal(empty.unplaced, 1);
});

test("chart data: context max ignores unavailable points", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [
        turnAt(1, { promptTokensLatest: UNAVAILABLE }),
        turnAt(2, { promptTokensLatest: measured(240) }),
        turnAt(3, { promptTokensLatest: measured(80) }),
      ],
    }),
    "latest",
  );

  assert.equal(contextMax(series), 240);
});

/* -------------------------------------------------------------------- tokens */

test("chart data: the token series stacks the five recorded segments", () => {
  const tokens: TokenUsage = {
    input: 10,
    output: 20,
    reasoning: 5,
    cacheRead: 300,
    cacheWrite: 40,
  };
  const series = buildTokenSeries(
    analysis({ turns: [turnAt(1, { tokens, tokensComplete: true })] }),
  );

  assert.equal(series.empty, false);
  assert.deepEqual(series.points[0], {
    turnIndex: 1,
    anchor: "evt_user_1",
    input: 10,
    cacheRead: 300,
    cacheWrite: 40,
    reasoning: 5,
    output: 20,
    partial: false,
    basis: "measured",
  });
  assert.equal(tokenTotal(series.points[0]!), 375);
  assert.equal(tokenMax(series), 375);
  assert.equal(series.partialCount, 0);
});

test("chart data: a partial token turn keeps the recorded subset and says so", () => {
  const series = buildTokenSeries(
    analysis({
      turns: [
        turnAt(1, {
          tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          tokensComplete: false,
        }),
        turnAt(2),
      ],
    }),
  );

  assert.equal(series.points[0]?.partial, true);
  assert.equal(series.points[0]?.input, 10);
  assert.equal(series.points[0]?.cacheRead, 0);
  // A partial record is never dressed as measured.
  assert.equal(series.points[0]?.basis, "unavailable");
  assert.equal(series.points[1]?.basis, "measured");
  assert.equal(series.partialCount, 1);
});

test("chart data: a turn whose steps recorded no tokens is unavailable, not partial", () => {
  const noSteps = buildTokenSeries(
    analysis({ turns: [turnAt(1, { steps: [], tokensComplete: false })] }),
  );
  assert.equal(noSteps.points[0]?.basis, "unavailable");
  assert.equal(noSteps.points[0]?.partial, false);
  assert.equal(noSteps.partialCount, 0);

  const nullTokens = buildTokenSeries(
    analysis({
      turns: [turnAt(1, { steps: [step({ tokens: null })], tokensComplete: false })],
    }),
  );
  assert.equal(nullTokens.points[0]?.basis, "unavailable");
  assert.equal(nullTokens.points[0]?.partial, false);
});

test("chart data: the unrecorded token count is the dashed-slot count", () => {
  const series = buildTokenSeries(
    analysis({ turns: [turnAt(1, { steps: [], tokensComplete: false })] }),
  );
  assert.equal(series.points[0]?.basis, "unavailable");
  assert.equal(tokenTotal(series.points[0]!), 0);
  const notes = tokenNotes(series);
  assert.deepEqual(notes, ["1 turn recorded no step tokens"]);
  assert.equal(tokenDataRows(series).length, 1);
});

test("chart data: empty token series is flagged with a reason", () => {
  const series = buildTokenSeries(analysis({ turns: [] }));
  assert.equal(series.empty, true);
  assert.match(series.reason ?? "", /turns/i);
  assert.deepEqual(series.points, []);
});

/* ---------------------------------------------------------------------- cost */

test("chart data: cost derives the model from the last step that recorded one", () => {
  const series = buildCostSeries(
    analysis({
      turns: [
        turnAt(1, {
          cost: measured(0.5),
          steps: [
            step({ model: MODEL_A, provider: "prov-a" }),
            step({ index: 2, model: MODEL_B, provider: "prov-b" }),
            step({ index: 3, model: null, provider: "prov-b" }),
          ],
        }),
      ],
    }),
  );

  assert.deepEqual(series.points[0], {
    turnIndex: 1,
    anchor: "evt_user_1",
    cost: { value: 0.5, basis: "measured", available: true },
    modelKey: "prov-b/model-b",
    modelLabel: "prov-b/model-b",
    providerLabel: "prov-b",
  });
});

test("chart data: a provider label appears only where the attributing step recorded it", () => {
  const series = buildCostSeries(
    analysis({
      turns: [
        turnAt(1, { steps: [step({ model: MODEL_B, provider: null })] }),
        turnAt(2, { steps: [step({ model: MODEL_B, provider: "prov-b" })] }),
      ],
    }),
  );

  assert.equal(series.points[0]?.modelLabel, "prov-b/model-b");
  assert.equal(series.points[0]?.providerLabel, null);
  assert.equal(series.points[1]?.providerLabel, "prov-b");
});

test("chart data: cost groups single- and multi-model sessions in analysis order", () => {
  const single = buildCostSeries(analysis({ turns: [turnAt(1), turnAt(2)] }));
  assert.deepEqual(single.models, [{ key: "prov-a/model-a", label: "prov-a/model-a" }]);

  const multi = buildCostSeries(
    analysis({
      turns: [
        turnAt(1, { steps: [step({ model: MODEL_A })] }),
        turnAt(2, { steps: [step({ model: MODEL_B })] }),
        turnAt(3, { steps: [step({ model: null })] }),
      ],
    }),
  );
  assert.deepEqual(multi.models, [
    { key: "prov-a/model-a", label: "prov-a/model-a" },
    { key: "prov-b/model-b", label: "prov-b/model-b" },
    { key: "—", label: "—" },
  ]);
  assert.equal(multi.points[2]?.modelKey, "—");
});

test("chart data: the cost max reports every tied turn index", () => {
  const series = buildCostSeries(
    analysis({
      turns: [
        turnAt(1, { cost: measured(0.5) }),
        turnAt(2, { cost: UNAVAILABLE }),
        turnAt(3, { cost: measured(0.5) }),
        turnAt(4, { cost: measured(0.25) }),
      ],
    }),
  );

  assert.deepEqual(series.max, { value: 0.5, turnIndices: [1, 3] });
  const marked = costDataRows(series).filter((row) => row.value.includes("highest cost"));
  assert.deepEqual(marked.map((row) => row.label), ["Turn 1", "Turn 3"]);
});

test("chart data: a missing cost stays unavailable and is ignored by max", () => {
  const series = buildCostSeries(
    analysis({
      turns: [
        turnAt(1, { cost: UNAVAILABLE }),
        turnAt(2, { cost: { value: Number.NaN, basis: "measured" } }),
      ],
    }),
  );

  assert.deepEqual(series.points[0]?.cost, {
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.notEqual(series.points[0]?.cost.value, 0);
  assert.deepEqual(series.max, { value: null, turnIndices: [] });
  assert.equal(series.unavailableCount, 2);
  assert.deepEqual(costNotes(series), ["2 turns recorded no cost"]);
});

test("chart data: an all-zero cost session marks no highest-cost tie", () => {
  const series = buildCostSeries(
    analysis({
      turns: [turnAt(1, { cost: measured(0) }), turnAt(2, { cost: measured(0) })],
    }),
  );

  assert.deepEqual(series.max, { value: 0, turnIndices: [] });
  assert.equal(
    costDataRows(series).some((row) => row.value.includes("highest cost")),
    false,
  );
});

test("chart data: empty cost series keeps a neutral max and no models", () => {
  const series = buildCostSeries(analysis({ turns: [] }));
  assert.equal(series.empty, true);
  assert.deepEqual(series.points, []);
  assert.deepEqual(series.models, []);
  assert.deepEqual(series.max, { value: null, turnIndices: [] });
});

/* ------------------------------------------------------------------ duration */

test("chart data: duration has one labelled point per step with its anchor", () => {
  const series = buildDurationSeries(
    analysis({
      turns: [
        turnAt(1, {
          steps: [
            step({ index: 1 }),
            step({ index: 2, eventIDs: ["evt_step_1_2"] }),
          ],
        }),
        turnAt(2),
      ],
    }),
  );

  assert.equal(series.empty, false);
  assert.deepEqual(
    series.points.map((point) => [point.label, point.anchor]),
    [
      ["1.1", "evt_step_1_1"],
      ["1.2", "evt_step_1_2"],
      ["2.1", "evt_step_2_1"],
    ],
  );
  assert.deepEqual(series.points[0]?.modelTime, {
    value: 300,
    basis: "measured",
    available: true,
  });
  assert.deepEqual(series.points[0]?.residualTime, {
    value: 100,
    basis: "derived",
    available: true,
  });
  assert.equal(durationMax(series), 500);
});

test("chart data: duration omits absent segments instead of zero-filling them", () => {
  const series = buildDurationSeries(
    analysis({
      turns: [
        turnAt(1, {
          steps: [
            step({
              modelTime: measured(300),
              toolTime: UNAVAILABLE,
              residualTime: UNAVAILABLE,
            }),
          ],
        }),
      ],
    }),
  );

  const point = series.points[0]!;
  assert.equal("modelTime" in point, true);
  assert.equal("toolTime" in point, false);
  assert.equal("residualTime" in point, false);
  assert.equal(point.available, true);
  assert.equal(durationTotal(point), 300);
  assert.equal(series.unavailableCount, 0);
  const rows = durationDataRows(series);
  assert.doesNotMatch(rows[0]?.value ?? "", /tool time/);
});

test("chart data: a step with all three durations unavailable is an unavailable point", () => {
  const series = buildDurationSeries(
    analysis({
      turns: [
        turnAt(1, {
          steps: [
            step({ modelTime: UNAVAILABLE, toolTime: UNAVAILABLE, residualTime: UNAVAILABLE }),
          ],
        }),
      ],
    }),
  );

  const point = series.points[0]!;
  assert.equal(point.available, false);
  assert.equal("modelTime" in point, false);
  assert.equal(durationTotal(point), 0);
  assert.equal(series.unavailableCount, 1);
  assert.deepEqual(durationNotes(series), ["1 step recorded no durations"]);
  assert.equal(durationDataRows(series)[0]?.kind, "step");
});

test("chart data: duration keeps a null anchor when a step recorded no event", () => {
  const series = buildDurationSeries(
    analysis({ turns: [turnAt(1, { steps: [step({ eventIDs: [] })] })] }),
  );
  assert.equal(series.points[0]?.anchor, null);
});

test("chart data: duration empty states name whether turns or steps are missing", () => {
  const noTurns = buildDurationSeries(analysis({ turns: [] }));
  assert.equal(noTurns.empty, true);
  assert.match(noTurns.reason ?? "", /turns/i);

  const noSteps = buildDurationSeries(analysis({ turns: [turnAt(1, { steps: [] })] }));
  assert.equal(noSteps.empty, true);
  assert.match(noSteps.reason ?? "", /steps/i);
});

/* ------------------------------------------------------------------- caption */

test("chart data: the caption states the scope and sequence range", () => {
  assert.equal(
    chartWindowCaption(
      analysis({ coverage: coverage({ fromSeq: 1, toSeq: 42, minSeq: 1, maxSeq: 42 }) }),
    ),
    "Session total — seq 1–42",
  );
});

test("chart data: the caption marks a partial window against the full bounds", () => {
  assert.equal(
    chartWindowCaption(
      analysis({
        totals: totals({ scope: "window" }),
        coverage: coverage({ fromSeq: 50, toSeq: 60, minSeq: 1, maxSeq: 100, complete: false }),
      }),
    ),
    "Window total — seq 50–60 of 1–100",
  );
});

test("chart data: the caption degrades to the scope, then the single seq", () => {
  assert.equal(chartWindowCaption({ totals: { scope: "window" } }), "Window total");
  assert.equal(
    chartWindowCaption(
      analysis({ coverage: coverage({ fromSeq: 7, toSeq: 7, minSeq: 7, maxSeq: 7 }) }),
    ),
    "Session total — seq 7",
  );
});

/* -------------------------------------------------------------- drill rows */

test("chart data: context rows keep every point and marker with their anchors", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1), turnAt(2), turnAt(3)],
      compactions: [compaction({ turnID: "trn_2", eventID: "evt_comp_1" })],
    }),
    "latest",
  );
  const rows = contextDataRows(series);

  assert.equal(rows.length, 4);
  assert.equal(rows[0]?.anchor, "evt_user_1");
  assert.equal(rows[1]?.value.includes("context 200"), true);
  assert.equal(rows[3]?.label, "Compaction 1");
  assert.equal(rows[3]?.anchor, "evt_comp_1");
});

test("chart data: the drill list has no hidden cap of its own", () => {
  const turns = Array.from({ length: 30 }, (_, index) => turnAt(index + 1));
  const series = buildContextGrowthSeries(analysis({ turns }), "latest");
  assert.equal(contextDataRows(series).length, 30);
  assert.equal(tokenDataRows(buildTokenSeries(analysis({ turns }))).length, 30);
});

test("chart data: an unrecorded point keeps an honest row and no anchor is invented", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [
        turnAt(1, {
          promptTokensLatest: UNAVAILABLE,
          trigger: { kind: "orphan", eventID: null, label: "Orphan" },
          eventIDs: [],
        }),
      ],
    }),
    "latest",
  );
  const row = contextDataRows(series)[0]!;
  assert.equal(row.value, "context not recorded (—)");
  assert.equal(row.anchor, null);
});

test("chart data: token rows describe the five recorded segments and the partial subset", () => {
  const series = buildTokenSeries(
    analysis({
      turns: [
        turnAt(1, {
          tokens: { input: 10, output: 20, reasoning: 5, cacheRead: 300, cacheWrite: 40 },
        }),
      ],
    }),
  );
  assert.equal(
    tokenDataRows(series)[0]?.value,
    "input 10, cache read 300, cache write 40, reasoning 5, output 20 tokens (M)",
  );
});

test("chart data: duration rows are step-kind and use the legacy time unit", () => {
  const series = buildDurationSeries(analysis({ turns: [turnAt(1)] }));
  const row = durationDataRows(series)[0]!;
  assert.equal(row.kind, "step");
  assert.match(row.value, /model time 300 ms \(M\)/);
  assert.match(row.value, /residual time 100 ms \(D\)/);
});

/* ------------------------------------------------------------------- notes */

test("chart data: notes are pluralized, sentence-cased and free of invented counts", () => {
  const context = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1, { promptTokensLatest: UNAVAILABLE }), turnAt(2)],
      compactions: [compaction({ turnID: "trn_outside" })],
    }),
    "latest",
  );
  assert.deepEqual(contextNotes(context), [
    "1 turn has no context recorded",
    "1 compaction could not be placed on a turn",
  ]);
  assert.equal(sentenceCase("no turns in this analysis"), "No turns in this analysis.");
  assert.equal(sentenceCase(""), "No chart data.");
  assert.equal(sentenceCase("already a sentence."), "Already a sentence.");
});

/* ------------------------------------------------------------------ purity */

test("chart data: builders are pure functions of the analysis object", async () => {
  const source = await readFile(
    new URL("../src/web/lib/chart-data.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bdocument\./);
  assert.doesNotMatch(source, /\bwindow\./);
  assert.doesNotMatch(source, /\buse(State|Effect|Memo|Query)\b/);

  const data = analysis({
    turns: [turnAt(1), turnAt(2)],
    compactions: [compaction({ turnID: "trn_1" })],
  });
  const before = JSON.stringify(data);
  const first = buildCostSeries(data);
  const second = buildCostSeries(data);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(data), before);
  // A basis value outside the two legacy names falls back to latest.
  assert.equal(buildContextGrowthSeries(data, "nonsense").basis, "latest");
  assert.equal(basisOf("estimated").basis, "estimated");
});
