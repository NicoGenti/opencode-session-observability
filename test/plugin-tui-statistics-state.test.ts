import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  LIVE_POLL_MS,
  advisoryGuardrailCount,
  advisoryRecommendationCount,
  clampIndex,
  createStatisticsState,
  moveSelection,
} from "../src/plugin/tui/statistics/state.ts";
import {
  guardrailsStatusLine,
  recommendationsStatusLine,
} from "../src/plugin/tui/statistics/status.ts";
import { ObservabilityService } from "../src/core/service.ts";
import { memorySource, toolsFixture } from "./fixtures/build.ts";
import { parseAnalysisResponse } from "../src/plugin/tui/analysisResponse.ts";
import { isSettledAnalysis } from "../src/plugin/tui/polling.ts";
import {
  reviewPromptFilePath,
  writeReviewPromptFile,
} from "../src/plugin/tui/digestFile.ts";

const SESSION = "ses_statistics";

type StatisticsRpcClient = Parameters<typeof createStatisticsState>[0];

type Responder = (sessionID: string) => unknown;

type ExportResponder = (input: unknown) => unknown;

/** A fake SDK client whose RPC answers `analysis` and `export`. */
function fakeClient(
  respond: Responder,
  respondExport: ExportResponder = () => ({ output: {} }),
): {
  readonly client: StatisticsRpcClient;
  readonly calls: string[];
  readonly exports: unknown[];
} {
  const calls: string[] = [];
  const exports: unknown[] = [];
  const client = {
    rpc: () => ({
      analysis: async ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID);
        return respond(sessionID);
      },
      export: async (input: unknown) => {
        exports.push(input);
        return respondExport(input);
      },
    }),
  } as unknown as StatisticsRpcClient;
  return { client, calls, exports };
}

/**
 * The parser validates shape, not the full `Turn` contract, so the fixture
 * carries only what the state reads: ids, order, the empty step list and the
 * totals the panel banner consumes.
 */
function analysisBody(
  ids: readonly string[],
  totals: Record<string, unknown> = {},
  session = SESSION,
): unknown {
  return {
    session: { id: session },
    totals,
    turns: ids.map((id, index) => ({ id, index, steps: [] })),
  };
}

test("fetchAnalysis fills the turn list and the KPI totals", async () => {
  const totals = {
    finalContext: { value: 900, basis: "measured" },
    cacheHitRate: { value: 0.42, basis: "derived" },
    cost: { value: 1.25, basis: "derived" },
    turns: 2,
  };
  const { client, calls } = fakeClient(() => ({
    output: { analysis: analysisBody(["t1", "t2"], totals) },
  }));
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);

  assert.equal(state.loading(), false);
  assert.equal(state.error(), null);
  assert.equal(state.sessionID(), SESSION);
  assert.deepEqual(
    state.turns().map((turn) => turn.id),
    ["t1", "t2"],
  );
  const banner = state.totals();
  assert.ok(banner);
  assert.equal(banner.turns, 2);
  assert.deepEqual(banner.totalContext, totals.finalContext);
  assert.deepEqual(banner.cacheHitRate, totals.cacheHitRate);
  assert.deepEqual(banner.cost, totals.cost);
  assert.deepEqual(calls, [SESSION]);
});

test("missing totals fall back to unavailable metrics and the turn count", async () => {
  const { client } = fakeClient(() => analysisBody(["t1"]));
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);

  const banner = state.totals();
  assert.ok(banner);
  assert.equal(banner.turns, 1);
  assert.equal(banner.totalContext.value, null);
  assert.equal(banner.totalContext.basis, "unavailable");
  assert.equal(banner.cost.value, null);
  assert.equal(banner.recommendations, 0);
});

test("the banner counts only advisory recommendation rows", async () => {
  const body = {
    session: { id: SESSION },
    totals: {},
    turns: [{ id: "t1", index: 1, steps: [] }],
    recommendations: {
      rows: [
        { id: "split-task:fact", kind: "fact", severity: "info" },
        { id: "split-task:hypothesis", kind: "hypothesis", severity: "advisory" },
        { id: "reuse-subagent:fact", kind: "fact", severity: "info" },
        { id: "reuse-subagent:hypothesis", kind: "hypothesis", severity: "advisory" },
      ],
      basisNotes: [],
    },
  };
  const { client } = fakeClient(() => ({ output: { analysis: body } }));
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);

  const banner = state.totals();
  assert.ok(banner);
  assert.equal(banner.recommendations, 2);
  assert.equal(advisoryRecommendationCount(state.analysis()), 2);
  assert.equal(recommendationsStatusLine(banner.recommendations), "Recommendations: 2 advisory");
});

