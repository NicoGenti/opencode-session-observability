import test from "node:test";
import assert from "node:assert/strict";

import { parseAnalysisResponse } from "../src/plugin/tui/analysisResponse.ts";
import {
  createTrajectoryState,
  type TrajectoryRpcClient,
} from "../src/plugin/tui/trajectory/state.ts";

const SESSION = "ses_trajectory";

type Responder = (sessionID: string) => unknown;

/** A fake SDK client whose RPC only answers `analysis`. */
function fakeClient(respond: Responder): {
  readonly client: TrajectoryRpcClient;
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
  } as unknown as TrajectoryRpcClient;
  return { client, calls };
}

/**
 * The parser validates shape, not the full `Turn` contract, so the fixture only
 * carries what the state reads: ids, order and the empty step list.
 */
function analysisBody(ids: readonly string[], session = SESSION): unknown {
  return {
    session: { id: session },
    totals: {},
    turns: ids.map((id, index) => ({ id, index, steps: [] })),
  };
}

test("the shared parser accepts every envelope the panels receive", () => {
  const body = analysisBody(["t1"]);

  const bare = parseAnalysisResponse(body);
  assert.equal(bare.ok, true);

  const wrapped = parseAnalysisResponse({ analysis: body, revealAllowed: false });
  assert.equal(wrapped.ok, true);

  const enveloped = parseAnalysisResponse({ output: { analysis: body } });
  assert.equal(enveloped.ok, true);

  const missing = parseAnalysisResponse({ analysis: "not an object" });
  assert.deepEqual(missing, {
    ok: false,
    message: "No analysis is available for this session.",
  });

  const failed = parseAnalysisResponse({ error: { message: "boom" } });
  assert.deepEqual(failed, {
    ok: false,
    message: "The analysis request returned an error.",
  });

  const unknownShape = parseAnalysisResponse({ nope: true });
  assert.deepEqual(unknownShape, {
    ok: false,
    message: "The analysis response was not recognized.",
  });
});

test("fetchAnalysis fills the turn list from the analysis response", async () => {
  const { client, calls } = fakeClient(() => ({
    output: { analysis: analysisBody(["t1", "t2"]) },
  }));
  const state = createTrajectoryState(client);

  await state.fetchAnalysis(SESSION);

  assert.equal(state.loading(), false);
  assert.equal(state.error(), null);
  assert.equal(state.sessionID(), SESSION);
  assert.equal(state.selectedIndex(), 0);
  assert.deepEqual(
    state.turns().map((turn) => turn.id),
    ["t1", "t2"],
  );
  assert.deepEqual(calls, [SESSION]);
});

test("fetchAnalysis surfaces a malformed response as an error state", async () => {
  for (const response of [
    { output: { nope: true } },
    { analysis: "not an object" },
    { error: { message: "boom" } },
  ]) {
    const { client } = fakeClient(() => response);
    const state = createTrajectoryState(client);

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
  const state = createTrajectoryState(client);

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
  const state = createTrajectoryState(client);

  await state.fetchAnalysis("   ");

  assert.deepEqual(calls, []);
  assert.equal(state.error(), "No session is selected.");
  assert.equal(state.loading(), false);
  assert.deepEqual(state.turns(), []);
});

test("an analysis without turns keeps the empty state", async () => {
  const { client } = fakeClient(() => analysisBody([]));
  const state = createTrajectoryState(client);

  await state.fetchAnalysis(SESSION);

  assert.equal(state.error(), null);
  assert.ok(state.analysis());
  assert.deepEqual(state.turns(), []);
});

test("selection math clamps inside the turn list", async () => {
  const { client } = fakeClient(() => analysisBody(["t1", "t2", "t3"]));
  const state = createTrajectoryState(client);
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

  // A blank or unknown turn id is ignored rather than poisoning the set.
  state.toggleTurnExpand("   ");
  assert.equal(state.expandedTurns().size, 0);
});

test("reconcile clamps the selection and drops expanded turns that vanish", async () => {
  let response: unknown = analysisBody(["t1", "t2", "t3"]);
  const { client } = fakeClient(() => response);
  const state = createTrajectoryState(client);

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
  const state = createTrajectoryState(client);

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
  } as unknown as TrajectoryRpcClient;
  const state = createTrajectoryState(client);

  const stale = state.fetchAnalysis("ses_a");
  const current = state.fetchAnalysis("ses_b");
  assert.deepEqual(
    gates.map((gate) => gate.sessionID),
    ["ses_a", "ses_b"],
  );

  // The newer request resolves first and owns the state.
  gates[1]!.resolve(analysisBody(["b1"], "ses_b"));
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
  gates[0]!.resolve(analysisBody(["a1"], "ses_a"));
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
