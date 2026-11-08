import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import { ApiSource } from "../src/core/adapters/api.ts";
import { MemorySource } from "../src/core/adapters/memory.ts";
import { mergePages } from "../src/core/paging.ts";
import {
  longFixture,
  memorySource,
  simpleFixture,
  subagentFixture,
  toolsFixture,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

function fakeClient(data: Fixture) {
  const sessions = data.sessions.map((entry) => ({
    id: entry.meta.id,
    parentID: entry.meta.parentID,
    projectID: entry.meta.projectID ?? "proj_test",
    agent: entry.meta.agent,
    model: entry.meta.model,
    cost: entry.meta.cost ?? 0,
    tokens: entry.meta.tokens
      ? {
          input: entry.meta.tokens.input,
          output: entry.meta.tokens.output,
          reasoning: entry.meta.tokens.reasoning,
          cache: {
            read: entry.meta.tokens.cacheRead,
            write: entry.meta.tokens.cacheWrite,
          },
        }
      : undefined,
    outcome: entry.meta.outcome,
    time: entry.meta.time,
    title: entry.meta.title,
    location: { directory: entry.meta.directory },
    revert: entry.meta.revert,
    fork: entry.meta.fork,
  }));
  return {
    session: {
      list: async () => ({ data: sessions }),
      get: async (input: { sessionID: string }) => ({
        data: sessions.find((session) => session.id === input.sessionID),
      }),
      context: async (input: { sessionID: string }) => {
        const entry = data.sessions.find((item) => item.meta.id === input.sessionID);
        return {
          data: (entry?.messages ?? []).map((message) => ({
            ...(message.data as Record<string, unknown>),
            id: message.id,
            type: message.type,
          })),
        };
      },
    },
  };
}

test("API source maps session info, context messages and subagent families", async () => {
  const data = subagentFixture();
  const source = new ApiSource(fakeClient(data));
  const service = new ObservabilityService(source);

  const sessions = await service.listSessions();
  assert.equal(sessions.length, 2);
  const child = await service.getSession("ses_child");
  assert.equal(child.session.parentID, "ses_parent");
  assert.equal(child.family.parent?.id, "ses_parent");

  const analysis = (await service.analyze("ses_child")).analysis;
  assert.equal(analysis.turns[0]!.trigger.kind, "delegation");
  assert.equal(analysis.coverage.complete, true);
  assert.ok(
    analysis.capabilities.notes.some((note) => note.includes("Sequence numbers")),
  );
});

test("event pages are keyset-paged without overlap", async () => {
  const data = longFixture(40);
  const service = new ObservabilityService(memorySource(data));
  const first = await service.events({ sessionID: "ses_long", limit: 20 });
  assert.equal(first.events.length, 20);
  assert.equal(first.page.totalMatched, 40 * 4);
  assert.equal(first.page.hasMoreBefore, true);
  assert.equal(first.page.hasMoreAfter, false);

  const second = await service.events({
    sessionID: "ses_long",
    limit: 20,
    before: first.page.before!,
  });
  assert.equal(second.events.length, 20);
  assert.equal(second.page.hasMoreAfter, true);
  const overlap = new Set(first.events.map((event) => event.id));
  assert.ok(second.events.every((event) => !overlap.has(event.id)));

  const merged = mergePages(
    first.events,
    second.events,
    "backward",
    (event) => event.orderKey,
  );
  assert.equal(merged.items.length, 40);
  assert.equal(merged.items[0]!.orderKey < merged.items[39]!.orderKey, true);
});

test("event pages can be centered on a jump target", async () => {
  const data = longFixture(40);
  const service = new ObservabilityService(memorySource(data));
  const analysis = (await service.analyze("ses_long")).analysis;
  const target = analysis.events[Math.floor(analysis.events.length / 2)]!;
  const page = await service.events({
    sessionID: "ses_long",
    limit: 10,
    around: target.id,
  });
  assert.ok(page.events.some((event) => event.id === target.id));
  assert.equal(page.events.length, 10);
  assert.equal(page.page.hasMoreBefore, true);
  assert.equal(page.page.hasMoreAfter, true);
});

test("event filters cover kind, tool, agent, model, status and token range", async () => {
  const data = toolsFixture();
  const service = new ObservabilityService(memorySource(data));

  const tools = await service.events({ sessionID: "ses_tools", kinds: ["tool"] });
  assert.equal(tools.events.length, 2);

  const reads = await service.events({ sessionID: "ses_tools", tools: ["read"] });
  assert.equal(reads.events.length, 1);
  assert.equal(reads.events[0]!.tool?.name, "read");

  const errors = await service.events({ sessionID: "ses_tools", errorsOnly: true });
  assert.equal(errors.events.length, 1, "the failed tool is the only error");
  assert.ok(errors.events.every((event) => event.flags.error));

  const byAgent = await service.events({ sessionID: "ses_tools", agents: ["build"] });
  assert.ok(byAgent.events.length > 0);

  const byModel = await service.events({
    sessionID: "ses_tools",
    models: ["test-provider/test-model"],
  });
  assert.ok(byModel.events.length > 0);

  const byProvider = await service.events({
    sessionID: "ses_tools",
    providers: ["test-provider"],
  });
  assert.ok(byProvider.events.length > 0);

  const byStatus = await service.events({
    sessionID: "ses_tools",
    statuses: ["error"],
  });
  assert.ok(byStatus.events.every((event) => (event.tool?.status ?? event.status) === "error"));

  const tokens = await service.events({
    sessionID: "ses_tools",
    minPromptTokens: 4_000,
  });
  assert.ok(tokens.events.length > 0);
  assert.ok(
    tokens.events.every(
      (event) => event.tokens && event.tokens.input + event.tokens.cacheRead + event.tokens.cacheWrite >= 4_000,
    ),
  );
});

test("full-text search covers prompts, tool payloads and serialized events", async () => {
  const service = new ObservabilityService(memorySource(toolsFixture()));
  const read = await service.events({
    sessionID: "ses_tools",
    q: "src/index.ts",
    kinds: ["tool"],
  });
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0]!.tool?.name, "read");

  const prompt = await service.events({ sessionID: "ses_tools", q: "hello" });
  assert.ok(prompt.events.length > 0);
});

