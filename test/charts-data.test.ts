import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// @ts-expect-error - plain browser module without type declarations
import { buildContextGrowthSeries, buildCostSeries, buildDurationSeries, buildTokenSeries, chartWindowCaption, metricPoint, stepAnchor, turnAnchor } from "../src/ui/charts-data.js";
import type {
  Analysis,
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

// ---------------------------------------------------------------------------
// metricPoint
// ---------------------------------------------------------------------------

test("metricPoint keeps a recorded value with its basis", () => {
  assert.deepEqual(metricPoint(measured(1_234)), {
    value: 1_234,
    basis: "measured",
    available: true,
  });
  assert.deepEqual(metricPoint(derived(0)), {
    value: 0,
    basis: "derived",
    available: true,
  });
});

test("metricPoint reports an unavailable metric as null, never 0", () => {
  assert.deepEqual(metricPoint(UNAVAILABLE), {
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.deepEqual(metricPoint({ value: null, basis: "unavailable", note: "no tokens" }), {
    value: null,
    basis: "unavailable",
    available: false,
  });
});

test("metricPoint normalizes a missing metric and non-finite values", () => {
  assert.deepEqual(metricPoint(undefined), {
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.deepEqual(metricPoint({ value: Number.NaN, basis: "measured" }), {
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.deepEqual(metricPoint({ value: Number.POSITIVE_INFINITY, basis: "derived" }), {
    value: null,
    basis: "unavailable",
    available: false,
  });
});

// ---------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------

test("turnAnchor prefers the trigger event, then the first turn event", () => {
  assert.equal(turnAnchor(turnAt(1)), "evt_user_1");
  assert.equal(
    turnAnchor(turnAt(1, { trigger: { kind: "orphan", eventID: null, label: "Orphan" } })),
    "evt_user_1",
  );
});

test("turnAnchor returns null without a recorded event ID", () => {
  assert.equal(
    turnAnchor(
      turnAt(1, {
        trigger: { kind: "orphan", eventID: null, label: "Orphan" },
        eventIDs: [],
      }),
    ),
    null,
  );
  assert.equal(turnAnchor({ trigger: null, eventIDs: [] }), null);
});

test("stepAnchor uses the first step event ID and never fabricates one", () => {
  assert.equal(stepAnchor(step()), "evt_step_1_1");
  assert.equal(stepAnchor(step({ eventIDs: [] })), null);
  assert.equal(stepAnchor({ eventIDs: [] }), null);
});

// ---------------------------------------------------------------------------
// buildContextGrowthSeries
// ---------------------------------------------------------------------------

test("context growth has one point per turn and defaults to the latest basis", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1), turnAt(2, { promptTokensLatest: measured(240) })],
    }),
    // contextCell treats anything but "cumulative" as latest.
    undefined,
  );

  assert.equal(series.basis, "latest");
  assert.equal(series.empty, false);
  assert.equal(series.points.length, 2);
  assert.deepEqual(series.points[0], {
    turnIndex: 1,
    anchor: "evt_user_1",
    value: 100,
    basis: "measured",
    available: true,
  });
  assert.equal(series.points[1].value, 240);
  assert.equal(series.unavailableCount, 0);
});

test("context growth selects the cumulative metric when asked", () => {
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
  assert.equal(series.points[0].value, 1_800);
});

test("the first turn's unavailable context is a gap, not a zero", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [
        turnAt(1, {
          promptTokensLatest: { value: null, basis: "unavailable", note: "no step tokens" },
        }),
        turnAt(2),
      ],
    }),
    "latest",
  );

  assert.deepEqual(series.points[0], {
    turnIndex: 1,
    anchor: "evt_user_1",
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.equal(series.points[0].value, null);
  assert.notEqual(series.points[0].value, 0);
  assert.equal(series.unavailableCount, 1);
  assert.equal(series.points[1].available, true);
});

