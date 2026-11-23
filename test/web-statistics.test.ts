import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type {
  Analysis,
  Basis,
  CompactionTransaction,
  EventIndexEntry,
  Metric,
  Step,
  TokenUsage,
  Turn,
} from "../src/core/types.ts";
import {
  ADVANCED_COLUMNS,
  BASIC_COLUMNS,
  BASIS_LEGEND,
  COPY_ACTIONS,
  FROZEN_COLUMN_IDS,
  STATS_TAB_OPTIONS,
  buildAdvancedRows,
  buildBasicRows,
  buildBasicTotals,
  buildAdvancedTotals,
  buildRecordedLegend,
  buildStatTiles,
  buildStepDetail,
  buildSummary,
  eventRowModel,
  scopeLabel,
  statsColumns,
  unattachedEvents,
} from "../src/web/lib/statistics.ts";

/* ------------------------------------------------------------------ fixtures */

function metric(value: number | null, basis: Basis = "measured", note?: string): Metric {
  return note ? { value, basis, note } : { value, basis };
}

function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 1_000,
    output: 200,
    reasoning: 50,
    cacheRead: 100,
    cacheWrite: 20,
    ...overrides,
  };
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: "step-1",
    turnID: "turn-1",
    index: 1,
    trigger: "User message",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    startUnknown: false,
    agent: "build",
    model: { providerID: "test-provider", id: "test-model" },
    provider: "test-provider",
    finish: "stop",
    toolNames: ["bash"],
    toolCalls: [
      {
        callID: "call-1",
        name: "bash",
        status: "completed",
        input: null,
        inputPreview: "ls",
        output: "file.txt",
        outputPreview: "file.txt",
        error: null,
        metadata: null,
        createdAt: null,
        ranAt: null,
        completedAt: null,
        duration: metric(300),
        childSessionIDs: [],
        executed: true,
      },
    ],
    tokens: tokens(),
    cost: 0.02,
    promptTokens: metric(1_120),
    cacheHitRate: metric(0.1),
    ttft: metric(null),
    modelTime: metric(800),
    toolTime: metric(300),
    totalTime: metric(1_000),
    residualTime: metric(200),
    outputSpeed: metric(25),
    status: "completed",
    subagentSessionIDs: [],
    eventIDs: ["evt-step-1"],
    responseText: "Hello **world**",
    reasoningText: "",
    uncertainty: [],
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  const steps = overrides.steps ?? [step()];
  return {
    id: "turn-1",
    index: 1,
    trigger: { kind: "user", eventID: "evt-turn-1", label: "User message" },
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_010_000,
    status: "completed",
    steps,
    eventIDs: ["evt-turn-1", "evt-step-1"],
    nonStepEventIDs: [],
    firstStepStart: 1_700_000_000_000,
    lastStepEnd: 1_700_000_010_000,
    tokens: tokens(),
    tokensComplete: true,
    promptTokensLatest: metric(1_120),
    promptTokensCumulative: metric(2_240),
    cacheHitRate: metric(0.1),
    contextDelta: metric(50),
    cost: metric(0.02),
    modelTime: metric(800),
    toolTime: metric(300),
    totalTime: metric(10_000),
    residualTime: metric(200),
    outputSpeed: metric(25),
    uncertainty: [],
    ...overrides,
  };
}

function event(overrides: Partial<EventIndexEntry> = {}): EventIndexEntry {
  return {
    id: "evt-system-1",
    messageID: "msg-1",
    sessionID: "ses-1",
    seq: 1,
    orderKey: "0001",
    timestamp: 1_700_000_000_500,
    kind: "system",
    actor: "system",
    title: "Context updated",
    preview: "context notice",
    agent: null,
    model: null,
    provider: null,
    status: null,
    toolName: null,
    toolStatus: null,
    tokens: null,
    cost: null,
    stepID: null,
    turnID: "turn-1",
    flags: {
      error: false,
      retry: false,
      compaction: false,
      context: true,
      subagent: false,
      approval: false,
      uncertain: false,
    },
    uncertainty: [],
    ...overrides,
  };
}

