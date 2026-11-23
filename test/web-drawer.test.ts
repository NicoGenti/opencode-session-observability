import test from "node:test";
import assert from "node:assert/strict";
import type {
  CompactionTransaction,
  NormalizedEvent,
  ToolCallDetail,
  TokenUsage,
} from "../src/core/types.ts";
import {
  COMPACTION_NOTE,
  DRAWER_IDENTITY_LABELS,
  NOT_RECORDED_LABEL,
  PAYLOAD_SUMMARY,
  compactionFacts,
  compactionForEvent,
  drawerHeader,
  drawerMeta,
  drawerSections,
  payloadText,
  toolBox,
} from "../src/web/lib/drawer.ts";

const TOKENS: TokenUsage = {
  input: 10,
  output: 5,
  reasoning: 1,
  cacheRead: 2,
  cacheWrite: 3,
};

function tool(overrides: Partial<ToolCallDetail> = {}): ToolCallDetail {
  return {
    callID: "call-1",
    name: "bash",
    status: "completed",
    input: { command: "ls -la" },
    inputPreview: "ls -la",
    output: "file.txt",
    outputPreview: "file.txt",
    error: null,
    metadata: null,
    createdAt: 1_700_000_000_000,
    ranAt: 1_700_000_000_500,
    completedAt: 1_700_000_001_000,
    duration: { value: 500, basis: "derived" },
    childSessionIDs: [],
    executed: true,
    ...overrides,
  };
}

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "evt-1",
    messageID: "msg-1",
    sessionID: "sess-1",
    seq: 7,
    order: 2,
    orderKey: "000007:2",
    timestamp: 1_700_000_000_000,
    endTimestamp: 1_700_000_002_000,
    kind: "tool",
    actor: "tool",
    title: "Read the file",
    text: "hello",
    textPreview: "hello",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5", variant: "mini" },
    provider: "openai",
    status: "completed",
    tool: tool(),
    tokens: TOKENS,
    cost: 0.25,
    stepID: "step-1",
    turnID: "turn-1",
    flags: {
      error: false,
      retry: false,
      compaction: false,
      context: false,
      subagent: false,
      approval: false,
      uncertain: false,
    },
    uncertainty: ["start approximated"],
    payload: { raw: true },
    ...overrides,
  };
}

function compaction(overrides: Partial<CompactionTransaction> = {}): CompactionTransaction {
  return {
    eventID: "evt-compaction",
    turnID: "turn-1",
    timestamp: 1_700_000_000_000,
    status: "completed",
    reason: "context window",
    model: null,
    provider: null,
    tokens: TOKENS,
    cost: 0.25,
    summaryChars: 1_234,
    summaryPreview: "summary",
    contextBefore: { value: 1_000, basis: "measured" },
    contextAfter: { value: 400, basis: "measured" },
    contextDelta: { value: -600, basis: "derived" },
    removedTokens: { value: null, basis: "unavailable" },
    duration: { value: 1_500, basis: "derived" },
    uncertainty: [],
    ...overrides,
  };
}

/* --------------------------------------------------------------- field gating */

test("drawer: the six identity fields always render, in legacy order", () => {
  const bare = event({
    text: null,
    tool: null,
    tokens: null,
    cost: null,
    agent: null,
    model: null,
    provider: null,
    status: null,
    endTimestamp: null,
    stepID: null,
    turnID: null,
    uncertainty: [],
  });
  const meta = drawerMeta(bare);
  assert.deepEqual(
    meta.present.map((field) => field.label),
    [...DRAWER_IDENTITY_LABELS],
  );
  assert.deepEqual(meta.missing, [
    "Step",
    "Agent",
    "Model",
    "Provider",
    "Status",
    "End",
    "Duration",
    "Tokens",
    "Cost",
    "Uncertainty",
  ]);
  assert.equal(meta.missingSummary, `${NOT_RECORDED_LABEL} (10)`);
  // Turn falls back to "unattached" and still renders.
  assert.equal(meta.present[4].value, "unattached");
  // Seq / order pairs the numbers verbatim.
  assert.equal(meta.present[3].value, "7 / 2");
});

test("drawer: every recorded field renders and no disclosure appears", () => {
  const meta = drawerMeta(event());
  assert.deepEqual(
    meta.present.map((field) => field.label),
    [
      "Event ID",
      "Message ID",
      "Session",
      "Seq / order",
      "Turn",
      "Timestamp",
      "Step",
      "Agent",
      "Model",
      "Provider",
      "Status",
      "End",
      "Duration",
      "Tokens",
      "Cost",
      "Uncertainty",
    ],
  );
  assert.deepEqual(meta.missing, []);
  assert.equal(meta.missingSummary, null);
  const values = new Map(meta.present.map((field) => [field.label, field.value]));
  assert.equal(values.get("Model"), "openai/gpt-5#mini");
  assert.equal(values.get("End"), new Date(1_700_000_002_000).toISOString());
  assert.equal(values.get("Duration"), "2.00 s");
  assert.equal(values.get("Tokens"), JSON.stringify(TOKENS));
  assert.equal(values.get("Cost"), "$0.2500");
  assert.equal(values.get("Uncertainty"), "start approximated");
});

