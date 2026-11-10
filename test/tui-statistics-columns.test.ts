import test from "node:test";
import assert from "node:assert/strict";

import type { Metric, Step, Turn } from "../src/core/types.ts";
import {
  BREAKPOINTS,
  columnLabel,
  columnWidth,
  contextPair,
  formatHeader,
  formatRow,
  layout,
  resolveLayout,
  turnCellValues,
  turnTriggerLabel,
} from "../src/plugin/tui/statistics/columns.ts";
import {
  formatStepRow,
  stepCellValues,
  stepFields,
} from "../src/plugin/tui/statistics/stepRows.ts";
import { clampIndex, moveSelection } from "../src/plugin/tui/statistics/state.ts";

const FULL_COLUMNS = [
  "turn",
  "steps",
  "tokIn",
  "tokOut",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "cacheHit",
  "modelMs",
  "toolMs",
  "residual",
  "cost",
  "status",
] as const;

const NARROW_MID_COLUMNS = [
  "turn",
  "steps",
  "tokIn",
  "tokOut",
  "cost",
  "status",
] as const;

const COMPACT_COLUMNS = ["turn", "tokens", "cost", "status"] as const;

function measured(value: number | null): Metric {
  return { value, basis: "measured" };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "t1",
    index: 1,
    trigger: { kind: "user", eventID: "e1", label: "User message" },
    startTime: 0,
    endTime: 1_500,
    status: "completed",
    steps: [],
    eventIDs: ["e1"],
    nonStepEventIDs: [],
    firstStepStart: 0,
    lastStepEnd: 1_500,
    tokens: {
      input: 1234,
      output: 999,
      reasoning: 12,
      cacheRead: 400,
      cacheWrite: 20,
    },
    tokensComplete: true,
    promptTokensLatest: { value: 1200, basis: "measured" },
    promptTokensCumulative: { value: 2500, basis: "derived" },
    cacheHitRate: { value: 0.42, basis: "derived" },
    contextDelta: { value: null, basis: "unavailable" },
    cost: { value: 0.0123, basis: "derived" },
    modelTime: { value: 1500, basis: "measured" },
    toolTime: { value: null, basis: "unavailable" },
    totalTime: { value: 1500, basis: "measured" },
    residualTime: { value: null, basis: "unavailable" },
    outputSpeed: { value: null, basis: "unavailable" },
    uncertainty: [],
    ...overrides,
  };
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "s1",
    turnID: "t1",
    index: 2,
    trigger: "After tool results",
    startTime: 0,
    endTime: 1_500,
    startUnknown: false,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet" },
    provider: "anthropic",
    finish: "stop",
    toolNames: ["bash", "read"],
    toolCalls: [],
    tokens: { input: 1234, output: 34, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0.0123,
    promptTokens: { value: null, basis: "unavailable" },
    cacheHitRate: { value: null, basis: "unavailable" },
    ttft: { value: null, basis: "unavailable" },
    modelTime: { value: 1500, basis: "measured" },
    toolTime: { value: null, basis: "unavailable" },
    totalTime: { value: 1500, basis: "measured" },
    residualTime: { value: null, basis: "unavailable" },
    outputSpeed: { value: null, basis: "unavailable" },
    status: "completed",
    subagentSessionIDs: [],
    eventIDs: [],
    responseText: "",
    reasoningText: "",
    uncertainty: [],
    ...overrides,
  };
}

test("breakpoints pin the documented thresholds", () => {
  assert.deepEqual(BREAKPOINTS, {
    full: 120,
    wideMid: 100,
    mid: 90,
    narrowMid: 81,
    compact: 80,
  });
});

test("resolveLayout flips exactly at 119/120", () => {
  assert.equal(resolveLayout(120).mode, "full");
  assert.deepEqual(resolveLayout(120).columns, FULL_COLUMNS);
  assert.equal(resolveLayout(119).mode, "mid");
  assert.deepEqual(resolveLayout(119).columns, [
    "turn",
    "steps",
    "tokIn",
    "tokOut",
    "cacheRead",
    "cacheWrite",
    "cacheHit",
    "modelMs",
    "toolMs",
    "residual",
    "cost",
    "status",
  ]);
});

test("resolveLayout flips exactly at 80/81", () => {
  assert.equal(resolveLayout(81).mode, "mid");
  assert.deepEqual(resolveLayout(81).columns, NARROW_MID_COLUMNS);
  assert.equal(resolveLayout(80).mode, "compact");
  assert.deepEqual(resolveLayout(80).columns, COMPACT_COLUMNS);
});