function compaction(overrides: Partial<CompactionTransaction> = {}): CompactionTransaction {
  return {
    eventID: "evt-compaction-1",
    turnID: "turn-1",
    timestamp: 1_700_000_020_000,
    status: "completed",
    reason: "context",
    model: null,
    provider: null,
    tokens: tokens({ output: 500 }),
    cost: 0.01,
    summaryChars: 1_200,
    summaryPreview: "Summary of the work so far",
    contextBefore: metric(90_000),
    contextAfter: metric(12_000),
    contextDelta: metric(-78_000, "derived"),
    removedTokens: metric(78_000, "derived"),
    duration: metric(null),
    uncertainty: [],
    ...overrides,
  };
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  const turns = overrides.turns ?? [turn()];
  return {
    version: 1,
    session: { id: "ses-1", time: { created: 1_700_000_000_000 } },
    family: { rootID: "ses-1", parent: null, children: [] },
    capabilities: {
      source: "sqlite",
      ttft: false,
      approvals: false,
      requestHeaders: false,
      toolSetChanges: false,
      tokenUsage: true,
      reasoning: true,
      cacheUsage: true,
      cost: true,
      retries: true,
      compactions: true,
      subagents: true,
      contextNotices: true,
      modelSwitches: true,
      routeChanges: false,
      forkResumeMarkers: false,
      toolDurations: true,
      promptTokenBreakdown: "input + cache read + cache write",
      notes: [],
    },
    coverage: {
      fromSeq: 1,
      toSeq: 10,
      minSeq: 1,
      maxSeq: 10,
      complete: true,
      messages: 10,
      windowMessages: 10,
    },
    events: [event()],
    turns,
    compactions: [compaction()],
    totals: {
      scope: "session",
      turns: turns.length,
      steps: 1,
      toolCalls: 1,
      subagentCalls: 0,
      errors: { total: 1, tool: 0, step: 1, session: 0 },
      retries: 2,
      compactions: 1,
      tokens: tokens(),
      tokensComplete: true,
      stepTokens: tokens(),
      compactionTokens: tokens({ output: 500 }),
      cacheHitRate: metric(0.1),
      cost: metric(0.03),
      modelTime: metric(800),
      toolTime: metric(300),
      activeTurnTime: metric(10_000),
      wallClockTime: metric(30_000),
      outputSpeed: metric(25),
      finalContext: metric(1_120),
      cumulativePrompt: metric(2_240),
      recorded: {
        tokens: tokens(),
        cost: 0.04,
        note: "Recorded on the OpenCode session row",
      },
    },
    unattachedEventIDs: [],
    generatedAt: 1_700_000_030_000,
    redacted: true,
    ...overrides,
  };
}

const NO_TURNS = new Set<string>();
const NO_STEPS = new Set<string>();

/* ------------------------------------------------------------------- columns */

test("statistics: Basic keeps the seven turn columns and no advanced surface", () => {
  assert.equal(BASIC_COLUMNS.length, 7);
  assert.deepEqual(
    BASIC_COLUMNS.map((column) => column.label),
    ["#", "Trigger", "Duration", "In", "Out", "Cost", "Status"],
  );
  assert.deepEqual(statsColumns("basic"), BASIC_COLUMNS);
  assert.ok(BASIC_COLUMNS.every((column) => column.frozen === null));
});