test("a missing or malformed recommendation rider reads as zero", async () => {
  const cases: Array<{ rider: unknown; expected: number }> = [
    { rider: undefined, expected: 0 },
    { rider: null, expected: 0 },
    { rider: { rows: "nope" }, expected: 0 },
    { rider: { rows: [{ id: "x" }] }, expected: 0 },
    { rider: { rows: [{ severity: "advisory" }] }, expected: 1 },
  ];
  for (const entry of cases) {
    const body = {
      session: { id: SESSION },
      totals: {},
      turns: [{ id: "t1", index: 1, steps: [] }],
      recommendations: entry.rider,
    };
    const { client } = fakeClient(() => ({ output: { analysis: body } }));
    const state = createStatisticsState(client);

    await state.fetchAnalysis(SESSION);

    const banner = state.totals();
    assert.ok(banner);
    assert.equal(banner.recommendations, entry.expected);
  }
  assert.equal(advisoryRecommendationCount(null), 0);
  assert.equal(advisoryRecommendationCount(undefined), 0);
});

test("the banner counts advisory guardrail warnings under the default budgets", async () => {
  const service = new ObservabilityService(memorySource(toolsFixture()));
  const { analysis } = await service.analyze("ses_tools", { reveal: true });
  // Twelve retries cross the default retry budget of ten.
  const body = {
    ...analysis,
    totals: { ...analysis.totals, retries: 12 },
  };
  const { client } = fakeClient(() => ({ output: { analysis: body } }));
  const state = createStatisticsState(client);

  await state.fetchAnalysis("ses_tools");

  const banner = state.totals();
  assert.ok(banner);
  assert.equal(banner.guardrails, 1);
  assert.equal(advisoryGuardrailCount(state.analysis()), 1);
  assert.equal(
    guardrailsStatusLine(banner.guardrails),
    "Guardrails (defaults): 1 advisory",
  );
});

test("a truncated analysis reads as zero guardrail warnings", async () => {
  const { client } = fakeClient(() => analysisBody(["t1"]));
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);

  const banner = state.totals();
  assert.ok(banner);
  assert.equal(banner.guardrails, 0);
  assert.equal(advisoryGuardrailCount(state.analysis()), 0);
  assert.equal(advisoryGuardrailCount(null), 0);
  assert.equal(advisoryGuardrailCount(undefined), 0);
});

test("fetchAnalysis surfaces a malformed response as an error state", async () => {
  for (const response of [
    { output: { nope: true } },
    { analysis: "not an object" },
    { error: { message: "boom" } },
  ]) {
    const { client } = fakeClient(() => response);
    const state = createStatisticsState(client);

    await state.fetchAnalysis(SESSION);

    assert.equal(state.analysis(), null);
    assert.equal(state.loading(), false);
    assert.ok(state.error());
  }
});

test("fetchAnalysis keeps a failed request in the retry state", async () => {
  const { client } = fakeClient(() => {
    throw new Error("network down");
  });
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);

  assert.equal(state.analysis(), null);
  assert.equal(state.loading(), false);
  assert.equal(
    state.error(),
    "The analysis could not be loaded. Reopen the panel to retry.",
  );
});

test("a missing session id is an error and never reaches the RPC", async () => {
  const { client, calls } = fakeClient(() => analysisBody(["t1"]));
  const state = createStatisticsState(client);

  await state.fetchAnalysis("   ");

  assert.deepEqual(calls, []);
  assert.equal(state.error(), "No session is selected.");
  assert.equal(state.loading(), false);
  assert.deepEqual(state.turns(), []);
});

test("an analysis without turns keeps the empty state", async () => {
  const { client } = fakeClient(() => analysisBody([]));
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);

  assert.equal(state.error(), null);
  assert.ok(state.analysis());
  assert.deepEqual(state.turns(), []);
});

test("clampIndex and moveSelection stay inside the turn list", () => {
  assert.equal(clampIndex(-4, 3), 0);
  assert.equal(clampIndex(1, 3), 1);
  assert.equal(clampIndex(9, 3), 2);
  assert.equal(clampIndex(2, 0), 0);
  assert.equal(clampIndex(Number.NaN, 3), 0);

  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 5, 3), 2);
  assert.equal(moveSelection(0, -9, 3), 0);
  assert.equal(moveSelection(1, Number.NaN, 3), 1);
});

