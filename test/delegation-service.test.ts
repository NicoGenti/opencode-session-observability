import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  memorySource,
  session,
  toolBlock,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";
import type {
  ObservabilitySource,
  RawMessage,
  SessionSummary,
} from "../src/core/types.ts";

const ORIGINAL_INPUT = {
  agent: "explorer",
  description: "Find files",
  prompt: "Read the repo",
};

/** The bearer token is rewritten by `redactValue`, so the input is `"redacted"` only in no-reveal mode. */
const SECRET_INPUT = {
  agent: "explorer",
  description: "Find files",
  prompt:
    "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.test",
};

interface DelegationSpec {
  callID: string;
  at: number;
  childID: string;
  input: unknown;
}

interface ChildSpec {
  id: string;
  created: number;
}

function delegationBlock(spec: DelegationSpec): unknown {
  return toolBlock({
    callID: spec.callID,
    name: "subagent",
    created: spec.at,
    ran: spec.at + 5,
    completed: spec.at + 10,
    input: spec.input,
    output: `<subagent sessionID="${spec.childID}" state="completed">delegated</subagent>`,
  });
}

function parentMessages(delegations: DelegationSpec[]): RawMessage[] {
  const last = delegations.reduce((max, spec) => Math.max(max, spec.at), BASE);
  return [
    user("msg_pu", 1, BASE),
    assistant({
      id: "msg_pa",
      seq: 2,
      created: BASE + 50,
      streamed: last + 50,
      completed: last + 100,
      content: delegations.map(delegationBlock),
      tokens: { input: 500, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.004,
    }),
    idle("msg_pi", 3, last + 200, "succeeded"),
  ];
}

function failingChildMessages(id: string, created: number): RawMessage[] {
  return [
    user(`${id}_u`, 1, created),
    assistant({
      id: `${id}_a`,
      seq: 2,
      created: created + 10,
      streamed: created + 20,
      completed: created + 30,
      content: [
        toolBlock({
          callID: `${id}_call`,
          name: "read",
          created: created + 12,
          ran: created + 15,
          completed: created + 18,
          status: "error",
          input: { path: "src/missing.ts" },
          output: "",
          error: { type: "tool.read", message: "not found" },
        }),
      ],
      tokens: { input: 300, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.002,
    }),
    idle(`${id}_i`, 3, created + 40, "failed"),
  ];
}

function childEntry(spec: ChildSpec): { meta: ReturnType<typeof session>; messages: RawMessage[] } {
  return {
    meta: session(spec.id, {
      parentID: "ses_parent",
      title: `Child ${spec.id}`,
      agent: "explorer",
      outcome: "failed",
      time: {
        created: spec.created,
        updated: spec.created + 100,
        busy: spec.created,
        idle: spec.created + 40,
      },
    }),
    messages: failingChildMessages(spec.id, spec.created),
  };
}

function familyFixture(
  children: ChildSpec[],
  options: { input?: unknown } = {},
): Fixture {
  const input = options.input ?? ORIGINAL_INPUT;
  const delegations: DelegationSpec[] = children.map((child, index) => ({
    callID: `call_${index + 1}`,
    at: BASE + 100 + index * 10,
    childID: child.id,
    input,
  }));
  const last = delegations.length > 0 ? delegations[delegations.length - 1]!.at : BASE;
  return fixture([
    {
      meta: session("ses_parent", {
        time: {
          created: BASE,
          updated: last + 500,
          busy: BASE,
          idle: last + 400,
        },
      }),
      messages: parentMessages(delegations),
    },
    ...children.map(childEntry),
  ]);
}

/** Same source, but one extra child the source advertises yet cannot load. */
function sourceWithExtraChild(
  data: Fixture,
  extra: SessionSummary,
): ObservabilitySource {
  const inner = memorySource(data);
  return {
    kind: inner.kind,
    listSessions: (options) => inner.listSessions(options),
    getSession: (sessionID) => inner.getSession(sessionID),
    getFamily: async (sessionID) => {
      const family = await inner.getFamily(sessionID);
      if (sessionID !== "ses_parent") return family;
      return { ...family, children: [...family.children, extra] };
    },
    listMessages: (sessionID, options) =>
      inner.listMessages(sessionID, options),
    messageBounds: (sessionID) => inner.messageBounds(sessionID),
  };
}

test("familyRecovery classifies a failed child through the service", async () => {
  const service = new ObservabilityService(
    memorySource(familyFixture([{ id: "ses_child", created: BASE + 1_000 }])),
  );

  const recovery = await service.familyRecovery("ses_parent");

  assert.equal(recovery.schemaVersion, 1);
  assert.equal(recovery.rootSessionID, "ses_parent");
  assert.equal(recovery.depth, 1);
  assert.equal(recovery.redacted, true);
  assert.equal(recovery.totalChildren, 1);
  assert.equal(recovery.childrenCapped, false);
  assert.equal(recovery.basis, "derived");
  assert.equal(recovery.assessments.length, 1);

  const assessment = recovery.assessments[0]!;
  assert.equal(assessment.link.childSessionID, "ses_child");
  assert.equal(assessment.link.parentEventID, "msg_pa:0");
  assert.equal(assessment.link.parentTurnID, "ses_parent:t1");
  assert.equal(assessment.link.parentTurnIndex, 1);
  assert.equal(assessment.link.delegatedAgent, "explorer");
  assert.equal(assessment.link.inputComparability, "comparable");
  assert.equal(assessment.childFailed.hasFailureEvidence, true);
  assert.equal(assessment.childFailed.basis, "measured");
  assert.equal(assessment.childFailed.repeatedToolFailureIncidents, 1);
  assert.equal(assessment.childDiagnosticsSummary?.incidents, 1);
  assert.equal(assessment.pattern.kind, "child-failed-no-parent-reaction");
  assert.equal(assessment.pattern.basis, "derived");
  assert.equal(assessment.pattern.inputChangeProxy, false);

  const counts = recovery.patternCounts;
  assert.deepEqual(Object.keys(counts).sort(), [
    "child-failed-no-parent-reaction",
    "insufficient-data",
    "no-child-failure",
    "parent-fallback-to-other-agent",
    "parent-reaction-unclear",
    "parent-retried-identical-delegation-input",
    "parent-retried-same-agent",
    "parent-retried-with-changed-delegation-input",
  ]);
  assert.equal(counts["child-failed-no-parent-reaction"], 1);
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    recovery.assessments.length,
  );
});

test("familyRecovery caps at 8 assessments ordered by timeCreated then id", async () => {
  const children: ChildSpec[] = [
    { id: "ses_kid0", created: BASE + 100 },
    { id: "ses_kid1", created: BASE + 50 },
    { id: "ses_kid2", created: BASE + 50 },
    { id: "ses_kid3", created: BASE + 10 },
    { id: "ses_kid4", created: BASE + 40 },
    { id: "ses_kid5", created: BASE + 30 },
    { id: "ses_kid6", created: BASE + 60 },
    { id: "ses_kid7", created: BASE + 70 },
    { id: "ses_kid8", created: BASE + 80 },
    { id: "ses_kid9", created: BASE + 90 },
  ];
  const service = new ObservabilityService(memorySource(familyFixture(children)));

  const recovery = await service.familyRecovery("ses_parent");

  assert.equal(recovery.totalChildren, 10);
  assert.equal(recovery.childrenCapped, true);
  assert.equal(recovery.assessments.length, 8);
  assert.deepEqual(
    recovery.assessments.map((assessment) => assessment.link.childSessionID),
    [
      "ses_kid3",
      "ses_kid5",
      "ses_kid4",
      "ses_kid1",
      "ses_kid2",
      "ses_kid6",
      "ses_kid7",
      "ses_kid8",
    ],
  );
  assert.ok(recovery.notes.includes("2 children not assessed (cap 8)"));
  assert.equal(
    Object.values(recovery.patternCounts).reduce((sum, value) => sum + value, 0),
    8,
  );
});

test("familyRecovery reports a childless family as unavailable", async () => {
  const service = new ObservabilityService(memorySource(familyFixture([])));

  const recovery = await service.familyRecovery("ses_parent");

  assert.equal(recovery.totalChildren, 0);
  assert.deepEqual(recovery.assessments, []);
  assert.equal(recovery.childrenCapped, false);
  assert.equal(recovery.basis, "unavailable");
  assert.deepEqual(recovery.notes, []);
});

test("familyRecovery records a cycle note and never assesses the root twice", async () => {
  const data = fixture([
    {
      meta: session("ses_parent", {
        parentID: "ses_parent",
        time: { created: BASE, updated: BASE + 1_000, busy: BASE, idle: BASE + 900 },
      }),
      messages: [
        user("msg_u", 1, BASE),
        assistant({
          id: "msg_a",
          seq: 2,
          created: BASE + 100,
          streamed: BASE + 400,
          completed: BASE + 500,
          content: [{ type: "text", text: "done" }],
        }),
        idle("msg_i", 3, BASE + 600, "succeeded"),
      ],
    },
  ]);
  const service = new ObservabilityService(memorySource(data));

  const recovery = await service.familyRecovery("ses_parent");

  assert.equal(recovery.totalChildren, 1);
  assert.equal(recovery.assessments.length, 0);
  assert.ok(recovery.notes.includes("cycle detected: ses_parent"));
  assert.equal(
    Object.values(recovery.patternCounts).reduce((sum, value) => sum + value, 0),
    0,
  );
  assert.equal(recovery.basis, "unavailable");
});

test("familyRecovery mirrors diagnostics redaction while keeping event ids", async () => {
  const service = new ObservabilityService(
    memorySource(
      familyFixture([{ id: "ses_child", created: BASE + 1_000 }], {
        input: SECRET_INPUT,
      }),
    ),
  );

  const hidden = await service.familyRecovery("ses_parent");
  assert.equal(hidden.redacted, true);
  const hiddenAssessment = hidden.assessments[0]!;
  assert.equal(hiddenAssessment.link.inputComparability, "redacted");
  assert.equal(hiddenAssessment.pattern.kind, "child-failed-no-parent-reaction");

  // The cached dataset is raw: flipping reveal on a warm cache is still correct.
  const revealed = await service.familyRecovery("ses_parent", { reveal: true });
  assert.equal(revealed.redacted, false);
  const revealedAssessment = revealed.assessments[0]!;
  assert.equal(revealedAssessment.link.inputComparability, "comparable");
  assert.equal(revealedAssessment.link.parentEventID, hiddenAssessment.link.parentEventID);
  assert.equal(revealedAssessment.link.parentTurnID, hiddenAssessment.link.parentTurnID);
  assert.deepEqual(
    revealedAssessment.parentReaction.eventIDs,
    hiddenAssessment.parentReaction.eventIDs,
  );
  assert.equal(service.describe().cacheEntries, 2);

  const serialized = JSON.stringify(hidden);
  assert.equal(serialized.includes("abcdefghijklmnop"), false);
  assert.equal(serialized.includes("Bearer"), false);
});

test("familyRecovery degrades an unloadable child to insufficient-data", async () => {
  const data = familyFixture([{ id: "ses_child", created: BASE + 1_000 }]);
  const ghost: SessionSummary = {
    id: "ses_ghost",
    parentID: "ses_parent",
    title: "Ghost child",
    timeCreated: BASE + 900,
  };
  const service = new ObservabilityService(sourceWithExtraChild(data, ghost));

  const recovery = await service.familyRecovery("ses_parent");

  assert.equal(recovery.totalChildren, 2);
  assert.equal(recovery.childrenCapped, false);
  assert.deepEqual(
    recovery.assessments.map((assessment) => assessment.link.childSessionID),
    ["ses_ghost", "ses_child"],
  );

  const ghostAssessment = recovery.assessments[0]!;
  assert.equal(ghostAssessment.pattern.kind, "insufficient-data");
  assert.equal(ghostAssessment.pattern.basis, "unavailable");
  assert.equal(ghostAssessment.pattern.inputChangeProxy, false);
  assert.equal(ghostAssessment.childFailed.basis, "unavailable");
  assert.equal(ghostAssessment.childFailed.hasFailureEvidence, false);
  assert.equal(ghostAssessment.childDiagnosticsSummary?.incidents, 0);
  assert.equal(ghostAssessment.link.parentEventID, null);
  assert.equal(ghostAssessment.link.inputComparability, "absent");

  const loaded = recovery.assessments[1]!;
  assert.equal(loaded.pattern.kind, "child-failed-no-parent-reaction");
  assert.equal(loaded.childFailed.basis, "measured");

  assert.ok(recovery.notes.includes("child ses_ghost: child load unavailable"));
  const serialized = JSON.stringify(recovery);
  assert.equal(serialized.includes("Session not found"), false);
  assert.doesNotMatch(serialized, /at .*\.ts:\d+:\d+/);
});
