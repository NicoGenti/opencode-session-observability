import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMessages } from "../src/core/normalize.ts";
import {
  BASE,
  assistant,
  compactionFixture,
  outOfOrderFixture,
  retryFixture,
  simpleFixture,
  subagentFixture,
  toolBlock,
  toolsFixture,
  user,
} from "./fixtures/build.ts";

test("normalizes user, assistant, text and idle events in recorded order", () => {
  const data = simpleFixture();
  const entry = data.sessions[0]!;
  const events = normalizeMessages(entry.messages, { session: entry.meta });
  assert.deepEqual(
    events.map((event) => event.kind),
    ["user", "assistant", "text", "idle"],
  );
  assert.equal(events[0]!.title, "User message");
  assert.equal(events[1]!.tokens?.input, 100);
  assert.equal(events[1]!.endTimestamp, BASE + 600);
  assert.equal(events[2]!.text, "Hello!");
  assert.ok(events.every((event) => event.sessionID === "ses_simple"));
  const keys = new Set(events.map((event) => event.orderKey));
  assert.equal(keys.size, events.length, "order keys are unique");
});

test("normalizes tool calls, results, errors and parallel timings", () => {
  const data = toolsFixture();
  const entry = data.sessions[0]!;
  const events = normalizeMessages(entry.messages, { session: entry.meta });
  const tools = events.filter((event) => event.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.tool?.name, "read");
  assert.equal(tools[0]!.tool?.duration.value, 200);
  assert.equal(tools[1]!.tool?.status, "error");
  assert.equal(tools[1]!.tool?.error?.message, "invalid regex");
  assert.equal(tools[1]!.flags.error, true);
  assert.equal(tools[1]!.tool?.duration.value, 500);
  assert.ok(events.some((event) => event.kind === "reasoning"));
  const reasoning = events.find((event) => event.kind === "reasoning")!;
  assert.equal(reasoning.endTimestamp, BASE + 350);
  assert.equal(reasoning.timestamp, BASE + 150);
});

test("links subagent tool results to child sessions", () => {
  const data = subagentFixture();
  const parent = data.sessions[0]!;
  const events = normalizeMessages(parent.messages, { session: parent.meta });
  const tool = events.find((event) => event.kind === "tool")!;
  assert.equal(tool.flags.subagent, true);
  assert.deepEqual(tool.tool?.childSessionIDs, ["ses_child"]);
  assert.equal(tool.meta?.delegatedAgent, "explorer");
});

test("derives retry and error events from an assistant step", () => {
  const data = retryFixture();
  const entry = data.sessions[0]!;
  const events = normalizeMessages(entry.messages, { session: entry.meta });
  const retry = events.find((event) => event.kind === "retry");
  const error = events.find((event) => event.kind === "error");
  assert.ok(retry);
  assert.ok(error);
  assert.equal(retry!.flags.retry, true);
  assert.equal(retry!.text, "stream ended");
  assert.equal(error!.flags.error, true);
  assert.equal(retry!.meta?.derived, true);
});

test("compaction events carry summary, tokens and reason", () => {
  const data = compactionFixture();
  const entry = data.sessions[0]!;
  const events = normalizeMessages(entry.messages, { session: entry.meta });
  const comp = events.find((event) => event.kind === "compaction")!;
  assert.equal(comp.flags.compaction, true);
  assert.equal(comp.tokens?.input, 8_000);
  assert.equal(comp.meta?.reason, "manual");
  assert.equal(comp.text, "A compact summary.");
  assert.equal(comp.meta?.summaryChars, 18);
});

test("preserves sequence order and flags timestamp regressions", () => {
  const data = outOfOrderFixture();
  const entry = data.sessions[0]!;
  const events = normalizeMessages(entry.messages, { session: entry.meta });
  assert.deepEqual(
    events.map((event) => event.kind),
    ["user", "assistant", "text", "idle"],
  );
  const assistant = events.find((event) => event.kind === "assistant")!;
  assert.ok(assistant.uncertainty.includes("timestamp-regression"));
  assert.equal(assistant.timestamp, BASE + 1_000);
});

test("emits provenance markers from session metadata", () => {
  const data = subagentFixture();
  const child = data.sessions[1]!;
  const events = normalizeMessages(child.messages, { session: child.meta });
  const marker = events.find((event) => event.kind === "session");
  assert.ok(marker);
  assert.equal(marker!.flags.uncertain, true);
  assert.match(marker!.text ?? "", /ses_parent/);
});

test("does not invent a missing tool start timestamp", () => {
  const entry = simpleFixture().sessions[0]!;
  const block = toolBlock({
    name: "read",
    created: BASE + 200,
    ran: BASE + 300,
    completed: BASE + 400,
    output: "content",
  }) as Record<string, any>;
  delete block.time.created;
  const messages = [
    user("msg_u2", 10, BASE + 100),
    assistant({
      id: "msg_a2",
      seq: 11,
      created: BASE + 150,
      streamed: BASE + 250,
      completed: BASE + 450,
      content: [block],
    }),
  ];
  const events = normalizeMessages(messages, { session: entry.meta });
  const tool = events.find((event) => event.kind === "tool")!;
  assert.equal(tool.tool?.createdAt, null);
  assert.equal(tool.tool?.duration.value, 100);
  assert.equal(tool.tool?.duration.note, "ran -> completed");
  assert.equal(tool.uncertainty.includes("tool-time-missing"), false);
  assert.equal(tool.timestamp, BASE + 150, "event falls back to the message timestamp");

  const noTimes = toolBlock({
    name: "read",
    created: BASE + 200,
    ran: null,
    completed: null,
    status: "running",
  }) as Record<string, any>;
  delete noTimes.time.created;
  const unknown = normalizeMessages(
    [user("msg_u3", 20, BASE + 500), assistant({
      id: "msg_a3",
      seq: 21,
      created: BASE + 550,
      streamed: BASE + 600,
      completed: null,
      content: [noTimes],
    })],
    { session: entry.meta },
  ).find((event) => event.kind === "tool")!;
  assert.equal(unknown.tool?.duration.value, null);
  assert.equal(unknown.tool?.duration.basis, "unavailable");
  assert.ok(unknown.uncertainty.includes("tool-time-missing"));
});

test("unknown message types are kept and marked uncertain", () => {
  const entry = simpleFixture().sessions[0]!;
  const messages = [
    ...entry.messages,
    {
      id: "msg_unknown",
      sessionID: "ses_simple",
      type: "mystery",
      seq: 99,
      timeCreated: BASE + 2_000,
      data: { time: { created: BASE + 2_000 }, foo: "bar" },
    },
  ];
  const events = normalizeMessages(messages, { session: entry.meta });
  const unknown = events.find((event) => event.kind === "unknown")!;
  assert.equal(unknown.flags.uncertain, true);
  assert.ok(unknown.uncertainty.includes("unknown-message-type"));
});