test("selection math clamps inside the turn list", async () => {
  const { client } = fakeClient(() => analysisBody(["t1", "t2", "t3"]));
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);

  state.moveSelection(1);
  assert.equal(state.selectedIndex(), 1);
  state.moveSelection(5);
  assert.equal(state.selectedIndex(), 2);
  state.moveSelection(-99);
  assert.equal(state.selectedIndex(), 0);

  state.setSelectedIndex(99);
  assert.equal(state.selectedIndex(), 2);
  assert.equal(state.isSelected(state.turns()[2]!), true);
  assert.equal(state.isSelected(state.turns()[0]!), false);
});

test("toggleTurnExpand flips ids and ignores blank input", () => {
  const { client } = fakeClient(() => analysisBody(["t1"]));
  const state = createStatisticsState(client);

  state.toggleTurnExpand("t1");
  assert.deepEqual([...state.expandedTurns()], ["t1"]);
  state.toggleTurnExpand("t1");
  assert.equal(state.expandedTurns().size, 0);

  state.toggleTurnExpand("   ");
  state.toggleTurnExpand(undefined as unknown as string);
  assert.equal(state.expandedTurns().size, 0);
});

test("reconcile clamps the selection and drops expanded turns that vanish", async () => {
  let response: unknown = analysisBody(["t1", "t2", "t3"]);
  const { client } = fakeClient(() => response);
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);
  state.setSelectedIndex(2);
  state.toggleTurnExpand("t2");
  state.toggleTurnExpand("t3");
  assert.deepEqual([...state.expandedTurns()].sort(), ["t2", "t3"]);

  response = analysisBody(["t1"]);
  await state.fetchAnalysis(SESSION);

  assert.equal(state.selectedIndex(), 0);
  assert.deepEqual([...state.expandedTurns()], []);
  assert.equal(state.error(), null);
});

test("a session change resets selection and the accordion", async () => {
  const { client } = fakeClient(() => analysisBody(["t1", "t2"]));
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);
  state.setSelectedIndex(1);
  state.toggleTurnExpand("t2");

  await state.fetchAnalysis("ses_other");

  assert.equal(state.sessionID(), "ses_other");
  assert.equal(state.selectedIndex(), 0);
  assert.equal(state.expandedTurns().size, 0);
});

test("a stale response cannot overwrite a newer session (request ticket, F2)", async () => {
  const gates: Array<{
    readonly sessionID: string;
    readonly resolve: (value: unknown) => void;
  }> = [];
  const client = {
    rpc: () => ({
      analysis: ({ sessionID }: { sessionID: string }) =>
        new Promise<unknown>((resolve) => {
          gates.push({ sessionID, resolve });
        }),
    }),
  } as unknown as StatisticsRpcClient;
  const state = createStatisticsState(client);

  // Two requests in flight; neither has resolved.
  const stale = state.fetchAnalysis("ses_a");
  const current = state.fetchAnalysis("ses_b");
  assert.deepEqual(
    gates.map((gate) => gate.sessionID),
    ["ses_a", "ses_b"],
  );

  // The newer request resolves first and owns the state.
  gates[1]!.resolve(analysisBody(["b1"], {}, "ses_b"));
  await current;

  const settled = {
    sessionID: state.sessionID(),
    analysisSession: state.analysis()?.session?.id ?? null,
    turns: state.turns().map((turn) => turn.id),
    error: state.error(),
    loading: state.loading(),
    selectedIndex: state.selectedIndex(),
  };
  assert.deepEqual(settled, {
    sessionID: "ses_b",
    analysisSession: "ses_b",
    turns: ["b1"],
    error: null,
    loading: false,
    selectedIndex: 0,
  });

  // The stale request resolves afterwards: every field stays put.
  gates[0]!.resolve(analysisBody(["a1"], {}, "ses_a"));
  await stale;

  assert.deepEqual(
    {
      sessionID: state.sessionID(),
      analysisSession: state.analysis()?.session?.id ?? null,
      turns: state.turns().map((turn) => turn.id),
      error: state.error(),
      loading: state.loading(),
      selectedIndex: state.selectedIndex(),
    },
    settled,
  );
});

