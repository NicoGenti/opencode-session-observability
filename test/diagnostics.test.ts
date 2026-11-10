import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import {
  evaluateDiagnostics,
  RepeatedToolFailureRule,
} from "../src/core/diagnostics.ts";
import type { Diagnostics } from "../src/core/diagnostics.ts";
import type { RawMessage } from "../src/core/types.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  memorySource,
  session,
  textBlock,
  toolBlock,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

let callCounter = 0;

function diagnosticsSession(messages: RawMessage[]): Fixture {
  return fixture([
    {
      meta: session("ses_diag", {
        time: {
          created: BASE,
          updated: BASE + 20_000,
          busy: BASE,
          idle: BASE + 19_000,
        },
      }),
      messages,
    },
  ]);
}

function assistantMessage(
  id: string,
  seq: number,
  created: number,
  content: unknown[],
): RawMessage {
  return assistant({
    id,
    seq,
    created,
    streamed: created + 400,
    completed: created + 500,
    content,
  });
}

function call(
  name: string,
  input: unknown,
  options: {
    at: number;
    status?: "completed" | "error";
    error?: Record<string, unknown>;
  },
): unknown {
  callCounter += 1;
  return toolBlock({
    callID: `call_${callCounter}`,
    name,
    created: options.at,
    ran: options.at + 5,
    completed: options.at + 10,
    status: options.status ?? "completed",
    input,
    output: options.status === "error" ? "" : "ok",
    error: options.error,
  });
}

/**
 * A failing tool call whose recorded payload never captured an input.
 * `toolBlock` defaults the input to `{}`, so the key is removed here to model
 * an absent payload without touching the shared fixture builder.
 */
function callWithoutInput(name: string, options: { at: number }): unknown {
  callCounter += 1;
  const block = toolBlock({
    callID: `call_${callCounter}`,
    name,
    created: options.at,
    ran: options.at + 5,
    completed: options.at + 10,
    status: "error",
    output: "",
  }) as Record<string, unknown>;
  const state = block.state as Record<string, unknown>;
  delete state.input;
  return block;
}

async function evaluate(data: Fixture, reveal = true): Promise<Diagnostics> {
  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", { reveal });
  return evaluateDiagnostics(events, analysis);
}

test("marks two failures followed by an identical same-tool success as recovered", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 400 }),
    ]),
    idle("i1", 3, BASE + 600, "succeeded"),
  ]);

  const result = await evaluate(data);
  assert.equal(result.incidents.length, 1);
  const incident = result.incidents[0]!;
  assert.equal(incident.tool, "read");
  assert.equal(incident.turn, 1);
  assert.equal(incident.turnID, "ses_diag:t1");
  assert.equal(incident.attempts, 2);
  assert.deepEqual(incident.failureEventIDs, ["a1:0", "a1:1"]);
  assert.equal(incident.recoveryEventID, "a1:2");
  assert.equal(incident.recovery, "recovered");
  assert.equal(incident.similarity, "identical");
  assert.equal(incident.inputsCompared, true);
  assert.equal(incident.inputsComparable, true);
  assert.equal(incident.basis, "derived");
  assert.equal(incident.failureBasis, "measured");
  assert.deepEqual(incident.inputKeyShape, ["path"]);
  assert.equal(result.summary.recovered, 1);
  assert.equal(result.summary.turnsWithIncidents, 1);
});

test("marks a same-tool success with a related key shape as recovered", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "read",
        { path: "src/a.ts", limit: 10 },
        { at: BASE + 200, status: "error" },
      ),
      call(
        "read",
        { limit: 20, path: "src/b.ts" },
        { at: BASE + 300 },
      ),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "recovered");
  assert.equal(incident.similarity, "related");
  assert.match(incident.why, /key-shape overlap/);
});

test("marks a different successful tool later in the turn as possible recovery", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
    ]),
    assistantMessage("a2", 3, BASE + 400, [
      call("grep", { pattern: "a" }, { at: BASE + 500 }),
    ]),
    idle("i1", 4, BASE + 700, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "possible-recovery");
  assert.equal(incident.similarity, "unknown");
  assert.deepEqual(incident.failureEventIDs, ["a1:0"]);
  // A recovery signalled by another tool is not a same-tool success id.
  assert.equal(incident.recoveryEventID, null);
  assert.equal(incident.inputsCompared, false);
  assert.equal(incident.inputsComparable, true);
  assert.match(incident.why, /grep/);
  assert.equal(result.summary.possibleRecovery, 1);
});

