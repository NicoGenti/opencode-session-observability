import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import {
  BASE,
  compactionFixture,
  incompleteFixture,
  longFixture,
  memorySource,
  outOfOrderFixture,
  retryFixture,
  simpleFixture,
  subagentFixture,
  toolsFixture,
  secretsFixture,
} from "./fixtures/build.ts";

async function analyze(
  data: ReturnType<typeof simpleFixture>,
  sessionID: string,
) {
  const service = new ObservabilityService(memorySource(data));
  return (await service.analyze(sessionID)).analysis;
}

test("projects a simple session into one turn and one step", async () => {
  const analysis = await analyze(simpleFixture(), "ses_simple");
  assert.equal(analysis.turns.length, 1);
  assert.equal(analysis.turns[0]!.steps.length, 1);
  assert.equal(analysis.totals.turns, 1);
  assert.equal(analysis.totals.steps, 1);
  assert.equal(analysis.totals.scope, "session");
  assert.equal(analysis.coverage.complete, true);

  const turn = analysis.turns[0]!;
  const step = turn.steps[0]!;
  assert.equal(turn.trigger.kind, "user");
  assert.equal(turn.status, "completed");
  assert.equal(step.promptTokens.value, 150);
  assert.equal(step.cacheHitRate.value, 50 / 150);
  assert.equal(step.modelTime.value, 400);
  assert.equal(step.totalTime.value, 500);
  assert.equal(step.toolTime.value, 0);
  assert.equal(step.residualTime.value, 100);
  assert.equal(step.outputSpeed.value, 50);
  assert.equal(step.ttft.basis, "unavailable");
  assert.equal(step.status, "completed");

  assert.equal(turn.promptTokensLatest.value, 150);
  assert.equal(turn.promptTokensCumulative.value, 150);
  assert.equal(turn.contextDelta.value, null);
  assert.equal(turn.cost.value, 0.01);
  assert.equal(analysis.totals.tokens.input, 100);
  assert.equal(analysis.totals.tokens.cacheRead, 50);
  assert.equal(analysis.totals.cacheHitRate.value, 50 / 150);
  assert.equal(analysis.totals.outputSpeed.value, 50);
  assert.equal(analysis.totals.finalContext.value, 150);
  assert.equal(analysis.totals.recorded?.tokens?.input, 100);
});

test("projects tool steps and excludes parallel overlap from wall-clock", async () => {
  const analysis = await analyze(toolsFixture(), "ses_tools");
  assert.equal(analysis.turns.length, 1);
  assert.equal(analysis.turns[0]!.steps.length, 2);
  assert.equal(analysis.totals.toolCalls, 2);
  assert.equal(analysis.totals.errors.tool, 1);
  assert.equal(analysis.totals.errors.total, 1);

  const first = analysis.turns[0]!.steps[0]!;
  assert.equal(first.promptTokens.value, 4_500);
  assert.equal(first.toolTime.value, 700);
  assert.match(first.toolTime.note ?? "", /parallel/);
  assert.equal(first.modelTime.value, 400);
  assert.equal(first.totalTime.value, 1_300);
  assert.equal(first.residualTime.value, 200);
  assert.equal(first.outputSpeed.value, 250);

  const turn = analysis.turns[0]!;
  assert.equal(turn.modelTime.value, 800);
  assert.equal(turn.toolTime.value, 700);
  assert.equal(turn.totalTime.value, 1_900);
  assert.equal(turn.residualTime.value, 400);
  assert.equal(turn.promptTokensLatest.value, 3_000);
  assert.equal(turn.promptTokensCumulative.value, 7_500);
  assert.equal(turn.cacheHitRate.value, 4_000 / 7_500);
  assert.equal(analysis.totals.stepTokens.input, 3_000);
  assert.equal(analysis.totals.stepTokens.output, 150);
});

test("links a subagent tool to the child session and marks the delegated trigger", async () => {
  const data = subagentFixture();
  const service = new ObservabilityService(memorySource(data));
  const parent = (await service.analyze("ses_parent")).analysis;
  const toolEvent = parent.events.find((event) => event.kind === "tool")!;
  assert.equal(toolEvent.flags.subagent, true);
  const step = parent.turns[0]!.steps[0]!;
  assert.deepEqual(step.subagentSessionIDs, ["ses_child"]);

  const family = await service.getSession("ses_child");
  assert.equal(family.session.parentID, "ses_parent");
  assert.equal(family.family.parent?.id, "ses_parent");

  const child = (await service.analyze("ses_child")).analysis;
  assert.equal(child.turns[0]!.trigger.kind, "delegation");
  assert.equal(child.session.parentID, "ses_parent");
});