test("statistics: Advanced keeps the full 19-column order from docs/UI.md:110", () => {
  assert.deepEqual(
    ADVANCED_COLUMNS.map((column) => column.label),
    [
      "#",
      "Trigger",
      "Start",
      "Duration",
      "Model",
      "Steps",
      "In",
      "Out",
      "Reason",
      "Cache R/W",
      "Hit",
      "Context",
      "Δ context",
      "Model time",
      "Tool time",
      "Residual",
      "Out/s",
      "Cost",
      "Status",
    ],
  );
  assert.equal(new Set(ADVANCED_COLUMNS.map((column) => column.id)).size, 19);
  assert.deepEqual(
    ADVANCED_COLUMNS.filter((column) => column.frozen !== null).map((column) => column.id),
    ["index", "trigger", "status"],
  );
  assert.deepEqual(FROZEN_COLUMN_IDS, ["index", "trigger", "status"]);
  assert.equal(ADVANCED_COLUMNS[1]?.frozen, "left");
  assert.equal(ADVANCED_COLUMNS[18]?.frozen, "right");
});

test("statistics: headers are sentence case and numerics are right-aligned", () => {
  for (const column of ADVANCED_COLUMNS) {
    const words = column.label.split(" ");
    for (const word of words) {
      if (!/^[A-Za-z]{2,}$/.test(word)) continue;
      assert.equal(
        word.slice(1),
        word.slice(1).toLowerCase(),
        `${column.label} is not sentence case`,
      );
    }
  }
  const numeric = ADVANCED_COLUMNS.filter((column) => column.numeric).map((column) => column.id);
  assert.deepEqual(numeric, [
    "duration",
    "steps",
    "input",
    "output",
    "reasoning",
    "cache",
    "hit",
    "context",
    "delta",
    "model-time",
    "tool-time",
    "residual",
    "speed",
    "cost",
  ]);
});

/* ---------------------------------------------------------------------- rows */

test("statistics: a Basic turn row carries the seven legacy cells", () => {
  const rows = buildBasicRows(analysis(), NO_TURNS, NO_STEPS);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, "turn");
  assert.equal(row.cells.length, 7);
  assert.equal(row.cells[0]?.text, "1");
  assert.equal(row.cells[1]?.text, "User message");
  assert.equal(row.cells[3]?.text, "1,000");
  assert.equal(row.cells[4]?.text, "200");
  assert.equal(row.cells[5]?.text, "$0.0200");
  assert.equal(row.cells[6]?.status?.label, "completed");
});

test("statistics: expanding a turn adds step rows and expanding the step adds a detail row", () => {
  const expandedTurn = new Set(["turn-1"]);
  const withStep = buildAdvancedRows(analysis(), {
    expandedTurns: expandedTurn,
    expandedSteps: NO_STEPS,
    contextBasis: "latest",
    showEventRows: false,
  });
  assert.deepEqual(withStep.map((row) => row.kind), ["turn", "step"]);
  assert.equal(withStep[1]?.cells.length, 19);
  assert.equal(withStep[1]?.cells[0]?.text, "1.1 ▸");

  const withDetail = buildBasicRows(analysis(), expandedTurn, new Set(["turn-1:step-1"]));
  assert.deepEqual(withDetail.map((row) => row.kind), ["turn", "step", "detail"]);
});

test("statistics: the context column follows the basis, and totals never follow it", () => {
  const latest = buildAdvancedRows(analysis(), {
    expandedTurns: NO_TURNS,
    expandedSteps: NO_STEPS,
    contextBasis: "latest",
    showEventRows: false,
  });
  const cumulative = buildAdvancedRows(analysis(), {
    expandedTurns: NO_TURNS,
    expandedSteps: NO_STEPS,
    contextBasis: "cumulative",
    showEventRows: false,
  });
  assert.equal(latest[0]?.cells[11]?.text, "1,120");
  assert.equal(cumulative[0]?.cells[11]?.text, "2,240");
  // Both context figures stay in the total row, whichever basis is selected.
  assert.match(buildAdvancedTotals(analysis()).cells[7]?.text ?? "", /Final 1,120 · Cumulative 2,240/);
});