test("resolveLayout keeps ordered column sets per documented width", () => {
  assert.deepEqual(resolveLayout(130).columns, FULL_COLUMNS);

  const wideMid = resolveLayout(110).columns;
  assert.equal(wideMid.includes("reasoning"), false);
  assert.equal(wideMid.includes("cacheWrite"), true);
  assert.deepEqual(wideMid, [
    "turn",
    "steps",
    "tokIn",
    "tokOut",
    "cacheRead",
    "cacheWrite",
    "cacheHit",
    "modelMs",
    "toolMs",
    "residual",
    "cost",
    "status",
  ]);

  const mid = resolveLayout(95).columns;
  assert.equal(mid.includes("reasoning"), false);
  assert.equal(mid.includes("cacheWrite"), false);
  assert.deepEqual(mid, [
    "turn",
    "steps",
    "tokIn",
    "tokOut",
    "cacheRead",
    "cacheHit",
    "modelMs",
    "toolMs",
    "residual",
    "cost",
    "status",
  ]);

  assert.deepEqual(resolveLayout(85).columns, NARROW_MID_COLUMNS);
  assert.deepEqual(resolveLayout(70).columns, COMPACT_COLUMNS);
});

test("resolveLayout covers every mid-ground threshold", () => {
  assert.equal(resolveLayout(100).columns.includes("reasoning"), false);
  assert.equal(resolveLayout(99).columns.includes("cacheWrite"), false);
  assert.equal(resolveLayout(90).columns.includes("cacheWrite"), false);
  assert.equal(resolveLayout(89).columns.includes("cacheRead"), false);
  assert.equal(resolveLayout(81).columns.includes("residual"), false);
  assert.equal(resolveLayout(100).mode, "mid");
  assert.equal(resolveLayout(90).mode, "mid");
});

test("resolveLayout coerces the width without surprises", () => {
  assert.deepEqual(resolveLayout(-5), {
    width: 0,
    mode: "compact",
    columns: COMPACT_COLUMNS,
  });
  assert.deepEqual(resolveLayout(Number.NaN), {
    width: 0,
    mode: "compact",
    columns: COMPACT_COLUMNS,
  });
  assert.equal(resolveLayout(Number.POSITIVE_INFINITY).width, 0);
  assert.equal(resolveLayout(119.9).width, 119);
  assert.equal(resolveLayout(119.9).mode, "mid");
  assert.equal(resolveLayout(120.1).mode, "full");
  assert.equal(resolveLayout(80.9).mode, "compact");
});

test("layout is the pure width alias", () => {
  assert.equal(layout, resolveLayout);
  assert.deepEqual(layout(70), resolveLayout(70));
});

test("column labels and widths follow the table convention", () => {
  assert.equal(columnLabel("turn"), "#");
  assert.equal(columnLabel("tokens"), "Tokens");
  assert.equal(columnLabel("status"), "Status");
  assert.equal(columnWidth("turn"), 4);
  assert.equal(columnWidth("tokens"), 17);
  assert.equal(columnWidth("status"), 6);
});

test("formatHeader pads numbers right and status left", () => {
  assert.equal(
    formatHeader(["turn", "tokens", "cost", "status"]),
    "     #            Tokens       Cost Status",
  );
  assert.equal(
    formatHeader(resolveLayout(130).columns),
    "     # Steps       In      Out  Reason   CacheR   CacheW      Hit     Model      Tool     Resid       Cost Status",
  );
  assert.equal(formatHeader(["status"]).startsWith(" "), true);
});

test("formatRow keeps the selection marker and splits the status cell", () => {
  const turn = makeTurn();
  const compact = formatRow(turn, COMPACT_COLUMNS, true, false);
  assert.equal(compact.prefix, ">    1     1.2k M/2.5k D  $0.0123 D");
  assert.equal(compact.status, " OK    ");

  const plain = formatRow(turn, COMPACT_COLUMNS, false);
  assert.equal(plain.prefix, "     1     1.2k M/2.5k D  $0.0123 D");
  assert.equal(plain.prefix.includes("OK"), false);
  assert.equal((compact.prefix + compact.status).length, 42);
});

test("formatRow accordion marker reflects steps and expansion", () => {
  const withSteps = makeTurn({ steps: [makeStep()] });
  const collapsed = formatRow(withSteps, COMPACT_COLUMNS, true, false);
  assert.equal(collapsed.prefix.charAt(0), ">");
  assert.equal(collapsed.prefix.charAt(1), "+");

  const expanded = formatRow(withSteps, COMPACT_COLUMNS, true, true);
  assert.equal(expanded.prefix.charAt(1), "-");

  const noSteps = formatRow(makeTurn(), COMPACT_COLUMNS, true, false);
  assert.equal(noSteps.prefix.charAt(1), " ");

  const unselected = formatRow(withSteps, COMPACT_COLUMNS, false, false);
  assert.equal(unselected.prefix.charAt(0), " ");
});