test("event detail returns the full payload and honors reveal", async () => {
  const service = new ObservabilityService(memorySource(toolsFixture()));
  const detail = await service.eventDetail("ses_tools", "msg_a1:1");
  assert.equal(detail.kind, "tool");
  assert.equal(detail.tool?.name, "read");
  assert.match(JSON.stringify(detail.payload), /src\/index\.ts/);
  assert.equal(detail.tool?.input === null, false, "detail keeps the tool input");
});

test("event list DTOs omit payloads and large tool bodies", async () => {
  const service = new ObservabilityService(memorySource(toolsFixture()));
  const page = await service.events({ sessionID: "ses_tools", limit: 100 });
  const tool = page.events.find((event) => event.kind === "tool")!;
  assert.equal(tool.payload, null);
  assert.equal(tool.text, null);
  assert.equal(tool.tool?.input, null);
  assert.equal(tool.tool?.output, null);
  assert.ok((tool.tool?.inputPreview ?? "").includes("src/index.ts"));
  assert.ok((tool.tool?.outputPreview ?? "").length > 0);
});

test("session listing and analysis support windowed coverage", async () => {
  const data = longFixture(30);
  const source = new MemorySource({
    kind: "jsonl",
    sessions: data.sessions.map((entry) => entry.meta),
    messages: new Map(data.sessions.map((entry) => [entry.meta.id, entry.messages])),
  });
  const service = new ObservabilityService(source);
  const sessions = await service.listSessions({ query: "long", limit: 5 });
  assert.equal(sessions.length, 1);
  const { analysis } = await service.analyze("ses_long", { fromSeq: 1, toSeq: 20 });
  assert.equal(analysis.coverage.complete, false);
  assert.equal(analysis.totals.scope, "window");
});