test("statistics: a missing metric stays an em dash with its provenance mark", () => {
  const rows = buildAdvancedRows(
    analysis({ turns: [turn({ contextDelta: metric(null), cost: metric(null, "unavailable") })] }),
    {
      expandedTurns: NO_TURNS,
      expandedSteps: NO_STEPS,
      contextBasis: "latest",
      showEventRows: false,
    },
  );
  assert.equal(rows[0]?.cells[12]?.text, "—");
  assert.equal(rows[0]?.cells[12]?.mark, "—");
  assert.equal(rows[0]?.cells[17]?.text, "—");
  assert.equal(rows[0]?.cells[17]?.mark, "—");
});

test("statistics: a positive and a negative context delta keep their sign", () => {
  const plus = buildAdvancedRows(analysis(), {
    expandedTurns: NO_TURNS,
    expandedSteps: NO_STEPS,
    contextBasis: "latest",
    showEventRows: false,
  });
  assert.equal(plus[0]?.cells[12]?.text, "+50");
  const minus = buildAdvancedRows(
    analysis({ turns: [turn({ contextDelta: metric(-120) })] }),
    {
      expandedTurns: NO_TURNS,
      expandedSteps: NO_STEPS,
      contextBasis: "latest",
      showEventRows: false,
    },
  );
  assert.equal(minus[0]?.cells[12]?.text, "-120");
});

test("statistics: show event rows only inserts the documented event kinds", () => {
  const listed = event();
  const unlisted = event({ id: "evt-user-2", kind: "user", title: "A user message" });
  const rows = buildAdvancedRows(analysis({ events: [listed, unlisted] }), {
    expandedTurns: NO_TURNS,
    expandedSteps: NO_STEPS,
    contextBasis: "latest",
    showEventRows: true,
  });
  assert.deepEqual(rows.map((row) => row.kind), ["turn", "event"]);
  assert.equal(rows[1]?.event?.id, "evt-system-1");
});

test("statistics: event rows and unattached events keep the muted accounting note", () => {
  const model = eventRowModel(event());
  assert.equal(model.time, "22:13:20.500");
  assert.match(model.note, /not included in turn\/step totals/);
  const unattached = unattachedEvents(
    analysis({ events: [event({ turnID: null, id: "evt-free" })] }),
  );
  assert.deepEqual(unattached.map((item) => item.id), ["evt-free"]);
});

/* -------------------------------------------------------------------- totals */

test("statistics: the final row is labelled by scope, never hard-coded", () => {
  assert.equal(scopeLabel({ scope: "session" }), "Session total");
  assert.equal(scopeLabel({ scope: "window" }), "Window total");
  const basic = buildBasicTotals(analysis());
  assert.equal(basic.cells[0]?.text, "Session total");
  assert.equal(basic.cells[0]?.span, 2);
  const advanced = buildAdvancedTotals(analysis());
  assert.equal(advanced.cells[0]?.span, 5);
  assert.equal(advanced.cells.at(-1)?.text, "1 turns");
});

test("statistics: the Advanced total row keeps both context figures and the recorded comparison", () => {
  const totals = buildAdvancedTotals(analysis());
  const context = totals.cells[7];
  assert.match(context?.text ?? "", /Final 1,120/);
  assert.match(context?.text ?? "", /Cumulative 2,240/);
  const recorded = buildRecordedLegend(analysis());
  assert.match(recorded?.text ?? "", /Recorded by OpenCode: in 1,000 · out 200/);
  assert.match(recorded?.text ?? "", /cost \$0\.0400/);
  assert.equal(buildRecordedLegend(analysis({ totals: { ...analysis().totals, recorded: undefined } })), null);
});

/* --------------------------------------------------------------------- tiles */

test("statistics: Basic shows four tiles, Advanced the second row of four", () => {
  assert.deepEqual(
    buildStatTiles(analysis(), "basic").map((tile) => tile.id),
    ["turns", "tokens", "cost", "errors"],
  );
  assert.deepEqual(
    buildStatTiles(analysis(), "advanced").map((tile) => tile.id),
    ["turns", "tokens", "cache", "cost", "model-time", "tool-time", "errors", "speed"],
  );
});

