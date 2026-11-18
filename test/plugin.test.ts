import test from "node:test";
import assert from "node:assert/strict";
import { Observability } from "../src/plugin/rpc.ts";
import { createRpcHandlers } from "../src/plugin/service.ts";
import { ObservabilityService } from "../src/core/service.ts";
import {
  memorySource,
  secretsFixture,
  toolsFixture,
} from "./fixtures/build.ts";

function handlersFor(data: ReturnType<typeof toolsFixture>, allowReveal = true) {
  const service = new ObservabilityService(memorySource(data));
  return createRpcHandlers(service, allowReveal);
}

test("RPC contract exposes the expected methods", () => {
  assert.equal(Observability.id, "session-observability");
  const methods = Object.keys(Observability.methods).sort();
  assert.deepEqual(methods, [
    "analysis",
    "event",
    "eventPage",
    "export",
    "health",
    "session",
    "sessions",
  ]);
  assert.equal("events" in Observability.methods, false, "events is reserved");

  const exportInput = Observability.methods.export.input as {
    properties: {
      format: { enum: readonly string[] };
      prompt: { type: string };
    };
  };
  assert.deepEqual(exportInput.properties.format.enum, [
    "json",
    "markdown",
    "html",
    "digest",
  ]);
  assert.deepEqual(exportInput.properties.prompt, { type: "boolean" });
});

test("RPC health reports the read-only source", async () => {
  const handlers = handlersFor(toolsFixture());
  const health = await handlers.health();
  assert.equal(health.ok, true);
  assert.equal(health.readOnly, true);
  assert.equal(health.source, "jsonl");
  assert.equal(health.revealAllowed, true);
});

test("RPC sessions, session and analysis return normalized data", async () => {
  const handlers = handlersFor(toolsFixture());
  const sessions = await handlers.sessions({ limit: 5 });
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].id, "ses_tools");

  const session = await handlers.session({ sessionID: "ses_tools" });
  assert.equal(session.session.id, "ses_tools");
  assert.equal(session.family.parent, null);

  const analysis = await handlers.analysis({ sessionID: "ses_tools" });
  assert.equal(analysis.analysis.totals.steps, 2);
  assert.equal(analysis.analysis.totals.toolCalls, 2);
  assert.equal(analysis.analysis.turns[0].steps[0].toolCalls[0].input, null);
  assert.ok(analysis.analysis.turns[0].steps[0].toolCalls[0].inputPreview);
  // The TUI has no attribution surface, so the RPC payload omits the rider
  // the service itself still computes.
  assert.equal("attribution" in analysis.analysis, false);
});

test("RPC eventPage supports filters and paging", async () => {
  const handlers = handlersFor(toolsFixture());
  const page = await handlers.eventPage({
    sessionID: "ses_tools",
    kinds: ["tool"],
  });
  assert.equal(page.events.length, 2);
  assert.equal(page.page.totalMatched, 2);
  const first = await handlers.eventPage({
    sessionID: "ses_tools",
    limit: 1,
  });
  assert.equal(first.events.length, 1);
  assert.equal(first.page.hasMoreBefore, true);
});

test("RPC event detail and export honor the reveal policy", async () => {
  const handlers = handlersFor(secretsFixture(), false);
  const detail = await handlers.event({
    sessionID: "ses_secrets",
    eventID: "msg_a1:0",
    reveal: true,
  });
  assert.equal(detail.revealAllowed, false);
  assert.doesNotMatch(JSON.stringify(detail.event.payload), /sk-supersecretvalue/);

  const exported = await handlers.export({
    sessionID: "ses_secrets",
    format: "json",
    reveal: true,
  });
  assert.equal(exported.redacted, true);
  assert.doesNotMatch(exported.content, /sk-supersecretvalue/);
});

test("RPC export serves the digest and review prompt under the reveal policy", async () => {
  const restricted = handlersFor(secretsFixture(), false);
  const digest = await restricted.export({
    sessionID: "ses_secrets",
    format: "digest",
  });
  assert.match(digest.filename, /-digest\.md$/);
  assert.equal(digest.mime, "text/markdown; charset=utf-8");
  assert.equal(digest.redacted, true);
  assert.doesNotMatch(digest.content, /sk-supersecretvalue/);
  assert.match(digest.content, /\[REDACTED/);

  const prompt = await restricted.export({
    sessionID: "ses_secrets",
    format: "digest",
    prompt: true,
  });
  assert.match(prompt.filename, /-review-prompt\.md$/);
  assert.ok(
    prompt.content.startsWith(
      "You are reviewing an OpenCode coding-agent session",
    ),
  );
  assert.doesNotMatch(prompt.content, /sk-supersecretvalue/);
  assert.doesNotMatch(prompt.content, /UNREDACTED/);

  const revealed = await handlersFor(secretsFixture(), true).export({
    sessionID: "ses_secrets",
    format: "digest",
    reveal: true,
  });
  assert.equal(revealed.redacted, false);
  assert.match(revealed.content, /^> UNREDACTED: /m);
  assert.match(revealed.content, /sk-testvalue1234567890/);
});
