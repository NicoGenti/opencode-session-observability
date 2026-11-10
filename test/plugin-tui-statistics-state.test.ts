import test from "node:test";
import assert from "node:assert/strict";

import {
  clampIndex,
  createStatisticsState,
  moveSelection,
} from "../src/plugin/tui/statistics/state.ts";

const SESSION = "ses_statistics";

type StatisticsRpcClient = Parameters<typeof createStatisticsState>[0];

type Responder = (sessionID: string) => unknown;

/** A fake SDK client whose RPC only answers `analysis`. */
function fakeClient(respond: Responder): {
  readonly client: StatisticsRpcClient;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const client = {
    rpc: () => ({
      analysis: async ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID);
        return respond(sessionID);
      },
    }),
  } as unknown as StatisticsRpcClient;
  return { client, calls };
}

/**
 * The parser validates shape, not the full `Turn` contract, so the fixture
 * carries only what the state reads: ids, order, the empty step list and the
 * totals the panel banner consumes.
 */
function analysisBody(
  ids: readonly string[],
  totals: Record<string, unknown> = {},
): unknown {
  return {
    session: { id: SESSION },
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
