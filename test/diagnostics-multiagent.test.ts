import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import { evaluateDiagnostics } from "../src/core/diagnostics.ts";
import {
  evaluateDelegationRecovery,
  isDelegationToolEvent,
} from "../src/core/delegation.ts";
import type {
  DelegationChildInput,
  DelegationRecoveryInput,
  FamilyDelegationRecovery,
} from "../src/core/delegation.ts";
import type { Analysis, NormalizedEvent, RawMessage } from "../src/core/types.ts";
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

type ChildKind = "failed" | "succeeded" | "failed-no-incidents";

function delegationCall(options: {
  callID: string;
  at: number;
  childID: string;
  input: unknown;
}): unknown {
  return toolBlock({
    callID: options.callID,
    name: "subagent",
    created: options.at,
    ran: options.at + 5,
    completed: options.at + 10,
    input: options.input,
    output: `<subagent sessionID="${options.childID}" state="completed">delegated</subagent>`,
  });
}

function parentMessages(delegations: unknown[]): RawMessage[] {
  return [
    user("msg_pu", 1, BASE),
    assistant({
      id: "msg_pa",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 400,
      completed: BASE + 5_000,
      content: delegations,
      tokens: { input: 500, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.004,
    }),
    idle("msg_pi", 3, BASE + 5_100, "succeeded"),
  ];
}

function failingChildMessages(): RawMessage[] {
  return [
    user("msg_cu", 1, BASE + 5_200),
    assistant({
      id: "msg_ca",
      seq: 2,
      created: BASE + 5_300,
      streamed: BASE + 5_500,
      completed: BASE + 5_600,
      content: [
        toolBlock({
          callID: "child_call_1",
          name: "read",
          created: BASE + 5_350,
          ran: BASE + 5_400,
          completed: BASE + 5_500,
          status: "error",
          input: { path: "src/missing.ts" },
          output: "",
          error: { type: "tool.read", message: "not found" },
        }),
      ],
      tokens: { input: 300, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.002,
    }),
    idle("msg_ci", 3, BASE + 5_700, "failed"),
  ];
}

function healthyChildMessages(outcome: "succeeded" | "failed"): RawMessage[] {
  return [
    user("msg_cu", 1, BASE + 5_200),
    assistant({
      id: "msg_ca",
      seq: 2,
      created: BASE + 5_300,
      streamed: BASE + 5_500,
      completed: BASE + 5_600,
      content: [textBlock("found 3 files")],
      tokens: { input: 300, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.002,
    }),
    idle("msg_ci", 3, BASE + 5_700, outcome),
  ];
}

function delegationFamily(
  delegations: unknown[],
  child: ChildKind = "failed",
): Fixture {
  const outcome = child === "succeeded" ? "succeeded" : "failed";
  const messages =
    child === "failed"
      ? failingChildMessages()
      : healthyChildMessages(child === "failed-no-incidents" ? "failed" : "succeeded");
  return fixture([
    {
      meta: session("ses_parent", {
        time: { created: BASE, updated: BASE + 6_000, busy: BASE, idle: BASE + 5_100 },
      }),
      messages: parentMessages(delegations),
    },
    {
      meta: session("ses_child", {
        parentID: "ses_parent",
        title: "Child session",
        agent: "explorer",
        outcome,
        time: {
          created: BASE + 5_200,
          updated: BASE + 5_800,
          busy: BASE + 5_200,
          idle: BASE + 5_700,
        },
      }),
      messages,
    },
  ]);
}

interface SessionView {
  analysis: Analysis;
  events: NormalizedEvent[];
  diagnostics: ReturnType<typeof evaluateDiagnostics>;
}

async function loadSession(
  data: Fixture,
  sessionID: string,
  options: { fromSeq?: number; windowed?: boolean } = {},
): Promise<SessionView> {
  const service = new ObservabilityService(memorySource(data));
  const result = await service.analyze(sessionID, { reveal: true, ...options });
  return {
    analysis: result.analysis,
    events: result.events,
    diagnostics: evaluateDiagnostics(result.events, result.analysis),
  };
}

async function recover(
  data: Fixture,
  options: { fromSeq?: number; windowed?: boolean } = {},
  overrides: Partial<DelegationRecoveryInput> = {},
): Promise<FamilyDelegationRecovery> {
  const parent = await loadSession(data, "ses_parent");
  const child = await loadSession(data, "ses_child", options);
  const children: DelegationChildInput[] = [
    {
      sessionID: "ses_child",
      events: child.events,
      analysis: child.analysis,
      diagnostics: child.diagnostics,
    },
  ];
  return evaluateDelegationRecovery({
    rootSessionID: "ses_parent",
    parentSessionID: "ses_parent",
    parentEvents: parent.events,
    parentAnalysis: parent.analysis,
    parentDiagnostics: parent.diagnostics,
    children,
    reveal: true,
    ...overrides,
  });
}

const ORIGINAL_INPUT = {
  agent: "explorer",
  description: "Find files",
  prompt: "Read the repo",
};

test("records the direct child delegation link from the parent tool event", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
  ]);

  const recovery = await recover(data);

  assert.equal(recovery.assessments.length, 1);
  const link = recovery.assessments[0]!.link;
  assert.equal(link.childSessionID, "ses_child");
  assert.equal(link.parentEventID, "msg_pa:0");
  assert.equal(link.parentTurnID, "ses_parent:t1");
  assert.equal(link.parentTurnIndex, 1);
  assert.equal(link.delegatedAgent, "explorer");
  assert.equal(link.anchorTimestamp, BASE + 200);
  assert.equal(link.inputComparability, "comparable");
  assert.equal(recovery.redacted, false);
  assert.equal(recovery.depth, 1);
  assert.equal(recovery.totalChildren, 1);
  assert.equal(recovery.childrenCapped, false);
});