test("marks a failure with no later success or step as no-recovery-evidence", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      textBlock("could not read the file"),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "no-recovery-evidence");
  assert.equal(incident.attempts, 1);
  assert.deepEqual(incident.failureEventIDs, ["a1:0"]);
  assert.equal(incident.recoveryEventID, null);
  assert.match(incident.why, /no same-tool success/);
  assert.equal(result.summary.noRecoveryEvidence, 1);
});

test("returns insufficient-data when the failure input is truncated", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "read",
        { path: "src/index.ts…" },
        { at: BASE + 200, status: "error" },
      ),
      call("read", { path: "src/index.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "insufficient-data");
  assert.equal(incident.inputsComparable, false);
  assert.equal(incident.inputsCompared, false);
  assert.equal(incident.similarity, "unknown");
  assert.equal(incident.inputKeyShape, null);
  assert.deepEqual(incident.failureEventIDs, ["a1:0"]);
  assert.equal(incident.recoveryEventID, null);
  assert.match(incident.why, /truncation marker/);
  assert.equal(result.summary.insufficientData, 1);
});

test("returns insufficient-data when redaction removes the failure input", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "shell",
        { command: "cat", api_key: "sk-abcdefghijklmnopqrstuvwxyz" },
        { at: BASE + 200, status: "error" },
      ),
      call("shell", { command: "cat" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  // Default analyze() output is redacted, so the recorded input carries the
  // redaction sentinel and can no longer be compared.
  const result = await evaluate(data, false);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "insufficient-data");
  assert.equal(incident.inputsComparable, false);
  assert.match(incident.why, /redaction sentinel/);
});

test("tracks independent tool runs in one turn without cross-contamination", async () => {
  const syntheticError = {
    type: "synthetic.injected",
    message: "injected failure",
  };
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call(
        "grep",
        { pattern: "a" },
        { at: BASE + 300, status: "error", error: syntheticError },
      ),
      call("read", { path: "src/a.ts" }, { at: BASE + 400, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 500 }),
      call(
        "grep",
        { pattern: "a" },
        { at: BASE + 600, status: "error", error: syntheticError },
      ),
    ]),
    idle("i1", 3, BASE + 800, "succeeded"),
  ]);

  const result = await evaluate(data);
  assert.equal(result.incidents.length, 2);

  const read = result.incidents.find((incident) => incident.tool === "read")!;
  const grep = result.incidents.find((incident) => incident.tool === "grep")!;

  // The grep failure between the two read failures must not break read's run.
  assert.equal(read.attempts, 2);
  assert.deepEqual(read.failureEventIDs, ["a1:0", "a1:2"]);
  assert.equal(read.recoveryEventID, "a1:3");
  assert.equal(read.recovery, "recovered");
  assert.equal(read.similarity, "identical");

  // grep has no success after its last failure, so read's recovery cannot leak.
  assert.equal(grep.attempts, 2);
  assert.deepEqual(grep.failureEventIDs, ["a1:1", "a1:4"]);
  assert.equal(grep.recoveryEventID, null);
  assert.equal(grep.recovery, "no-recovery-evidence");
  assert.notEqual(grep.recovery, "recovered");

  assert.equal(result.summary.incidents, 2);
  assert.equal(result.summary.recovered, 1);
  assert.equal(result.summary.noRecoveryEvidence, 1);
  assert.equal(result.summary.turnsWithIncidents, 1);
});

test("marks a subsequent assistant step without a matching success as possible recovery", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
    ]),
    assistantMessage("a2", 3, BASE + 400, [
      textBlock("Trying a different approach."),
    ]),
    idle("i1", 4, BASE + 600, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "possible-recovery");
  assert.match(incident.why, /subsequent assistant step/);
});

test("does not claim recovery when the later same-tool call has a different input shape", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { file: "src/a.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.similarity, "different");
  assert.equal(incident.recovery, "possible-recovery");
  assert.equal(incident.inputsCompared, true);
  // A different-shape success is compared but does not recover the run, so it
  // is not recorded as the recovery event.
  assert.equal(incident.recoveryEventID, null);
  // The why must describe the same-tool success it actually saw, not deny it.
  assert.match(
    incident.why,
    /a later read call succeeded but with a different input shape/,
  );
  assert.match(incident.why, /key-shape overlap 0\.00 < 0\.50/);
  assert.doesNotMatch(incident.why, /no matching/);
});

