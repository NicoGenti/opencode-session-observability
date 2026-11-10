import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import { evaluateDiagnostics } from "../src/core/diagnostics.ts";
import { ApiSource } from "../src/core/adapters/api.ts";
import { MemorySource } from "../src/core/adapters/memory.ts";
import { mergePages } from "../src/core/paging.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  longFixture,
  memorySource,
  session,
  simpleFixture,
  subagentFixture,
  toolBlock,
  toolsFixture,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

/**
 * One turn with two failing `read` calls closed by an identical success:
 * the canonical single-incident shape the service must deliver.
 */
function incidentFixture(): Fixture {
  return fixture([
    {
      meta: session("ses_incident", {
        time: {
          created: BASE,
          updated: BASE + 2_000,
          busy: BASE,
          idle: BASE + 1_900,
        },
      }),
      messages: [
        user("msg_u1", 1, BASE),
        assistant({
          id: "msg_a1",
          seq: 2,
          created: BASE + 100,
          streamed: BASE + 1_000,
          completed: BASE + 1_100,
          content: [
            toolBlock({
              name: "read",
              created: BASE + 200,
              ran: BASE + 300,
              completed: BASE + 400,
              status: "error",
              input: { path: "src/a.ts", limit: 10 },
              output: "",
            }),
            toolBlock({
              name: "read",
              created: BASE + 500,
              ran: BASE + 600,
              completed: BASE + 700,
              status: "error",
              input: { path: "src/a.ts", limit: 10 },
              output: "",
            }),
            toolBlock({
              name: "read",
              created: BASE + 800,
              ran: BASE + 900,
              completed: BASE + 1_000,
              input: { path: "src/a.ts", limit: 10 },
              output: "ok",
            }),
          ],
          tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0.02,
        }),
        idle("msg_i1", 3, BASE + 1_500, "succeeded"),
      ],
    },
  ]);
}

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

test("analysis exposes diagnostics with stable event anchors", async () => {
  const service = new ObservabilityService(memorySource(incidentFixture()));
  const { analysis, events } = await service.analyze("ses_incident", {
    reveal: true,
  });
  const diagnostics = analysis.diagnostics;
  assert.ok(diagnostics, "diagnostics are attached to the analysis payload");
  assert.equal(diagnostics.incidents.length, 1);
  const incident = diagnostics.incidents[0]!;

  const failures = events.filter(
    (event) => event.kind === "tool" && event.tool?.status === "error",
  );
  const success = events.find(
    (event) => event.kind === "tool" && event.tool?.status === "completed",
  )!;
  assert.equal(failures.length, 2);

  assert.equal(incident.tool, "read");
  assert.equal(incident.recovery, "recovered");
  assert.equal(incident.firstFailureEventID, failures[0]!.id);
  assert.equal(incident.lastFailureEventID, failures[1]!.id);
  assert.deepEqual(
    incident.failureEventIDs,
    failures.map((event) => event.id),
  );
  assert.equal(incident.successEventID, success.id);
  assert.equal(incident.trigger.kind, "user");
  assert.equal(incident.elapsed.value, analysis.turns[0]!.totalTime.value);
  assert.ok(incident.why.length > 0);
  assert.deepEqual(diagnostics, evaluateDiagnostics(events, analysis));
});

test("diagnostics are computed once and reused through cache and presentation", async () => {
  const service = new ObservabilityService(memorySource(incidentFixture()));
  const first = await service.loadDataset("ses_incident");
  const warm = await service.loadDataset("ses_incident");
  assert.equal(warm, first, "the 4s cache returns the same dataset object");
  assert.equal(
    warm.analysis.diagnostics,
    first.analysis.diagnostics,
    "warm cache reuses the attached engine object",
  );

  const presented = await service.analyze("ses_incident", { reveal: true });
  assert.equal(
    presented.analysis.diagnostics,
    first.analysis.diagnostics,
    "presentAnalysis copies the analysis without recomputing diagnostics",
  );

  service.clearCache();
  const refreshed = await service.loadDataset("ses_incident");
  assert.notEqual(refreshed, first);
  assert.deepEqual(refreshed.analysis.diagnostics, first.analysis.diagnostics);
});

test("windowed analysis attaches the direct engine result including excluded counts", async () => {
  const service = new ObservabilityService(memorySource(incidentFixture()));
  const windowed = await service.analyze("ses_incident", {
    fromSeq: 2,
    toSeq: 3,
    windowed: true,
  });
  assert.equal(windowed.analysis.coverage.complete, false);
  assert.ok(windowed.analysis.diagnostics, "an incident in the window is attached");
  const direct = evaluateDiagnostics(windowed.events, windowed.analysis);
  assert.deepEqual(windowed.analysis.diagnostics, direct);
  assert.equal(
    windowed.analysis.diagnostics!.summary.excludedTurnlessToolEvents,
    direct.summary.excludedTurnlessToolEvents,
  );
});

test("sessions without incidents keep diagnostics absent", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const { analysis } = await service.analyze("ses_simple", { reveal: true });
  assert.equal("diagnostics" in analysis, false);
});