test("statistics: every tile carries an M, D, E or — superscript and no icon", () => {
  const tiles = buildStatTiles(analysis(), "advanced");
  for (const tile of tiles) {
    assert.ok(["M", "D", "E", "—"].includes(tile.mark), `${tile.id} mark ${tile.mark}`);
    assert.equal(tile.label, tile.label.trim());
  }
  assert.deepEqual(
    tiles.slice(0, 2).map((tile) => tile.mark),
    ["M", "M"],
  );
});

test("statistics: an unavailable tile metric reads — and never becomes zero", () => {
  const source = analysis();
  const data = analysis({
    totals: { ...source.totals, cost: metric(null, "unavailable"), outputSpeed: metric(null, "unavailable") },
  });
  const tiles = buildStatTiles(data, "advanced");
  const cost = tiles.find((tile) => tile.id === "cost");
  const speed = tiles.find((tile) => tile.id === "speed");
  assert.equal(cost?.value, "—");
  assert.equal(cost?.mark, "—");
  assert.equal(speed?.value, "—");
  assert.equal(speed?.mark, "—");
});

test("statistics: the summary carries active and wall marks in Advanced only", () => {
  const basic = buildSummary(analysis(), "basic").map((piece) => piece.text).join(" ");
  assert.match(basic, /1 turns/);
  assert.doesNotMatch(basic, /active/);
  const advanced = buildSummary(analysis(), "advanced");
  const active = advanced.find((piece) => piece.text.startsWith("active"));
  assert.equal(active?.mark, "M");
  assert.ok(advanced.some((piece) => piece.text.startsWith("wall")));
});

/* ------------------------------------------------------------- step detail */

test("statistics: step detail renders the response, facts, tools and the jump target", () => {
  const detail = buildStepDetail(turn(), step(), 4_000);
  assert.equal(detail.heading, "Response");
  assert.match(detail.html, /<strong>world<\/strong>/);
  assert.equal(detail.truncated, false);
  assert.deepEqual(
    detail.facts.map((fact) => fact.label),
    ["Trigger", "Start", "End", "Model", "Provider", "TTFT", "Finish", "Tools", "Subagents", "Uncertainty"],
  );
  assert.equal(detail.facts[5]?.value, "—");
  assert.equal(detail.tools.length, 1);
  assert.equal(detail.jump?.eventID, "evt-step-1");
});

test("statistics: step detail says when the text was truncated by the response limit", () => {
  const long = "word ".repeat(2_000);
  const detail = buildStepDetail(turn(), step({ responseText: long }), 4_000);
  assert.equal(detail.truncated, true);
});

/* ------------------------------------------------------------------- toolbar */

test("statistics: the toolbar lists tab, copy and legend vocabulary", () => {
  assert.deepEqual(STATS_TAB_OPTIONS.map((option) => option.id), ["table", "charts"]);
  assert.deepEqual(COPY_ACTIONS.map((action) => action.id), ["review", "digest"]);
  assert.match(COPY_ACTIONS[0]?.notice ?? "", /Phase 6/);
  assert.deepEqual(
    BASIS_LEGEND.map((entry) => entry.mark),
    ["M", "D", "E", "—"],
  );
  assert.deepEqual(
    BASIS_LEGEND.map((entry) => entry.label),
    ["measured", "derived", "estimated", "unavailable"],
  );
});

/* ------------------------------------------------------------------ module */

test("statistics: the model module is DOM-free", async () => {
  const source = await readFile(
    new URL("../src/web/lib/statistics.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bdocument\./);
  assert.doesNotMatch(source, /\bwindow\./);
  assert.doesNotMatch(source, /\bReact\b/);
});