test("does not recover an earlier turn from a same-tool success in a later turn", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
    ]),
    idle("i1", 3, BASE + 400, "succeeded"),
    user("u2", 4, BASE + 500),
    assistantMessage("a2", 5, BASE + 600, [
      call("read", { path: "src/a.ts" }, { at: BASE + 700 }),
    ]),
    idle("i2", 6, BASE + 900, "succeeded"),
  ]);

  const result = await evaluate(data);
  assert.equal(result.incidents.length, 1);
  const incident = result.incidents[0]!;
  assert.equal(incident.turn, 1);
  assert.equal(incident.turnID, "ses_diag:t1");
  // A success after the turn boundary cannot close or recover the run.
  assert.notEqual(incident.recovery, "recovered");
  assert.equal(incident.recovery, "no-recovery-evidence");
  assert.equal(incident.inputsCompared, false);
  assert.match(incident.why, /no same-tool success/);
});

test("returns insufficient-data when the failure input is absent", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      callWithoutInput("read", { at: BASE + 200 }),
    ]),
    idle("i1", 3, BASE + 400, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "insufficient-data");
  assert.equal(incident.inputsComparable, false);
  assert.equal(incident.inputsCompared, false);
  assert.equal(incident.similarity, "unknown");
  assert.equal(incident.inputKeyShape, null);
  assert.match(incident.why, /failure input is absent/);
  assert.equal(result.summary.insufficientData, 1);
});

test("returns insufficient-data when the matching success input is truncated", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts…" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "insufficient-data");
  assert.equal(incident.inputsComparable, false);
  assert.equal(incident.inputsCompared, false);
  assert.equal(incident.similarity, "unknown");
  assert.equal(incident.inputKeyShape, null);
  // The comparable failure input is not the blocker: the success input is.
  assert.match(
    incident.why,
    /the matching success input contains a truncation marker/,
  );
  assert.equal(result.summary.insufficientData, 1);
});

test("keeps a mid-string ellipsis inside a grep pattern comparable", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "grep",
        { pattern: "alpha…omega" },
        { at: BASE + 200, status: "error" },
      ),
      call("grep", { pattern: "alpha.omega" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  // `…` in the middle of a legitimate pattern is not a truncation marker.
  assert.equal(incident.inputsComparable, true);
  assert.notEqual(incident.recovery, "insufficient-data");
  assert.equal(incident.recovery, "recovered");
  assert.equal(incident.similarity, "related");
  assert.equal(result.summary.insufficientData, 0);
});

test("keeps write content with a mid-string truncation marker comparable", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "write",
        { path: "notes.md", content: "keep [truncated] in the middle" },
        { at: BASE + 200, status: "error" },
      ),
      call("write", { path: "notes.md", content: "done" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  // `[truncated]` only matters when it terminates the recorded string.
  assert.equal(incident.inputsComparable, true);
  assert.notEqual(incident.recovery, "insufficient-data");
  assert.equal(incident.recovery, "recovered");
  assert.equal(result.summary.insufficientData, 0);
});

test("still returns insufficient-data for an end-of-string truncation marker", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "grep",
        { pattern: "needle…" },
        { at: BASE + 200, status: "error" },
      ),
      call("grep", { pattern: "needle" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  assert.equal(incident.recovery, "insufficient-data");
  assert.equal(incident.inputsComparable, false);
  assert.match(incident.why, /truncation marker/);
  assert.equal(result.summary.insufficientData, 1);
});

test("counts a tool event missing from the turn map without an incident", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
    ]),
    idle("i1", 3, BASE + 400, "succeeded"),
  ]);

  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", { reveal: true });
  const toolEvent = events.find((event) => event.kind === "tool")!;
  // Models a windowed/page-subset turn map: the event is recorded, but no turn
  // in the supplied analysis owns it.
  const partialAnalysis = {
    ...analysis,
    turns: analysis.turns.map((turn) => ({
      ...turn,
      eventIDs: turn.eventIDs.filter((id) => id !== toolEvent.id),
    })),
  };

  const result = evaluateDiagnostics(events, partialAnalysis);
  assert.equal(result.summary.excludedTurnlessToolEvents, 1);
  assert.equal(result.incidents.length, 0);
  assert.equal(result.summary.incidents, 0);
});

test("reports no excluded turnless tool events for a fully mapped input", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  assert.equal(result.summary.excludedTurnlessToolEvents, 0);
});