test("turnCellValues keeps token sums and the status symbol", () => {
  const cells = turnCellValues(makeTurn());
  assert.deepEqual(cells, {
    turn: "1",
    steps: "0",
    tokIn: "1.2k",
    tokOut: "999",
    reasoning: "12",
    cacheRead: "400",
    cacheWrite: "20",
    cacheHit: "42.0% D",
    modelMs: "1.50 s M",
    toolMs: "—",
    residual: "—",
    cost: "$0.0123 D",
    status: "OK",
    tokens: "1.2k M/2.5k D",
  });
});

test("turnCellValues renders nulls and unavailable metrics as an em dash", () => {
  const cells = turnCellValues(
    makeTurn({
      cacheHitRate: { value: null, basis: "unavailable" },
      modelTime: { value: null, basis: "unavailable" },
      toolTime: { value: null, basis: "unavailable" },
      residualTime: { value: null, basis: "unavailable" },
      cost: { value: null, basis: "unavailable" },
    }),
  );
  assert.equal(cells.cacheHit, "—");
  assert.equal(cells.modelMs, "—");
  assert.equal(cells.toolMs, "—");
  assert.equal(cells.residual, "—");
  assert.equal(cells.cost, "—");
});

test("basis marks cover measured, derived, estimated and unavailable", () => {
  const cells = turnCellValues(
    makeTurn({
      cacheHitRate: { value: 0.5, basis: "measured" },
      modelTime: { value: 1500, basis: "derived" },
      toolTime: { value: 250, basis: "estimated" },
      residualTime: { value: 1, basis: "unavailable" },
    }),
  );
  assert.equal(cells.cacheHit, "50.0% M");
  assert.equal(cells.modelMs, "1.50 s D");
  assert.equal(cells.toolMs, "250 ms E");
  assert.equal(cells.residual, "1 ms —");
});

test("cost formatting follows the shared formatter", () => {
  const at = (value: number | null): string =>
    turnCellValues(makeTurn({ cost: measured(value) })).cost;
  assert.equal(at(0), "$0 M");
  assert.equal(at(1.5), "$1.50 M");
  assert.equal(at(0.0123), "$0.0123 M");
  assert.equal(at(0.000001), "$0.000001 M");
  assert.equal(at(null), "—");
});

test("the compact tokens cell pairs latest and cumulative context", () => {
  const turn = makeTurn();
  assert.equal(contextPair(turn), "1.2k M/2.5k D");
  assert.equal(turnCellValues(turn).tokens, contextPair(turn));

  const missing = makeTurn({
    promptTokensLatest: { value: null, basis: "unavailable" },
    promptTokensCumulative: { value: null, basis: "unavailable" },
  });
  assert.equal(contextPair(missing), "—/—");
  assert.equal(turnCellValues(missing).tokens, "—/—");
});

test("turnTriggerLabel falls back to an em dash", () => {
  assert.equal(turnTriggerLabel(makeTurn()), "User message");
  assert.equal(
    turnTriggerLabel(
      makeTurn({ trigger: { kind: "orphan", eventID: null, label: "" } }),
    ),
    "—",
  );
});

test("moveSelection and clampIndex clamp inside the turn list", () => {
  assert.equal(clampIndex(5, 3), 2);
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(2, 0), 0);
  assert.equal(clampIndex(Number.NaN, 3), 0);
  assert.equal(clampIndex(1.9, 3), 1);
  assert.equal(clampIndex(1, Number.NaN), 0);
  assert.equal(clampIndex(1, -4), 0);

  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 2);
  assert.equal(moveSelection(0, -1, 3), 0);
  assert.equal(moveSelection(1, 10, 3), 2);
  assert.equal(moveSelection(1, -10, 3), 0);
  assert.equal(moveSelection(1, 1, 0), 0);
  assert.equal(moveSelection(1, Number.NaN, 3), 1);
  assert.equal(moveSelection(Number.NaN, 1, 3), 1);
});