/** Lets the pending `fetchAnalysis` continuation run under mocked intervals. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("startLivePolling re-fetches every 5 seconds and stops on close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, calls } = fakeClient(() => ({
    output: { analysis: analysisBody(["t1"]) },
  }));
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);
  assert.deepEqual(calls, [SESSION]);

  state.startLivePolling(SESSION);

  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();
  assert.deepEqual(calls, [SESSION, SESSION]);

  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();
  assert.deepEqual(calls, [SESSION, SESSION, SESSION]);

  state.stopLivePolling();
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();
  assert.equal(calls.length, 3);
  assert.deepEqual(
    state.turns().map((turn) => turn.id),
    ["t1"],
  );
});

test("a live poll keeps the previous frame until the response lands", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const gates: Array<(value: unknown) => void> = [];
  let first = true;
  const client = {
    rpc: () => ({
      analysis: () => {
        if (first) {
          first = false;
          return analysisBody(["t1"]);
        }
        return new Promise<unknown>((resolve) => gates.push(resolve));
      },
    }),
  } as unknown as StatisticsRpcClient;
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);

  state.startLivePolling(SESSION);
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();

  assert.deepEqual(
    state.turns().map((turn) => turn.id),
    ["t1"],
  );
  assert.equal(state.error(), null);

  gates[0]!(analysisBody(["t1", "t2"]));
  await flush();
  assert.deepEqual(
    state.turns().map((turn) => turn.id),
    ["t1", "t2"],
  );
  state.stopLivePolling();
});

test("live polling never overlaps an in-flight request", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const gates: Array<(value: unknown) => void> = [];
  const client = {
    rpc: () => ({
      analysis: () =>
        new Promise<unknown>((resolve) => {
          gates.push(resolve);
        }),
    }),
  } as unknown as StatisticsRpcClient;
  const state = createStatisticsState(client);

  state.startLivePolling(SESSION);
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();

  assert.equal(gates.length, 1);
  state.stopLivePolling();
  gates[0]!(analysisBody(["t1"]));
  await flush();
});

test("startLivePolling ignores a blank session id", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, calls } = fakeClient(() => analysisBody(["t1"]));
  const state = createStatisticsState(client);

  state.startLivePolling("   ");
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();

  assert.deepEqual(calls, []);
  state.stopLivePolling();
});

/** A settled analysis: terminal outcome, idle clock, last turn completed. */
function settledAnalysis(sessionID = SESSION): unknown {
  return {
    session: {
      id: sessionID,
      outcome: "succeeded",
      time: { created: 1_000, updated: 5_000, busy: 1_000, idle: 5_000 },
    },
    totals: {},
    turns: [{ id: "t1", index: 0, status: "completed", steps: [] }],
  };
}

/** A still-busy analysis: no outcome and a busy clock ahead of idle. */
function activeAnalysis(sessionID = SESSION): unknown {
  return {
    session: {
      id: sessionID,
      time: { created: 1_000, updated: 5_000, busy: 5_000, idle: 1_000 },
    },
    totals: {},
    turns: [{ id: "t1", index: 0, status: "running", steps: [] }],
  };
}

test("a malformed live response keeps the last good frame for the same session", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let response: unknown = { output: { analysis: analysisBody(["t1"]) } };
  const { client } = fakeClient(() => response);
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);

  state.startLivePolling(SESSION);
  response = { output: { nope: true } };
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();

  assert.deepEqual(
    state.turns().map((turn) => turn.id),
    ["t1"],
  );
  assert.ok(state.error());
  state.stopLivePolling();
});

test("a malformed response for another session still clears the turn table", async () => {
  const { client } = fakeClient(() => ({ output: { nope: true } }));
  const state = createStatisticsState(client);

  await state.fetchAnalysis(SESSION);

  assert.equal(state.analysis(), null);
  assert.ok(state.error());
});

test("live polling stops once the fetched analysis is settled", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, calls } = fakeClient(() => ({
    output: { analysis: settledAnalysis() },
  }));
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);
  state.startLivePolling(SESSION);

  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();
  assert.equal(calls.length, 2);

  // The settled frame cleared the timer: no further requests.
  t.mock.timers.tick(LIVE_POLL_MS);
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();
  assert.equal(calls.length, 2);
});

test("live polling continues while the session is still busy", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, calls } = fakeClient(() => ({
    output: { analysis: activeAnalysis() },
  }));
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);
  state.startLivePolling(SESSION);

  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();
  t.mock.timers.tick(LIVE_POLL_MS);
  await flush();

  assert.equal(calls.length, 3);
  state.stopLivePolling();
});