test("drawer: an em-dash placeholder counts as not recorded", () => {
  const meta = drawerMeta(event({ status: "—", agent: "   " }));
  assert.equal(meta.present.some((field) => field.label === "Status"), false);
  assert.equal(meta.present.some((field) => field.label === "Agent"), false);
  assert.equal(meta.missingSummary?.startsWith(`${NOT_RECORDED_LABEL} (`), true);
});

/* ----------------------------------------------------------------- sections */

test("drawer: sections follow reading order and only populated ones render", () => {
  assert.deepEqual(
    drawerSections(event(), null).map((section) => section.id),
    ["event", "text", "tool", "payload"],
  );
  assert.deepEqual(
    drawerSections(event(), compaction()).map((section) => section.id),
    ["event", "text", "tool", "compaction", "payload"],
  );
  assert.deepEqual(
    drawerSections(event({ text: null, tool: null }), null).map((section) => section.id),
    ["event", "payload"],
  );
  assert.deepEqual(
    drawerSections(event({ text: "" }), null).map((section) => section.id),
    ["event", "tool", "payload"],
  );
  assert.deepEqual(
    drawerSections(event(), null).map((section) => section.title),
    ["Event", "Text", "Tool call", "Payload"],
  );
});

test("drawer: the compaction section is found by its event id", () => {
  const items = [compaction()];
  assert.equal(compactionForEvent(items, "evt-compaction")?.status, "completed");
  assert.equal(compactionForEvent(items, "evt-other"), null);
  assert.equal(compactionForEvent(items, null), null);
});

/* ------------------------------------------------------------------- payload */

test("drawer: payload strings are kept verbatim, objects pretty-print, absence is blank", () => {
  assert.equal(payloadText(event({ payload: "raw text" })), "raw text");
  assert.equal(
    payloadText(event({ payload: { a: 1 } })),
    JSON.stringify({ a: 1 }, null, 2),
  );
  assert.equal(payloadText(event({ payload: null })), "");
  assert.equal(PAYLOAD_SUMMARY, "Raw event payload (redacted unless reveal is on)");
});

/* ----------------------------------------------------------------- tool box */

test("drawer: the tool box carries status, duration and JSON bodies", () => {
  const box = toolBox(event());
  assert.ok(box);
  assert.equal(box.name, "bash");
  assert.equal(box.callID, "call-1");
  assert.equal(box.status, "completed");
  assert.equal(box.duration, "500 ms");
  assert.equal(box.input, JSON.stringify({ command: "ls -la" }, null, 2));
  assert.equal(box.output, "file.txt");
  assert.equal(box.error, null);
  assert.equal(box.outputTruncated, false);
  assert.deepEqual(box.childSessionIDs, []);
  assert.equal(box.metadata, null);
  assert.equal(box.diff, null);
  assert.equal(toolBox(event({ tool: null })), null);
});

test("drawer: tool diffs join every recorded file patch", () => {
  const box = toolBox(
    event({
      tool: tool({
        metadata: {
          files: [
            { patch: "--- a\n+++ b" },
            { patch: "--- c\n+++ d" },
            { patch: 7 },
            null,
          ],
        },
        outputTruncated: true,
        error: { type: "tool_error", message: "boom" },
        childSessionIDs: ["child-1", "child-2"],
      }),
    }),
  );
  assert.ok(box);
  assert.equal(box.diff, "--- a\n+++ b\n--- c\n+++ d");
  assert.equal(box.outputTruncated, true);
  assert.equal(box.error, JSON.stringify({ type: "tool_error", message: "boom" }, null, 2));
  assert.deepEqual(box.childSessionIDs, ["child-1", "child-2"]);
  assert.match(box.metadata ?? "", /"files"/);
});

/* --------------------------------------------------------------- compaction */

test("drawer: the compaction facts keep the legacy order and formatting", () => {
  const model = compactionFacts(compaction());
  assert.deepEqual(
    model.facts.map((fact) => fact.label),
    [
      "Status",
      "Reason",
      "Context before",
      "Context after",
      "Removed",
      "Summary size",
      "Output tokens",
      "Cost",
      "Duration",
    ],
  );
  const values = new Map(model.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(values.get("Reason"), "context window");
  assert.equal(values.get("Context before"), "1,000");
  assert.equal(values.get("Context after"), "400");
  assert.equal(values.get("Removed"), "—");
  assert.equal(values.get("Summary size"), "1,234 chars");
  assert.equal(values.get("Output tokens"), "5");
  assert.equal(values.get("Cost"), "$0.2500");
  assert.equal(values.get("Duration"), "1.50 s");
  assert.equal(model.note, COMPACTION_NOTE);
  assert.equal(
    COMPACTION_NOTE,
    "Compaction is not a normal step; its usage is excluded from turn/step totals.",
  );
});

/* ------------------------------------------------------------------- header */

test("drawer: the header states the kind, timestamp and status as text", () => {
  const header = drawerHeader(event());
  assert.equal(header.title, "Read the file");
  assert.equal(header.kind, "tool");
  assert.equal(header.timestamp, new Date(1_700_000_000_000).toISOString());
  assert.equal(header.status, "completed");
  assert.equal(drawerHeader(event({ status: null })).status, null);
});