test("measures child failure evidence from recorded diagnostics and outcomes", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
  ]);

  const recovery = await recover(data);
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.childFailed.hasFailureEvidence, true);
  assert.equal(assessment.childFailed.basis, "measured");
  assert.equal(assessment.childFailed.repeatedToolFailureIncidents, 1);
  assert.equal(assessment.childFailed.sessionOutcome, "failed");
  assert.equal(assessment.childFailed.failedOrInterruptedTurns, 1);
  assert.equal(assessment.childFailed.failedOrInterruptedIdles, 1);
  assert.ok(assessment.childDiagnosticsSummary !== null);
  assert.equal(assessment.childDiagnosticsSummary.incidents, 1);
});

test("labels a failed child with no later delegation as no parent reaction", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
  ]);

  const recovery = await recover(data);
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.pattern.kind, "child-failed-no-parent-reaction");
  assert.equal(assessment.parentReaction.kind, "none");
  assert.deepEqual(assessment.parentReaction.eventIDs, []);
  assert.deepEqual(assessment.parentReaction.agents, []);
  assert.equal(assessment.pattern.inputChangeProxy, false);
  assert.equal(recovery.patternCounts["child-failed-no-parent-reaction"], 1);
  assert.equal(recovery.basis, "derived");
});

test("detects an identical-input retry on the same agent", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
    delegationCall({
      callID: "call_2",
      at: BASE + 2_000,
      childID: "ses_other",
      // Same values, deliberately different key insertion order: canonical JSON
      // equality must not depend on recorded key order.
      input: { prompt: "Read the repo", description: "Find files", agent: "explorer" },
    }),
  ]);

  const recovery = await recover(data);
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.parentReaction.kind, "retry-same-agent");
  assert.equal(assessment.parentReaction.inputChangeBasis, "derived");
  assert.equal(assessment.parentReaction.inputChanged, false);
  assert.deepEqual(assessment.parentReaction.eventIDs, ["msg_pa:1"]);
  assert.deepEqual(assessment.parentReaction.agents, ["explorer"]);
  assert.equal(assessment.pattern.kind, "parent-retried-identical-delegation-input");
  assert.equal(assessment.pattern.inputChangeProxy, false);
});

test("detects a changed-input retry on the same agent as a proxy only", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
    delegationCall({
      callID: "call_2",
      at: BASE + 2_000,
      childID: "ses_other",
      input: { ...ORIGINAL_INPUT, prompt: "Read the repo more carefully" },
    }),
  ]);

  const recovery = await recover(data);
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.parentReaction.inputChanged, true);
  assert.equal(assessment.pattern.kind, "parent-retried-with-changed-delegation-input");
  assert.equal(assessment.pattern.inputChangeProxy, true);
});

test("detects a fallback to a different agent and lists the later delegation", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
    delegationCall({
      callID: "call_2",
      at: BASE + 2_000,
      childID: "ses_other",
      input: { agent: "oracle", description: "Review", prompt: "Review the patch" },
    }),
  ]);

  const recovery = await recover(data);
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.pattern.kind, "parent-fallback-to-other-agent");
  assert.equal(assessment.parentReaction.kind, "fallback-to-other-agent");
  assert.deepEqual(assessment.parentReaction.eventIDs, ["msg_pa:1"]);
  assert.deepEqual(assessment.parentReaction.agents, ["oracle"]);
  assert.equal(assessment.pattern.inputChangeProxy, false);
});