test("compaction markers are placed by turnID before the timestamp", () => {
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

test("compaction markers fall back to the last turn starting before the timestamp", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1), turnAt(2), turnAt(3)],
      compactions: [
        compaction({ eventID: "evt_comp_1", turnID: null, timestamp: 2_500 }),
        // The timestamp rule applies only when no turn was recorded.
        compaction({ eventID: "evt_comp_2", turnID: null, timestamp: 3_500 }),
      ],
    }),
    "latest",
  );

  assert.deepEqual(
    series.markers.map((marker: { eventID: string; turnIndex: number }) => [
      marker.eventID,
      marker.turnIndex,
    ]),
    [
      ["evt_comp_1", 2],
      ["evt_comp_2", 3],
    ],
  );
  assert.equal(series.unplaced, 0);
});

test("a recorded turnID outside the loaded turns is unplaced, not timestamp-placed", () => {
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

test("unplaceable compactions are counted, not positioned", () => {
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
  assert.equal(series.markers[0].eventID, "evt_comp_2");
  // The label keeps the analysis order, so an unplaced compaction shifts nothing.
  assert.equal(series.markers[0].label, "Compaction 2");
});

test("compaction markers keep removed tokens unavailable when unrecorded", () => {
  const series = buildContextGrowthSeries(
    analysis({
      turns: [turnAt(1)],
      compactions: [compaction({ turnID: "trn_1", removedTokens: UNAVAILABLE })],
    }),
    "latest",
  );

  assert.deepEqual(series.markers[0].removedTokens, {
    value: null,
    basis: "unavailable",
    available: false,
  });
});

test("empty context growth is flagged instead of synthesizing turns", () => {
  const series = buildContextGrowthSeries(analysis({ turns: [], compactions: [] }), "latest");

  assert.equal(series.empty, true);
  assert.equal(typeof series.reason, "string");
  assert.ok((series.reason as string).length > 0);
  assert.deepEqual(series.points, []);
  assert.deepEqual(series.markers, []);
  assert.equal(series.unplaced, 0);
});

test("empty context growth still counts compactions it cannot place", () => {
  const series = buildContextGrowthSeries(
    analysis({ turns: [], compactions: [compaction({ turnID: "trn_1" })] }),
    "latest",
  );

  assert.equal(series.empty, true);
  assert.equal(series.unplaced, 1);
});

// ---------------------------------------------------------------------------
// buildTokenSeries
// ---------------------------------------------------------------------------

test("token series stacks five recorded segments per turn", () => {
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
  assert.equal(series.partialCount, 0);
});

test("an incomplete token turn is marked partial without padding its values", () => {
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

  assert.equal(series.points[0].partial, true);
  assert.equal(series.points[0].input, 10);
  // The remaining segments stay the recorded subset, never invented.
  assert.equal(series.points[0].cacheRead, 0);
  assert.equal(series.points[0].reasoning, 0);
  // A partial record is never dressed as measured.
  assert.equal(series.points[0].basis, "unavailable");
  assert.equal(series.points[1].partial, false);
  assert.equal(series.points[1].basis, "measured");
  assert.equal(series.partialCount, 1);
});

test("a turn whose steps recorded no tokens is unavailable, not a zero stack", () => {
  const noSteps = buildTokenSeries(
    analysis({
      turns: [turnAt(1, { steps: [], tokensComplete: false })],
    }),
  );
  assert.equal(noSteps.points[0].basis, "unavailable");
  assert.equal(noSteps.points[0].partial, false);
  assert.equal(noSteps.points[0].input, 0);
  assert.equal(noSteps.partialCount, 0);

  const nullStepTokens = buildTokenSeries(
    analysis({
      turns: [
        turnAt(1, {
          steps: [step({ tokens: null })],
          tokensComplete: false,
        }),
      ],
    }),
  );
  assert.equal(nullStepTokens.points[0].basis, "unavailable");
  assert.equal(nullStepTokens.points[0].partial, false);
});

test("empty token series is flagged with a reason", () => {
  const series = buildTokenSeries(analysis({ turns: [] }));

  assert.equal(series.empty, true);
  assert.equal(typeof series.reason, "string");
  assert.deepEqual(series.points, []);
  assert.equal(series.partialCount, 0);
});

// ---------------------------------------------------------------------------
// buildCostSeries
// ---------------------------------------------------------------------------

test("cost series derives the model from the last step that recorded one", () => {
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

  assert.equal(series.empty, false);
  assert.deepEqual(series.points[0], {
    turnIndex: 1,
    anchor: "evt_user_1",
    cost: { value: 0.5, basis: "measured", available: true },
    modelKey: "prov-b/model-b",
    modelLabel: "prov-b/model-b",
    providerLabel: "prov-b",
  });
  assert.equal(series.unavailableCount, 0);
});

test("provider label appears only where the attributing step recorded it", () => {
  const series = buildCostSeries(
    analysis({
      turns: [
        turnAt(1, { steps: [step({ model: MODEL_B, provider: null })] }),
        turnAt(2, { steps: [step({ model: MODEL_B, provider: "prov-b" })] }),
      ],
    }),
  );

  assert.equal(series.points[0].modelLabel, "prov-b/model-b");
  assert.equal(series.points[0].providerLabel, null);
  assert.equal(series.points[1].providerLabel, "prov-b");
});

test("cost series groups single- and multi-model sessions", () => {
  const single = buildCostSeries(
    analysis({ turns: [turnAt(1), turnAt(2)] }),
  );
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
  assert.equal(multi.points[2].modelKey, "—");
  assert.equal(multi.points[2].providerLabel, null);
});

test("cost max reports every tied turn index", () => {
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
});

test("missing cost stays unavailable and is ignored by max", () => {
  const series = buildCostSeries(
    analysis({
      turns: [
        turnAt(1, { cost: { value: null, basis: "unavailable", note: "no step costs" } }),
        turnAt(2, { cost: UNAVAILABLE }),
      ],
    }),
  );

  assert.deepEqual(series.points[0].cost, {
    value: null,
    basis: "unavailable",
    available: false,
  });
  assert.notEqual(series.points[0].cost.value, 0);
  assert.deepEqual(series.max, { value: null, turnIndices: [] });
  assert.equal(series.unavailableCount, 2);
});

test("empty cost series is flagged with neutral max and models", () => {
  const series = buildCostSeries(analysis({ turns: [] }));

  assert.equal(series.empty, true);
  assert.equal(typeof series.reason, "string");
  assert.deepEqual(series.points, []);
  assert.deepEqual(series.models, []);
  assert.deepEqual(series.max, { value: null, turnIndices: [] });
});

test("an all-zero cost session marks no highest-cost tie", () => {
  const series = buildCostSeries(
    analysis({
      turns: [turnAt(1, { cost: measured(0) }), turnAt(2, { cost: measured(0) })],
    }),
  );

  assert.deepEqual(series.max, { value: 0, turnIndices: [] });
});

// ---------------------------------------------------------------------------
// buildDurationSeries
// ---------------------------------------------------------------------------

test("duration series has one labelled point per step with its anchor", () => {
  const series = buildDurationSeries(
    analysis({
      turns: [
        turnAt(1, {
          steps: [
            step({ index: 1, modelTime: measured(300), toolTime: measured(100) }),
            step({ index: 2, modelTime: measured(200), eventIDs: ["evt_step_1_2"] }),
          ],
        }),
        turnAt(2),
      ],
    }),
  );

  assert.equal(series.empty, false);
  assert.deepEqual(
    series.points.map((point: { label: string; anchor: string | null }) => [
      point.label,
      point.anchor,
    ]),
    [
      ["1.1", "evt_step_1_1"],
      ["1.2", "evt_step_1_2"],
      ["2.1", "evt_step_2_1"],
    ],
  );
  assert.deepEqual(series.points[0].modelTime, {
    value: 300,
    basis: "measured",
    available: true,
  });
  assert.deepEqual(series.points[0].toolTime, {
    value: 100,
    basis: "measured",
    available: true,
  });
  assert.deepEqual(series.points[0].residualTime, {
    value: 100,
    basis: "derived",
    available: true,
  });
  assert.equal(series.points[0].available, true);
});

test("duration segments whose metric is null are omitted, not zero-filled", () => {
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

  const point = series.points[0];
  assert.equal("modelTime" in point, true);
  assert.equal("toolTime" in point, false);
  assert.equal("residualTime" in point, false);
  assert.equal(point.available, true);
  assert.equal(series.unavailableCount, 0);
});

test("a step with all three durations unavailable is an unavailable point", () => {
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

  const point = series.points[0];
  assert.equal(point.available, false);
  assert.equal("modelTime" in point, false);
  assert.equal("toolTime" in point, false);
  assert.equal("residualTime" in point, false);
  assert.equal(series.unavailableCount, 1);
});

test("a step without event IDs keeps a null anchor", () => {
  const series = buildDurationSeries(
    analysis({ turns: [turnAt(1, { steps: [step({ eventIDs: [] })] })] }),
  );

  assert.equal(series.points[0].anchor, null);
});

test("duration empty states name whether turns or steps are missing", () => {
  const noTurns = buildDurationSeries(analysis({ turns: [] }));
  assert.equal(noTurns.empty, true);
  assert.match(noTurns.reason, /turns/i);
  assert.deepEqual(noTurns.points, []);

  const noSteps = buildDurationSeries(analysis({ turns: [turnAt(1, { steps: [] })] }));
  assert.equal(noSteps.empty, true);
  assert.match(noSteps.reason, /steps/i);
  assert.deepEqual(noSteps.points, []);
});

// ---------------------------------------------------------------------------
// chartWindowCaption
// ---------------------------------------------------------------------------

test("caption states the session scope and sequence range", () => {
  const caption = chartWindowCaption(
    analysis({
      coverage: coverage({ fromSeq: 1, toSeq: 42, minSeq: 1, maxSeq: 42 }),
    }),
  );

  assert.equal(caption, "Session total — seq 1–42");
});

test("caption marks a partial window against the full sequence bounds", () => {
  const caption = chartWindowCaption(
    analysis({
      totals: totals({ scope: "window" }),
      coverage: coverage({
        fromSeq: 50,
        toSeq: 60,
        minSeq: 1,
        maxSeq: 100,
        complete: false,
      }),
    }),
  );

  assert.equal(caption, "Window total — seq 50–60 of 1–100");
});

test("caption degrades to the scope when coverage or a single seq is all there is", () => {
  assert.equal(chartWindowCaption({ totals: { scope: "window" } }), "Window total");
  assert.equal(
    chartWindowCaption(
      analysis({ coverage: coverage({ fromSeq: 7, toSeq: 7, minSeq: 7, maxSeq: 7 }) }),
    ),
    "Session total — seq 7",
  );
});

// ---------------------------------------------------------------------------
// single-turn session and module surface
// ---------------------------------------------------------------------------

test("a single-turn session yields one point per builder without empty flags", () => {
  const data = analysis();

  const context = buildContextGrowthSeries(data, "latest");
  assert.equal(context.empty, false);
  assert.equal(context.points.length, 1);

  const tokens = buildTokenSeries(data);
  assert.equal(tokens.empty, false);
  assert.equal(tokens.points.length, 1);

  const cost = buildCostSeries(data);
  assert.equal(cost.empty, false);
  assert.equal(cost.points.length, 1);
  assert.deepEqual(cost.max, { value: 0.01, turnIndices: [1] });

  const duration = buildDurationSeries(data);
  assert.equal(duration.empty, false);
  assert.equal(duration.points.length, 1);
});

test("charts-data.js imports ./format.js only and touches no DOM", async () => {
  const source = await readFile(
    new URL("../src/ui/charts-data.js", import.meta.url),
    "utf8",
  );
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(specifiers, ["./format.js"]);
  assert.doesNotMatch(source, /(^|[^\w.])document\./m);
  assert.doesNotMatch(source, /(^|[^\w.])window\./m);
  assert.doesNotMatch(source, /src\/(core|server)/);
});
