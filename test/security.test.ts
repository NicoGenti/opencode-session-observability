import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createObservabilityServer } from "../src/server/http.ts";
import { ObservabilityService } from "../src/core/service.ts";
import { preview, redactString, redactValue } from "../src/core/util.ts";
import { GENERATOR } from "../src/version.ts";
// @ts-expect-error - plain browser module without type declarations
import { renderMarkdown } from "../src/ui/markdown.js";
import {
  BASE,
  assistant,
  fixture,
  idle,
  memorySource,
  secretsFixture,
  session,
  simpleFixture,
  toolBlock,
  user,
  writeFixtureDb,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";
import type { Analysis } from "../src/core/types.ts";

/**
 * An incident whose failure and success inputs embed credential-shaped values.
 * Diagnostics must expose only key names/why text, never these values.
 */
function secretIncidentFixture(): Fixture {
  const input = {
    command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x",
    api_key: "sk-supersecretvalue12345",
    env: { PASSWORD: "hunter2" },
  };
  return fixture([
    {
      meta: session("ses_diag_redact", {
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
              name: "shell",
              created: BASE + 200,
              ran: BASE + 300,
              completed: BASE + 400,
              status: "error",
              input,
              output: "ghp_abcdefghijklmnopqrstuvwxyz0123456789 token=abcdef1234567890",
            }),
            toolBlock({
              name: "shell",
              created: BASE + 500,
              ran: BASE + 600,
              completed: BASE + 700,
              status: "error",
              input,
              output: "",
            }),
            toolBlock({
              name: "shell",
              created: BASE + 800,
              ran: BASE + 900,
              completed: BASE + 1_000,
              input,
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

function request(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("HTTP rejects forged Host and cross-site requests", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    const normal = await request(server.port, "/api/health");
    assert.equal(normal.status, 200);

    const forgedHost = await request(server.port, "/api/health", {
      Host: `attacker.example:${server.port}`,
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(JSON.parse(forgedHost.body).error, "forbidden_host");

    const forgedOrigin = await request(server.port, "/api/sessions", {
      Origin: "http://attacker.example",
    });
    assert.equal(forgedOrigin.status, 403);

    const crossSite = await request(server.port, "/api/sessions", {
      "Sec-Fetch-Site": "cross-site",
    });
    assert.equal(crossSite.status, 403);
  } finally {
    await server.close();
  }
});

test("reveal is disabled by default and health hides the database path", async () => {
  const { path } = writeFixtureDb(secretsFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    const health = JSON.parse((await request(server.port, "/api/health")).body);
    assert.equal(health.revealAllowed, false);
    assert.equal(health.dbPath, "opencode.db");

    const reveal = await request(
      server.port,
      "/api/sessions/ses_secrets/events?reveal=1",
    );
    assert.equal(reveal.status, 403);
    assert.equal(JSON.parse(reveal.body).error, "reveal_disabled");
  } finally {
    await server.close();
  }
});

test("HTTP errors do not reflect absolute paths", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    const nul = await request(server.port, "/ui/%00");
    assert.equal(nul.status, 400);
    assert.doesNotMatch(nul.body, /src[\\/]ui/i);

    const badPercent = await request(server.port, "/%");
    assert.equal(badPercent.status, 400);
    assert.match(badPercent.body, /Malformed request path/);
  } finally {
    await server.close();
  }
});

test("redaction covers token formats and truncated preview tails", () => {
  const samples = [
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    "AIzaSyD-1234567890abcdefghijklmnopqrstu",
    "sk_live_51H8xQabcdefghijklmnop",
    "STRIPE_SECRET_KEY=sk_live_51H8xQabcdefghijklmnop",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "glpat-abcdefghijklmnopqrst",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "pypi-abcdefghijklmnopqrstuvwxyz",
    "hf_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "Cookie: session=abcdef123456",
    "postgres://user:pa55w0rd@db.example.com:5432/app",
    "api_key: abcdef1234567890",
    'PASSWORD="hunter2"',
    "token=abcdef123456",
    "TOKEN=abcdef123456",
    "token: abcdefgh",
    "id_token=abcdef123456",
    "session_token=abcdef123456",
    "x-auth-token: abcdef123456",
    "https://hooks.slack.com/services/T000/B000/XXXX",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  ];
  for (const sample of samples) {
    assert.notEqual(redactString(sample), sample, `not redacted: ${sample}`);
  }

  const full = "x".repeat(230) + " sk-abcdefghijklmnop12345 TAIL";
  const redacted = redactValue({
    text: full,
    textPreview: preview(full, 240),
  }) as { textPreview: string };
  assert.doesNotMatch(redacted.textPreview, /sk-/);

  const keys = redactValue({
    apiToken: "a",
    passphrase: "b",
    xAuthToken: "c",
    secretAccessKey: "d",
    DATABASE_URL: "postgres://u:p@h/db",
  }) as Record<string, string>;
  for (const value of Object.values(keys)) assert.equal(value, "[REDACTED]");
});

test("redaction keeps token metrics readable", () => {
  for (const text of [
    "input_tokens: 100",
    "output_tokens: 50",
    "token: 100",
    "token count: 42",
    "total_tokens: 1234",
    "token=12345678",
  ]) {
    assert.equal(redactString(text), text, `over-redacted: ${text}`);
  }
});

test("redaction covers truncated secret prefixes", () => {
  const secrets = [
    "sk-abcdefghijklmnopqrstuvwx",
    `ghp_${"a".repeat(36)}`,
    `xoxb-${"b".repeat(36)}`,
    `AKIA${"C".repeat(16)}`,
    "token=abcdef1234567890",
    "id_token=abcdef1234567890",
    "session_token=abcdef1234567890",
  ];
  for (const secret of secrets) {
    for (const width of [24, 32, 48]) {
      const cut = preview(`prefix ${secret}`, width);
      const out = redactString(cut);
      assert.notEqual(out, cut, `${secret}@${width} was not redacted`);
      assert.doesNotMatch(
        out,
        /abcdef|sk-|ghp_|xoxb-|AKIA/i,
        `${secret}@${width}: ${out}`,
      );
    }
  }
});

test("session search does not match redacted titles", async () => {
  const service = new ObservabilityService(memorySource(secretsFixture()));
  const hidden = await service.listSessions({ query: "sk-testvalue" });
  assert.equal(hidden.length, 0);
  const revealed = await service.listSessions({
    query: "sk-testvalue",
    reveal: true,
  });
  assert.equal(revealed.length, 1);
  const normal = await service.listSessions({ query: "secrets" });
  assert.equal(normal.length, 1);
});

test("Markdown export escapes raw HTML in interpolated text", async () => {
  const data = simpleFixture();
  data.sessions[0]!.meta.title = '<img src=x onerror=alert(1)>';
  const service = new ObservabilityService(memorySource(data));
  const result = await service.export("ses_simple", { format: "markdown", generator: GENERATOR });
  const firstLine = result.content.split("\n")[0]!;
  const rendered = firstLine.replace(/\\[<>&[\]`]/g, "");
  assert.doesNotMatch(rendered, /<img/);
  assert.match(firstLine, /\\<img/);
});

test("Markdown renderer rejects unsafe links and handles bracket-heavy text", () => {
  const unsafe = renderMarkdown("[x](javascript:alert(1))");
  assert.doesNotMatch(unsafe.html, /<a /);

  const safe = renderMarkdown("[docs](https://example.com/docs)");
  assert.match(safe.html, /<a href="https:\/\/example\.com\/docs"/);

  const brackets = renderMarkdown("[".repeat(20_000), { maxChars: 20_000 });
  assert.equal(brackets.truncated, false);
});

test("redacted and revealed analyses carry identical diagnostics metadata", async () => {
  const service = new ObservabilityService(memorySource(secretIncidentFixture()));
  const revealed = (await service.analyze("ses_diag_redact", { reveal: true }))
    .analysis;
  const redacted = (await service.analyze("ses_diag_redact")).analysis;

  const revealedDiagnostics = revealed.diagnostics;
  const redactedDiagnostics = redacted.diagnostics;
  assert.ok(revealedDiagnostics, "revealed analysis keeps the incident");
  assert.ok(redactedDiagnostics, "redacted analysis keeps the incident");
  assert.deepEqual(redactedDiagnostics, revealedDiagnostics);

  const incident = redactedDiagnostics.incidents[0]!;
  assert.ok(incident.why.length > 0, "why survives redaction");
  assert.deepEqual(incident.inputKeyShape, [
    "api_key",
    "command",
    "env",
    "env.PASSWORD",
  ]);

  const serialized = JSON.stringify(redactedDiagnostics);
  for (const secret of [
    "sk-supersecretvalue12345",
    "hunter2",
    "abcdefghijklmnop",
    "ghp_",
    "token=abcdef1234567890",
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      `diagnostics leaked ${secret}`,
    );
  }
});

test("JSON export keeps diagnostics inside the redacted analysis", async () => {
  const service = new ObservabilityService(memorySource(secretIncidentFixture()));
  const redacted = (await service.analyze("ses_diag_redact")).analysis;
  const exported = await service.export("ses_diag_redact", { format: "json", generator: GENERATOR });
  const payload = JSON.parse(exported.content) as { analysis: Analysis };

  assert.equal(payload.analysis.redacted, true);
  assert.deepEqual(payload.analysis.diagnostics, redacted.diagnostics);
  const incident = payload.analysis.diagnostics?.incidents[0];
  assert.ok(incident, "export carries the diagnostics payload");
  assert.ok(incident.why.length > 0);
  assert.deepEqual(incident.inputKeyShape, [
    "api_key",
    "command",
    "env",
    "env.PASSWORD",
  ]);
  assert.doesNotMatch(
    JSON.stringify(payload.analysis.diagnostics),
    /sk-supersecretvalue12345|hunter2|abcdefghijklmnop/,
  );
});

test("the analysis route delivers diagnostics without a schema change", async () => {
  const { path } = writeFixtureDb(secretIncidentFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    const response = await request(
      server.port,
      "/api/sessions/ses_diag_redact/analysis",
    );
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as { analysis: Analysis };
    const incident = body.analysis.diagnostics?.incidents[0];
    assert.ok(incident, "diagnostics travel through the existing loose schema");
    assert.equal(incident.tool, "shell");
    assert.equal(incident.failureEventIDs.length, 2);
    assert.ok(incident.why.length > 0);
    assert.deepEqual(incident.inputKeyShape, [
      "api_key",
      "command",
      "env",
      "env.PASSWORD",
    ]);
    assert.doesNotMatch(
      JSON.stringify(body.analysis.diagnostics),
      /sk-supersecretvalue12345|hunter2/,
    );
  } finally {
    await server.close();
  }
});