test("keeps a cyclic recorded input in the unserializable fallback", async () => {
  const cyclic: Record<string, unknown> = { path: "src/a.ts" };
  cyclic.self = cyclic;
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", cyclic, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", { reveal: true });
  let result: Diagnostics | undefined;
  // canonicalJson() lands in the `unserializable:` fallback for the cyclic
  // failure input; no RangeError may escape the engine.
  assert.doesNotThrow(() => {
    result = evaluateDiagnostics(events, analysis);
  });
  assert.ok(result);
  const incident = result.incidents[0]!;
  assert.equal(incident.inputsCompared, true);
  assert.equal(incident.inputsComparable, true);
  assert.equal(incident.similarity, "related");
  assert.match(incident.why, /key-shape overlap 0\.50/);
});

test("is pure: repeated evaluation is deep-equal and does not mutate inputs", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "read",
        { path: "src/a.ts", limit: 10 },
        { at: BASE + 200, status: "error" },
      ),
      call("read", { path: "src/a.ts" }, { at: BASE + 300, status: "error" }),
      call(
        "read",
        { path: "src/b.ts", limit: 20 },
        { at: BASE + 400 },
      ),
    ]),
    idle("i1", 3, BASE + 600, "succeeded"),
  ]);

  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", { reveal: true });
  const analysisBefore = structuredClone(analysis);
  const eventsBefore = structuredClone(events);

  const first = evaluateDiagnostics(events, analysis);
  const second = evaluateDiagnostics(events, analysis);

  assert.deepEqual(first, second);
  assert.deepEqual(events, eventsBefore);
  assert.deepEqual(analysis, analysisBefore);
});

test("returns an empty incident list when no tool failed", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [textBlock("all good")]),
    idle("i1", 3, BASE + 300, "succeeded"),
  ]);

  const result = await evaluate(data);
  assert.deepEqual(result.incidents, []);
  assert.equal(result.summary.incidents, 0);
  assert.equal(result.summary.turnsWithIncidents, 0);
});

test("RepeatedToolFailureRule returns the same incidents as the primary entry", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", { reveal: true });
  const direct = RepeatedToolFailureRule(events, analysis);
  const wrapped = evaluateDiagnostics(events, analysis);
  assert.deepEqual(direct.incidents, wrapped.incidents);
});

test("pins a two-of-three key-shape overlap as related", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call(
        "read",
        { path: "src/a.ts", limit: 10, offset: 20 },
        { at: BASE + 200, status: "error" },
      ),
      call("read", { path: "src/b.ts", offset: 5 }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  // Key shapes {path,limit,offset} vs {path,offset}: 2 of 3 -> 0.67.
  assert.equal(incident.recovery, "recovered");
  assert.equal(incident.similarity, "related");
  assert.match(incident.why, /key-shape overlap 0\.67 >= 0\.50/);
});

test("pins the inclusive 0.50 key-shape boundary as related", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/b.ts", limit: 10 }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const result = await evaluate(data);
  const incident = result.incidents[0]!;
  // {path} vs {path,limit}: 1 of 2 -> exactly 0.50, which still counts as related.
  assert.equal(incident.recovery, "recovered");
  assert.equal(incident.similarity, "related");
  assert.match(incident.why, /key-shape overlap 0\.50 >= 0\.50/);
});

test("reports two incidents when a success separates two read failures", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300 }),
      call("read", { path: "src/a.ts" }, { at: BASE + 400, status: "error" }),
    ]),
    idle("i1", 3, BASE + 600, "succeeded"),
  ]);

  const result = await evaluate(data);
  assert.equal(result.incidents.length, 2);

  const [recovered, failed] = result.incidents;
  // The success closes the first maximal run (one failure) with identical input.
  assert.equal(recovered!.attempts, 1);
  assert.deepEqual(recovered!.failureEventIDs, ["a1:0"]);
  assert.equal(recovered!.recoveryEventID, "a1:1");
  assert.equal(recovered!.recovery, "recovered");
  assert.equal(recovered!.similarity, "identical");
  // The later failure opens a fresh run that the turn end closes without evidence.
  assert.equal(failed!.attempts, 1);
  assert.deepEqual(failed!.failureEventIDs, ["a1:2"]);
  assert.equal(failed!.recoveryEventID, null);
  assert.equal(failed!.recovery, "no-recovery-evidence");
  assert.equal(result.summary.recovered, 1);
  assert.equal(result.summary.noRecoveryEvidence, 1);
});