test("stepFields degrades at 119/120, 89/90 and 80/81", () => {
  assert.deepEqual(stepFields(130), [
    "index",
    "trigger",
    "model",
    "tools",
    "tokens",
    "cost",
    "time",
    "status",
  ]);
  assert.deepEqual(stepFields(120), [
    "index",
    "trigger",
    "model",
    "tools",
    "tokens",
    "cost",
    "time",
    "status",
  ]);
  assert.deepEqual(stepFields(119), [
    "index",
    "trigger",
    "model",
    "tokens",
    "cost",
    "time",
    "status",
  ]);
  assert.deepEqual(stepFields(90), [
    "index",
    "trigger",
    "model",
    "tokens",
    "cost",
    "time",
    "status",
  ]);
  assert.deepEqual(stepFields(89), [
    "index",
    "trigger",
    "tokens",
    "cost",
    "status",
  ]);
  assert.deepEqual(stepFields(81), [
    "index",
    "trigger",
    "tokens",
    "cost",
    "status",
  ]);
  assert.deepEqual(stepFields(80), ["index", "tokens", "cost", "status"]);
});

test("stepCellValues shapes every accordion cell", () => {
  assert.deepEqual(stepCellValues(makeStep()), {
    index: "2",
    trigger: "After tool results",
    model: "claude-sonnet",
    tools: "bash,read",
    tokens: "1.2k→34",
    cost: "$0.0123",
    time: "1.50 s M",
    status: "OK",
  });
});

test("step model falls back to the provider and then to an em dash", () => {
  assert.equal(
    stepCellValues(makeStep({ model: null, provider: "anthropic" })).model,
    "anthropic",
  );
  assert.equal(
    stepCellValues(
      makeStep({ model: { providerID: "p", id: "  " }, provider: " " }),
    ).model,
    "—",
  );
});

const anyCall = {} as unknown as Step["toolCalls"][number];

test("step tool summary prefers names, then call counts, then an em dash", () => {
  assert.equal(
    stepCellValues(makeStep({ toolNames: ["bash", "read"] })).tools,
    "bash,read",
  );
  assert.equal(
    stepCellValues(
      makeStep({
        toolNames: ["  ", ""],
        toolCalls: [anyCall, anyCall],
      }),
    ).tools,
    "2 calls",
  );
  assert.equal(
    stepCellValues(
      makeStep({
        toolNames: [],
        toolCalls: [anyCall],
      }),
    ).tools,
    "1 call",
  );
  assert.equal(
    stepCellValues(makeStep({ toolNames: [], toolCalls: [] })).tools,
    "—",
  );
});

test("step duration keeps the basis mark and unavailable stays an em dash", () => {
  assert.equal(
    stepCellValues(makeStep({ modelTime: { value: 1500, basis: "measured" } }))
      .time,
    "1.50 s M",
  );
  assert.equal(
    stepCellValues(makeStep({ modelTime: { value: 250, basis: "estimated" } }))
      .time,
    "250 ms E",
  );
  assert.equal(
    stepCellValues(makeStep({ modelTime: { value: null, basis: "unavailable" } }))
      .time,
    "—",
  );
});

test("step trigger and tokens survive missing values", () => {
  assert.equal(
    stepCellValues(makeStep({ trigger: " ", agent: "build" })).trigger,
    "build",
  );
  assert.equal(
    stepCellValues(makeStep({ trigger: " ", agent: " " })).trigger,
    "—",
  );
  assert.equal(stepCellValues(makeStep({ tokens: null })).tokens, "—");
  assert.equal(
    stepCellValues(makeStep({ index: Number.NaN })).index,
    "0",
  );
});

test("formatStepRow indents, splits status and degrades with width", () => {
  const wide = formatStepRow(makeStep(), 130);
  assert.equal(wide.prefix.startsWith("      2 "), true);
  assert.equal(wide.prefix.includes("OK"), false);
  assert.equal(wide.status, "    OK");

  const compact = formatStepRow(makeStep(), 80);
  assert.equal(compact.prefix, "      2           1.2k→34    $0.0123");
  assert.equal(compact.status, "    OK");
});

test("formatStepRow clips long labels with an ellipsis", () => {
  const row = formatStepRow(
    makeStep({ model: { providerID: "p", id: "abcdefghijklmnopqrstuvwxyz0123456789" } }),
    130,
  );
  assert.equal(row.prefix.includes("abcdefghijklmnopqrstu…"), true);
  assert.equal(row.prefix.includes("abcdefghijklmnopqrstuvwxyz0123456789"), false);
});

test("formatStepRow honors an explicit field subset", () => {
  const row = formatStepRow(makeStep(), 130, ["index"]);
  assert.equal(row.prefix, "      2");
  assert.equal(row.status, "");
});