test("surfaces retries, step errors and failed idle outcomes", async () => {
  const analysis = await analyze(retryFixture(), "ses_retry");
  assert.equal(analysis.totals.retries, 1);
  assert.equal(analysis.totals.errors.step, 1);
  assert.equal(analysis.totals.errors.session, 1);
  assert.equal(analysis.totals.errors.total, 2);
  assert.equal(analysis.turns[0]!.status, "error");
  assert.equal(analysis.turns[0]!.steps[0]!.status, "error");
  assert.equal(analysis.turns[0]!.steps[1]!.status, "completed");
  const retry = analysis.events.find((event) => event.kind === "retry")!;
  assert.equal(retry.turnID, analysis.turns[0]!.id);
});

test("represents compaction as a distinct transaction with before/after context", async () => {
  const analysis = await analyze(compactionFixture(), "ses_compaction");
  assert.equal(analysis.compactions.length, 1);
  const tx = analysis.compactions[0]!;
  assert.equal(tx.turnID, null);
  assert.equal(tx.contextBefore.value, 8_000);
  assert.equal(tx.contextAfter.value, 2_500);
  assert.equal(tx.removedTokens.value, 5_500);
  assert.equal(tx.contextDelta.value, -5_500);
  assert.equal(tx.duration.basis, "unavailable");
  assert.equal(tx.summaryChars, 18);
  assert.equal(tx.tokens?.output, 400);
  assert.equal(analysis.totals.compactions, 1);
  assert.equal(analysis.totals.tokens.input, 11_000);
  assert.equal(analysis.totals.tokens.output, 550);
  assert.ok(analysis.unattachedEventIDs.includes(tx.eventID));
  assert.equal(analysis.turns[1]!.contextDelta.value, -1_500);
});

test("marks incomplete active sessions and leaves duration components unavailable", async () => {
  const analysis = await analyze(incompleteFixture(), "ses_incomplete");
  const turn = analysis.turns[0]!;
  const step = turn.steps[0]!;
  assert.equal(step.status, "incomplete");
  assert.equal(turn.status, "running");
  assert.equal(step.totalTime.value, 300);
  assert.match(step.totalTime.note ?? "", /incomplete step/);
  assert.equal(step.toolTime.value, null);
  assert.equal(step.residualTime.value, null);
  assert.equal(turn.totalTime.value, null);
  assert.match(turn.totalTime.note ?? "", /no completed step/);
  assert.equal(turn.residualTime.value, null);
  assert.match(turn.uncertainty.join(","), /no-idle-recorded/);
  assert.match(step.uncertainty.join(","), /tool-not-finished/);
});

test("keeps recorded order and propagates timestamp regressions", async () => {
  const analysis = await analyze(outOfOrderFixture(), "ses_out_of_order");
  assert.equal(analysis.events[0]!.kind, "user");
  assert.equal(analysis.events[1]!.kind, "assistant");
  assert.ok(analysis.events[1]!.uncertainty.includes("timestamp-regression"));
  assert.equal(analysis.turns[0]!.steps[0]!.totalTime.value, 600);
});

test("redacts secrets by default and preserves token counts", async () => {
  const data = secretsFixture();
  const service = new ObservabilityService(memorySource(data));
  const { analysis, redacted } = await service.analyze("ses_secrets");
  assert.equal(redacted, true);
  assert.match(JSON.stringify(analysis), /\[REDACTED/);
  assert.doesNotMatch(JSON.stringify(analysis), /sk-supersecretvalue12345/);
  assert.doesNotMatch(JSON.stringify(analysis), /ghp_abcdefghijklmnop/);
  assert.doesNotMatch(JSON.stringify(analysis), /hunter2/);
  assert.equal(analysis.turns[0]!.steps[0]!.tokens?.input, 100);

  const page = await service.events({
    sessionID: "ses_secrets",
    q: "sk-supersecretvalue12345",
  });
  assert.equal(page.events.length, 0, "redacted text is not searchable by secret");

  const detail = await service.eventDetail("ses_secrets", "msg_a1:0", {
    reveal: true,
  });
  assert.match(JSON.stringify(detail.payload), /sk-supersecretvalue12345/);
});

test("computes window totals when coverage is partial", async () => {
  const data = longFixture(20);
  const service = new ObservabilityService(memorySource(data));
  const { analysis } = await service.analyze("ses_long", {
    fromSeq: 10,
    toSeq: 40,
  });
  assert.equal(analysis.coverage.complete, false);
  assert.equal(analysis.totals.scope, "window");
  assert.ok(analysis.coverage.windowMessages < analysis.coverage.messages);
});

test("handles a session with no messages", async () => {
  const data = simpleFixture();
  data.sessions.push({ meta: { ...data.sessions[0]!.meta, id: "ses_empty" }, messages: [] });
  const analysis = await analyze(data, "ses_empty");
  assert.equal(analysis.turns.length, 0);
  assert.equal(analysis.totals.turns, 0);
  assert.equal(analysis.totals.steps, 0);
  assert.equal(analysis.totals.cost.basis, "unavailable");
  assert.equal(analysis.coverage.complete, true);
});