test("marks the reaction unclear when a later delegation stamps no agent", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
    delegationCall({
      callID: "call_2",
      at: BASE + 2_000,
      childID: "ses_other",
      input: { description: "Retry", prompt: "Read the repo" },
    }),
  ]);

  const recovery = await recover(data);
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.parentReaction.kind, "unclear");
  assert.deepEqual(assessment.parentReaction.eventIDs, ["msg_pa:1"]);
  assert.deepEqual(assessment.parentReaction.agents, []);
  assert.equal(assessment.pattern.kind, "parent-reaction-unclear");
  assert.ok(
    assessment.parentReaction.uncertainty.some((note) => note.includes("agent")),
  );
});

test("refuses a measured failure picture on a windowed child stream", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
  ]);

  const recovery = await recover(data, { fromSeq: 2, windowed: true });
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.childFailed.basis, "unavailable");
  assert.equal(assessment.pattern.kind, "insufficient-data");
  assert.equal(assessment.pattern.basis, "unavailable");
  assert.equal(recovery.basis, "unavailable");
});

test("counts a failed child outcome even without diagnostics incidents", async () => {
  const data = delegationFamily(
    [
      delegationCall({
        callID: "call_1",
        at: BASE + 200,
        childID: "ses_child",
        input: ORIGINAL_INPUT,
      }),
    ],
    "failed-no-incidents",
  );

  const recovery = await recover(data);
  const assessment = recovery.assessments[0]!;

  assert.equal(assessment.childFailed.repeatedToolFailureIncidents, 0);
  assert.equal(assessment.childFailed.sessionOutcome, "failed");
  assert.equal(assessment.childFailed.failedOrInterruptedIdles, 1);
  assert.equal(assessment.childFailed.hasFailureEvidence, true);
  assert.equal(assessment.childFailed.basis, "measured");
  assert.equal(assessment.pattern.kind, "child-failed-no-parent-reaction");
});

test("recognises delegation tool events without guessing", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
  ]);
  const parent = await loadSession(data, "ses_parent");

  const toolEvents = parent.events.filter((event) => event.kind === "tool");
  assert.equal(toolEvents.length, 1);
  assert.equal(isDelegationToolEvent(toolEvents[0]!), true);

  const userEvent = parent.events.find((event) => event.kind === "user");
  assert.ok(userEvent !== undefined);
  assert.equal(isDelegationToolEvent(userEvent), false);
});

const VALID_BASIS: ReadonlySet<string> = new Set([
  "measured",
  "derived",
  "estimated",
  "unavailable",
]);

function walkObjects(
  value: unknown,
  visit: (node: Record<string, unknown>) => void,
  seen: Set<object> = new Set<object>(),
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit, seen);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  visit(record);
  for (const item of Object.values(record)) walkObjects(item, visit, seen);
}

test("keeps every verdict-like field next to a valid basis and ranks nothing", async () => {
  const data = delegationFamily([
    delegationCall({
      callID: "call_1",
      at: BASE + 200,
      childID: "ses_child",
      input: ORIGINAL_INPUT,
    }),
    delegationCall({
      callID: "call_2",
      at: BASE + 2_000,
      childID: "ses_other",
      input: { ...ORIGINAL_INPUT, prompt: "Read the repo more carefully" },
    }),
  ]);

  const recovery = await recover(data);
  const root = recovery as unknown as Record<string, unknown>;

  walkObjects(recovery, (node) => {
    if (node === root) {
      // The family-level verdict carries its own epistemic cover.
      assert.equal(
        typeof node.basis,
        "string",
        "root recovery object without basis",
      );
    }
    const verdictLike =
      "kind" in node || "hasFailureEvidence" in node || "inputChanged" in node;
    if (verdictLike) {
      assert.equal(
        typeof node.basis,
        "string",
        `verdict-like object without basis: ${JSON.stringify(node)}`,
      );
      assert.ok(
        VALID_BASIS.has(node.basis as string),
        `invalid basis: ${String(node.basis)}`,
      );
    }
    if (node.inputChangeProxy === true) {
      assert.equal(node.kind, "parent-retried-with-changed-delegation-input");
    }
  });

  const text = JSON.stringify(recovery);
  assert.doesNotMatch(
    text,
    /winner|optimal|recommendation|verdict|better|adaptedPrompt|promptAdapt|promptImprovement/i,
  );
  assert.equal(recovery.patternCounts["parent-retried-with-changed-delegation-input"], 1);
});