test("isSettledAnalysis needs a terminal outcome and an idle clock", () => {
  const settled = parseAnalysisResponse(settledAnalysis());
  assert.equal(settled.ok, true);
  if (!settled.ok) return;
  assert.equal(isSettledAnalysis(settled.analysis), true);

  const active = parseAnalysisResponse(activeAnalysis());
  assert.equal(active.ok, true);
  if (!active.ok) return;
  assert.equal(isSettledAnalysis(active.analysis), false);

  assert.equal(isSettledAnalysis(null), false);

  const runningTurn = parseAnalysisResponse({
    ...(settledAnalysis() as Record<string, unknown>),
    turns: [{ id: "t1", index: 0, status: "running", steps: [] }],
  });
  assert.equal(runningTurn.ok, true);
  if (runningTurn.ok) assert.equal(isSettledAnalysis(runningTurn.analysis), false);

  const openTurnNoOutcome = parseAnalysisResponse({
    session: {
      id: SESSION,
      time: { created: 1_000, updated: 5_000, busy: 1_000, idle: 5_000 },
    },
    totals: {},
    turns: [{ id: "t1", index: 0, status: "unknown", steps: [] }],
  });
  assert.equal(openTurnNoOutcome.ok, true);
  if (openTurnNoOutcome.ok) {
    assert.equal(isSettledAnalysis(openTurnNoOutcome.analysis), false);
  }
});

test("fetchReviewPrompt asks for a redacted digest prompt and returns its file surface", async () => {
  const content =
    "You are reviewing an OpenCode coding-agent session\n\n# Session digest — x";
  const { client, exports } = fakeClient(
    () => analysisBody(["t1"]),
    () => ({
      output: {
        filename: "ses-statistics-review-prompt.md",
        mime: "text/markdown; charset=utf-8",
        content,
        redacted: true,
      },
    }),
  );
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);

  const outcome = await state.fetchReviewPrompt();

  assert.deepEqual(outcome, {
    ok: true,
    sessionID: SESSION,
    filename: "ses-statistics-review-prompt.md",
    content,
  });
  assert.deepEqual(exports, [
    { sessionID: SESSION, format: "digest", prompt: true },
  ]);
  assert.equal("reveal" in (exports[0] as object), false);
});

test("fetchReviewPrompt reports malformed and failed responses without throwing", async () => {
  for (const response of [
    { output: { nope: true } },
    { error: { message: "boom" } },
    "not an object",
  ]) {
    const { client } = fakeClient(
      () => analysisBody(["t1"]),
      () => response,
    );
    const state = createStatisticsState(client);
    await state.fetchAnalysis(SESSION);

    const outcome = await state.fetchReviewPrompt();

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.error.length > 0);
  }

  const { client } = fakeClient(
    () => analysisBody(["t1"]),
    () => {
      throw new Error("rpc down");
    },
  );
  const state = createStatisticsState(client);
  await state.fetchAnalysis(SESSION);

  const outcome = await state.fetchReviewPrompt();

  assert.deepEqual(outcome, {
    ok: false,
    error: "The review prompt could not be generated.",
  });
});

test("fetchReviewPrompt refuses an unset session without reaching the RPC", async () => {
  const { client, exports } = fakeClient(() => analysisBody(["t1"]));
  const state = createStatisticsState(client);

  const outcome = await state.fetchReviewPrompt();

  assert.deepEqual(outcome, {
    ok: false,
    error: "No session is selected.",
  });
  assert.deepEqual(exports, []);
});

test("reviewPromptFilePath is deterministic and sanitized", () => {
  const path = reviewPromptFilePath("C:/tmp", "ses/../../Evil Session?!");
  assert.equal(
    path,
    join("C:/tmp", "opencode-observability-review-ses-evil-session.md"),
  );
  assert.ok(!path.includes(".."));

  const first = reviewPromptFilePath("C:/tmp", "ses_statistics");
  const second = reviewPromptFilePath("C:/tmp", "ses_statistics");
  assert.equal(first, second);
  assert.equal(
    first,
    join("C:/tmp", "opencode-observability-review-ses-statistics.md"),
  );
});

test("writeReviewPromptFile hands the path and content to the injected writer", async () => {
  const writes: Array<readonly [string, string]> = [];
  await writeReviewPromptFile("C:/tmp/prompt.md", "body", async (path, content) => {
    writes.push([path, content]);
  });
  assert.deepEqual(writes, [["C:/tmp/prompt.md", "body"]]);
});
