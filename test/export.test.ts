import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import { memorySource, secretsFixture, simpleFixture } from "./fixtures/build.ts";

test("exports JSON with the normalized analysis and optional events", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const result = await service.export("ses_simple", { format: "json" });
  assert.match(result.filename, /^session-ses-simple-\d{8}T\d{6}Z\.json$/);
  assert.equal(result.mime, "application/json; charset=utf-8");
  assert.equal(result.redacted, true);
  const parsed = JSON.parse(result.content) as Record<string, any>;
  assert.equal(parsed.generator, "opencode-session-observability/0.1.0");
  assert.equal(parsed.redacted, true);
  assert.equal(parsed.session.id, "ses_simple");
  assert.equal(parsed.analysis.turns.length, 1);
  assert.equal(parsed.analysis.totals.steps, 1);
  assert.ok(Array.isArray(parsed.events));
  assert.ok(parsed.limitations.length >= 3);

  const withoutEvents = await service.export("ses_simple", {
    format: "json",
    includeEvents: false,
  });
  assert.equal("events" in (JSON.parse(withoutEvents.content) as object), false);
});

test("exports a Markdown report with labeled metrics and limitations", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const result = await service.export("ses_simple", { format: "markdown" });
  assert.match(result.filename, /\.md$/);
  assert.match(result.content, /^# Session ses_simple/m);
  assert.match(result.content, /## Summary \(Session total\)/);
  assert.match(result.content, /## Turns/);
  assert.match(result.content, /## Steps/);
  assert.match(result.content, /## Trajectory/);
  assert.match(result.content, /TTFT is shown as/);
  assert.match(result.content, /Prompt tokens = input \+ cache read/);
  assert.match(result.content, /Tool: shell|read/);
});

test("exports a self-contained HTML report", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const result = await service.export("ses_simple", { format: "html" });
  assert.match(result.filename, /\.html$/);
  assert.match(result.content, /^<!doctype html>/);
  assert.match(result.content, /Session total/);
  assert.match(result.content, /data-copy/);
  assert.match(result.content, /<style>/);
  assert.doesNotMatch(result.content, /<script src=/);
  assert.match(result.content, /Limitations and metric basis/);
});

test("HTML export escapes session and event content", async () => {
  const data = simpleFixture();
  data.sessions[0]!.meta.title = '<script>alert("x")</script>';
  const service = new ObservabilityService(memorySource(data));
  const result = await service.export("ses_simple", { format: "html" });
  assert.doesNotMatch(result.content, /<script>alert/);
  assert.match(result.content, /&lt;script&gt;alert/);
});

test("redacted Markdown and HTML exports contain no fixture secrets", async () => {
  const service = new ObservabilityService(memorySource(secretsFixture()));
  for (const format of ["markdown", "html"] as const) {
    const result = await service.export("ses_secrets", {
      format,
      includeEvents: true,
    });
    assert.equal(result.redacted, true);
    assert.doesNotMatch(result.content, /sk-supersecretvalue12345/);
    assert.doesNotMatch(result.content, /ghp_abcdefghijklmnop/);
    assert.doesNotMatch(result.content, /token=abcdef1234567890/);
    assert.match(result.content, /\[REDACTED/);
  }
});

test("redacted exports hide credentials and reveal exports include them", async () => {
  const service = new ObservabilityService(memorySource(secretsFixture()));
  const redacted = await service.export("ses_secrets", {
    format: "json",
    includeEvents: true,
  });
  assert.doesNotMatch(redacted.content, /sk-supersecretvalue12345/);
  assert.doesNotMatch(redacted.content, /ghp_abcdefghijklmnop/);
  assert.doesNotMatch(redacted.content, /token=abcdef1234567890/);
  assert.match(redacted.content, /\[REDACTED/);

  const revealed = await service.export("ses_secrets", {
    format: "json",
    includeEvents: true,
    reveal: true,
  });
  assert.equal(revealed.redacted, false);
  assert.match(revealed.content, /sk-supersecretvalue12345/);
  assert.match(revealed.content, /ghp_abcdefghijklmnop/);
});
