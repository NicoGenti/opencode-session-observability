import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ObservabilityService } from "../src/core/service.ts";
import { DIGEST_MAX_CHARS } from "../src/core/digest.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  longFixture,
  memorySource,
  secretsFixture,
  session,
  simpleFixture,
  toolBlock,
  toolsFixture,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

/** Credential-shaped value used only to prove digest redaction end to end. */
const SECRET_ERROR_VALUE = "sk-live-abc123def456ghi789";

function secretErrorFixture(): Fixture {
  return fixture([
    {
      meta: session("ses_secret_error", { title: "Secret error" }),
      messages: [
        user("msg_u1", 1, BASE, "Run the failing command"),
        assistant({
          id: "msg_a1",
          seq: 2,
          created: BASE + 100,
          streamed: BASE + 400,
          completed: BASE + 500,
          content: [
            toolBlock({
              name: "shell",
              created: BASE + 200,
              ran: BASE + 250,
              completed: BASE + 450,
              status: "error",
              input: { command: "curl" },
              output: "",
              error: {
                type: "auth",
                message: `rejected key ${SECRET_ERROR_VALUE}`,
              },
            }),
          ],
          tokens: {
            input: 100,
            output: 10,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          cost: 0.001,
        }),
        idle("msg_i1", 3, BASE + 600, "succeeded"),
      ],
    },
  ]);
}

function emptyFixture(): Fixture {
  return fixture([
    {
      meta: session("ses_empty", {
        time: { created: BASE, updated: BASE + 100 },
      }),
      messages: [idle("msg_i0", 1, BASE + 100, "succeeded")],
    },
  ]);
}

test("exports JSON with the normalized analysis and optional events", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const result = await service.export("ses_simple", { format: "json" });
  assert.match(result.filename, /^session-ses-simple-\d{8}T\d{6}Z\.json$/);
  assert.equal(result.mime, "application/json; charset=utf-8");
  assert.equal(result.redacted, true);
  const parsed = JSON.parse(result.content) as Record<string, any>;
  assert.equal(parsed.generator, "opencode-session-observability/0.3.0");
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

test("exports a digest in Markdown through the shared export path", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const result = await service.export("ses_simple", { format: "digest" });
  assert.match(result.filename, /^session-ses-simple-\d{8}T\d{6}Z-digest\.md$/);
  assert.equal(result.mime, "text/markdown; charset=utf-8");
  assert.equal(result.redacted, true);
  assert.match(result.content, /^# Session digest — /);
  assert.match(result.content, /## Totals/);
  assert.match(result.content, /## Turn summary/);
  assert.match(result.content, /Generated by opencode-session-observability/);
});

test("digest with prompt=true prefixes the review instructions", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const plain = await service.export("ses_simple", { format: "digest" });
  const result = await service.export("ses_simple", {
    format: "digest",
    prompt: true,
  });
  assert.match(
    result.filename,
    /^session-ses-simple-\d{8}T\d{6}Z-review-prompt\.md$/,
  );
  assert.equal(result.mime, "text/markdown; charset=utf-8");
  assert.ok(
    result.content.startsWith(
      "You are reviewing an OpenCode coding-agent session",
    ),
  );
  assert.ok(result.content.includes(`SESSION DIGEST:\n${plain.content}`));
  assert.ok(result.content.endsWith(plain.content));
  assert.doesNotMatch(result.content, /UNREDACTED/);
});

test("digest honors caller redaction and reveal", async () => {
  const service = new ObservabilityService(memorySource(secretsFixture()));
  const redacted = await service.export("ses_secrets", { format: "digest" });
  assert.equal(redacted.redacted, true);
  for (const secret of [
    "sk-supersecretvalue12345",
    "ghp_abcdefghijklmnop",
    "token=abcdef1234567890",
    "sk-testvalue1234567890",
  ]) {
    assert.ok(!redacted.content.includes(secret), secret);
  }
  assert.match(redacted.content, /\[REDACTED/);
  assert.match(redacted.content, /^> Redacted: /m);

  const revealed = await service.export("ses_secrets", {
    format: "digest",
    reveal: true,
  });
  assert.equal(revealed.redacted, false);
  assert.ok(revealed.content.includes("sk-testvalue1234567890"));
  assert.match(revealed.content, /^> UNREDACTED: /m);
  assert.doesNotMatch(revealed.content, /^> Redacted: /m);
});

test("digest redacts credential-shaped tool errors and reveals them explicitly", async () => {
  const service = new ObservabilityService(memorySource(secretErrorFixture()));
  const redacted = await service.export("ses_secret_error", {
    format: "digest",
  });
  assert.equal(redacted.redacted, true);
  assert.match(redacted.content, /\[REDACTED/);
  assert.ok(!redacted.content.includes(SECRET_ERROR_VALUE));
  assert.match(redacted.content, /tool shell — auth: rejected key /);

  const revealed = await service.export("ses_secret_error", {
    format: "digest",
    reveal: true,
  });
  assert.equal(revealed.redacted, false);
  assert.ok(revealed.content.includes(SECRET_ERROR_VALUE));
});

test("digest content is deterministic across service loads", async () => {
  const first = await new ObservabilityService(
    memorySource(toolsFixture()),
  ).export("ses_tools", { format: "digest" });
  const repeated = await new ObservabilityService(
    memorySource(toolsFixture()),
  ).export("ses_tools", { format: "digest" });
  assert.equal(first.content, repeated.content);
});

test("digest export of a long session stays within the size cap", async () => {
  const service = new ObservabilityService(memorySource(longFixture(300)));
  const result = await service.export("ses_long", { format: "digest" });
  assert.ok(result.content.length <= DIGEST_MAX_CHARS);
  assert.match(result.content, /\[truncated: \d+ of 300 turns omitted\]/);
  assert.match(result.content, /Generated by opencode-session-observability/);
});

test("digest export of a zero-turn session is valid", async () => {
  const service = new ObservabilityService(memorySource(emptyFixture()));
  const result = await service.export("ses_empty", { format: "digest" });
  assert.match(result.filename, /-digest\.md$/);
  assert.match(result.content, /^# Session digest — /);
  assert.match(result.content, /## Totals/);
  assert.match(result.content, /- Turns: 0/);
  assert.match(result.content, /## Turn summary/);
  assert.match(result.content, /None recorded\./);
});

function parseTokenBlock(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!.trim(),
    ]),
  );
}

function lightTokens(css: string): Record<string, string> {
  const block = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  return parseTokenBlock(block);
}

function darkTokens(css: string): Record<string, string> {
  const block = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  return parseTokenBlock(block);
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (offset: number) => {
    const ratio = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("light and dark text tokens meet WCAG AA on their surfaces", () => {
  const css = readFileSync(new URL("../src/web/styles/index.css", import.meta.url), "utf8");
  const light = lightTokens(css);
  const dark = darkTokens(css);
  for (const role of ["muted", "text-2", "accent", "good", "critical"]) {
    assert.ok(
      contrast(light[role]!, light.surface!) >= 4.5,
      `light --${role} is ${contrast(light[role]!, light.surface!).toFixed(2)}:1`,
    );
    assert.ok(
      contrast(dark[role]!, dark.surface!) >= 4.5,
      `dark --${role} is ${contrast(dark[role]!, dark.surface!).toFixed(2)}:1`,
    );
  }
});

test("HTML export mirrors the UI token block", async () => {
  const service = new ObservabilityService(memorySource(simpleFixture()));
  const result = await service.export("ses_simple", { format: "html" });
  const css = readFileSync(new URL("../src/web/styles/index.css", import.meta.url), "utf8");
  const light = lightTokens(css);
  const exported = lightTokens(result.content);
  for (const role of [
    "page",
    "surface",
    "surface-2",
    "text",
    "text-2",
    "muted",
    "accent",
    "good",
    "warning",
    "serious",
    "critical",
    "radius",
  ]) {
    assert.equal(
      exported[role],
      light[role],
      `--${role} drifted between styles.css and the HTML export`,
    );
  }
  assert.doesNotMatch(result.content, /--series-1/);
  assert.doesNotMatch(result.content, /th\s*\{[^}]*text-transform:\s*uppercase/);
  assert.doesNotMatch(result.content, /\.stat-label\s*\{[^}]*text-transform:\s*uppercase/);
});
