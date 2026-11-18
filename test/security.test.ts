import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createObservabilityServer } from "../src/server/http.ts";
import { ObservabilityService } from "../src/core/service.ts";
import { preview, redactString, redactValue } from "../src/core/util.ts";
// @ts-expect-error - plain browser module without type declarations
import { renderMarkdown } from "../src/ui/markdown.js";
// @ts-expect-error - plain browser module without type declarations
import { clientExportFilename, exportRequestPath, liveErrorDetail, resolveExportTarget, sessionExportName } from "../src/ui/app.js";
// @ts-expect-error - plain browser module without type declarations
import { safeDownloadName } from "../src/ui/format.js";
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
  const result = await service.export("ses_simple", { format: "markdown" });
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
  const exported = await service.export("ses_diag_redact", { format: "json" });
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

// ---------------------------------------------------------------------------
// DOM-XSS sinks in src/ui/app.js (code-scanning alerts 1, 2 and 21)
// ---------------------------------------------------------------------------

async function uiAppSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

/**
 * One function's source. The slice stops right after the first `}` in column 0
 * (tolerating CRLF), so a nested block or the next declaration cannot widen it.
 */
function uiFunctionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  let end = -1;
  for (
    let index = source.indexOf("\n}", start + header.length);
    index !== -1;
    index = source.indexOf("\n}", index + 2)
  ) {
    const after = source[index + 2];
    if (after === undefined || after === "\n" || after === "\r") {
      end = index + 2;
      break;
    }
  }
  return source.slice(start, end === -1 ? source.length : end);
}

test("the live poll error is written as text, never interpolated into markup", async () => {
  const renderLive = uiFunctionBody(await uiAppSource(), "function renderLive()");

  // The error is collapsed to text and written into the static template.
  assert.match(renderLive, /liveErrorDetail\(state\.live\.staleError\)/);
  assert.match(renderLive, /liveErrorDetail\(state\.liveError\)/);
  assert.match(
    renderLive,
    /marker\.textContent = `\$\{marker\.textContent\} — \$\{detail\}`/,
  );
  assert.match(
    renderLive,
    /basis\.textContent = `\$\{basis\.textContent\} — \$\{detail\}`/,
  );
  // Neither DOM insertion family may be fed: Snyk tracks `append` as well as
  // `appendChild` as a sink.
  assert.doesNotMatch(renderLive, /\.append\(/);
  assert.doesNotMatch(renderLive, /\.appendChild\(/);
  // The markup template is built without the error field at all.
  assert.match(renderLive, /\{ \.\.\.state\.live, staleError: undefined \}/);
  assert.doesNotMatch(renderLive, /liveUnavailableHtml\(state\.liveError\)/);
  assert.doesNotMatch(renderLive, /liveBadgeHtml\(state\.live\)/);

  // A script payload stays a text node: nothing is escaped or interpreted.
  const payload = "<script>alert(1)</script>";
  assert.equal(liveErrorDetail(payload), payload);
  assert.equal(liveErrorDetail(`  ${payload}\n`), payload);
  // Whitespace collapse and the 90-character cap match the string builder.
  assert.equal(liveErrorDetail(undefined), "");
  assert.equal(liveErrorDetail("x".repeat(140)).length, 90);
});

test("the compare error body is built from DOM nodes, not markup", async () => {
  const requestCompare = uiFunctionBody(
    await uiAppSource(),
    "async function requestCompare()",
  );

  assert.match(requestCompare, /document\.createElement\("p"\)/);
  assert.match(requestCompare, /paragraph\.className = "compare-inline-error"/);
  assert.match(requestCompare, /setAttribute\("role", "alert"\)/);
  assert.match(requestCompare, /paragraph\.tabIndex = 0/);
  assert.match(requestCompare, /paragraph\.textContent = message/);
  assert.match(requestCompare, /dom\.compareBody\.replaceChildren\(paragraph\)/);
  // The message must not be escaped into an HTML string any more.
  assert.doesNotMatch(requestCompare, /escapeHtml\(\s*message/);
  assert.doesNotMatch(
    requestCompare,
    /innerHTML = `<p class="compare-inline-error"/,
  );
});

test("the export download name is built from server metadata, never the route or the response", async () => {
  const source = await uiAppSource();
  const exportCurrent = uiFunctionBody(source, "async function exportCurrent(format)");

  // The name is derived from the record the resolver matched against the
  // `/api/sessions` list, then the shared allowlist, then the sink. The same
  // record feeds the request path, so name and bytes cannot diverge.
  assert.match(exportCurrent, /sessionExportName\(target\.record, format\)/);
  assert.match(exportCurrent, /const filename = safeDownloadName\(/);
  assert.match(exportCurrent, /downloadBlob\(filename, blob\)/);
  // The location-derived id may appear only as the early no-op guard, exactly
  // as in `copyDigest`; it is never read into the request path or the name.
  assert.equal([...exportCurrent.matchAll(/state\.sessionID/g)].length, 1);
  assert.match(exportCurrent, /if \(!state\.sessionID\) return;/);
  // The response supplies bytes only: its header must not reach the anchor.
  assert.doesNotMatch(exportCurrent, /Content-Disposition/i);
  assert.doesNotMatch(exportCurrent, /response\.headers/);
  assert.doesNotMatch(exportCurrent, /parseFilename/);
  assert.doesNotMatch(exportCurrent, /location\./);
  // The request target is the relative helper, fed by the resolved target id.
  assert.match(exportCurrent, /exportRequestPath\(target\.id, \{/);

  // The record lookup reads the server list and nothing else; it never falls
  // back to the selected id for a display name, and the old second read of the
  // selection is gone for good.
  const resolver = uiFunctionBody(
    source,
    "export async function resolveExportTarget(",
  );
  assert.match(resolver, /session\.id === sourceID/);
  assert.doesNotMatch(resolver, /title|slug/);
  assert.doesNotMatch(source, /function exportSessionRecord\(/);

  // The request id is the server record's own id and nothing else: the selected
  // (location-derived) id is never a fallback (alert 23 / issue #81).
  const requestID = uiFunctionBody(source, "function exportRequestID(record)");
  assert.match(requestID, /return record\?\.id \?\? null;/);
  assert.doesNotMatch(requestID, /state\.sessionID/);

  // Every download in the UI goes through `exportCurrent`'s checked name.
  const callSites = [...source.matchAll(/downloadBlob\(([^)]*)\)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(callSites, ["filename, blob"]);
});

test("every export and digest request id is resolved through the server session list", async () => {
  const source = await uiAppSource();

  // The one refresh the resolver performs asks the constant path once, with no
  // search term, and at the server's maximum page depth (it clamps at 1000), so
  // the resolved set is as complete as the API allows.
  const refresh = uiFunctionBody(source, "async function refreshSessionList()");
  assert.match(refresh, /api\("\/api\/sessions", \{ limit: 1000 \}\)/);
  assert.match(refresh, /state\.sessions = data\.sessions \?\? \[\]/);
  assert.doesNotMatch(refresh, /\bq:/);

  const resolver = uiFunctionBody(
    source,
    "export async function resolveExportTarget(",
  );
  // At most one refresh per resolution: a single `await refresh()` and no loop.
  assert.equal([...resolver.matchAll(/await refresh\(\)/g)].length, 1);
  assert.doesNotMatch(resolver, /\bwhile\s*\(|\bfor\s*\(/);
  // The selection is a lookup key only; the value handed back is the matched
  // server record plus its id, through the same null-safe extractor as before.
  assert.match(resolver, /session\.id === sourceID/);
  assert.match(resolver, /exportRequestID\(/);
  assert.match(resolver, /return \{ id: exportRequestID\(record\), record \};/);
  assert.match(resolver, /notify\(EXPORT_SESSION_MISSING\)/);
  assert.match(resolver, /return null;/);
  // A falsy selection is a silent no-op: nothing is looked up, so nothing is
  // refreshed and no toast is shown.
  assert.match(resolver, /if \(!sourceID\) return null;/);
  // No request target is built here: the caller hands the result to the path
  // helper, so no other value can be spliced in.
  assert.doesNotMatch(resolver, /exportRequestPath|fetch\(/);

  // Both operations take their target from the resolver, never from the route.
  const exportCurrent = uiFunctionBody(
    source,
    "async function exportCurrent(format)",
  );
  assert.match(exportCurrent, /const target = await resolveExportTarget\(\);/);
  const copyDigest = uiFunctionBody(source, "async function copyDigest(");
  assert.match(copyDigest, /const target = await resolveExportTarget\(\);/);
  assert.doesNotMatch(copyDigest, /exportRequestPath\(state\.sessionID/);
});

test("resolveExportTarget returns the matched record with its id, refreshing at most once", async () => {
  const routeID = "ses_route_<script>alert(1)</script>";
  const other = "ses_other";
  const loadedRecord = { id: routeID, title: "Loaded" };

  // Happy path: the record is already in the loaded list, so no refresh at all,
  // and the exact record object comes back for the caller to name the download.
  let refreshes = 0;
  const missing: string[] = [];
  const loaded = await resolveExportTarget(routeID, {
    sessions: [{ id: other }, loadedRecord],
    refresh: async () => {
      refreshes += 1;
      return [];
    },
    notify: (message: string) => missing.push(message),
  });
  assert.equal(loaded?.id, routeID);
  assert.equal(loaded?.record, loadedRecord);
  assert.equal(refreshes, 0);
  assert.equal(missing.length, 0);
  // The resolved id reaches the shared path helper as one encoded path segment.
  assert.equal(
    exportRequestPath(loaded?.id, { format: "digest" }),
    `/api/sessions/${encodeURIComponent(routeID)}/export?format=digest`,
  );

  // Refresh path: absent from the loaded list, present in the refreshed one —
  // exactly one extra list fetch, and the refreshed record comes back with it.
  const refreshCalls: string[] = [];
  const refreshedRecord = { id: routeID, title: "Refreshed" };
  const refreshed = await resolveExportTarget(routeID, {
    sessions: [{ id: other }],
    refresh: async () => {
      refreshes += 1;
      refreshCalls.push("fetch");
      return [refreshedRecord];
    },
    notify: (message: string) => missing.push(message),
  });
  assert.equal(refreshed?.id, routeID);
  assert.equal(refreshed?.record, refreshedRecord);
  assert.equal(refreshes, 1);
  assert.deepEqual(refreshCalls, ["fetch"]);
  // That refresh is the constant path at the server's maximum depth.
  const source = await uiAppSource();
  const refresh = uiFunctionBody(source, "async function refreshSessionList()");
  assert.match(refresh, /api\("\/api\/sessions", \{ limit: 1000 \}\)/);

  // Abort path: absent from both lists — no target comes back, so no request can
  // be issued, and the toast explains the depth constraint instead of asking for
  // a blind reload.
  const aborted = await resolveExportTarget(routeID, {
    sessions: [{ id: other }],
    refresh: async () => {
      refreshes += 1;
      return [{ id: other }];
    },
    notify: (message: string) => missing.push(message),
  });
  assert.equal(aborted, null);
  assert.equal(refreshes, 2);
  assert.equal(missing.length, 1);
  assert.equal(
    missing[0],
    "Session is not among the loaded sessions — it may be older than the most recent ones.",
  );

  // Falsy selection: nothing to look up, so null comes back with no refresh and
  // no toast — the belt-and-braces guard for callers without a selection.
  let silentRefreshes = 0;
  const notified: string[] = [];
  const silent = await resolveExportTarget("", {
    sessions: [{ id: routeID }],
    refresh: async () => {
      silentRefreshes += 1;
      return [{ id: routeID }];
    },
    notify: (message: string) => notified.push(message),
  });
  assert.equal(silent, null);
  assert.equal(silentRefreshes, 0);
  assert.equal(notified.length, 0);
});

test("the download name follows the resolved record even if the route changes mid-flow", async () => {
  const source = await uiAppSource();
  const exportCurrent = uiFunctionBody(
    source,
    "async function exportCurrent(format)",
  );

  // Structural half: the flow names the download from the target the resolver
  // returned and never re-reads the current selection after the awaits, so a
  // hash navigation during fetch/blob cannot swap the name.
  assert.match(exportCurrent, /sessionExportName\(target\.record, format\)/);
  assert.doesNotMatch(exportCurrent, /exportSessionRecord/);
  assert.doesNotMatch(exportCurrent, /state\.sessions/);
  assert.equal([...exportCurrent.matchAll(/state\.sessionID/g)].length, 1);

  // Behavioural half: the resolver hands back the exact matched record, so the
  // name is a pure function of it — whatever the selection becomes later.
  const now = new Date("2026-01-02T03:04:05Z");
  const target = await resolveExportTarget("ses_alpha", {
    sessions: [{ id: "ses_alpha", title: "Alpha review" }],
    refresh: async () => {
      throw new Error("refresh must not run for a loaded record");
    },
    notify: () => {
      throw new Error("notify must not run for a loaded record");
    },
  });
  assert.ok(target);
  assert.equal(target.id, "ses_alpha");
  assert.equal(
    sessionExportName(target.record, "json", now),
    sessionExportName({ id: "ses_alpha", title: "Alpha review" }, "json", now),
  );
  // A record for another session (what a re-read could have picked up) would
  // have produced a different name.
  assert.notEqual(
    sessionExportName(target.record, "json", now),
    sessionExportName({ id: "ses_beta", title: "Beta review" }, "json", now),
  );
});

test("the export request is a relative path with the documented query flags", () => {
  assert.equal(
    exportRequestPath("ses_abc", { format: "json", includeEvents: true }),
    "/api/sessions/ses_abc/export?format=json&includeEvents=1",
  );
  assert.equal(
    exportRequestPath("ses_abc", { format: "html", includeEvents: true }),
    "/api/sessions/ses_abc/export?format=html&includeEvents=1",
  );
  // reveal=1 only when reveal is actually on.
  assert.equal(
    exportRequestPath("ses_abc", {
      format: "markdown",
      includeEvents: true,
      reveal: true,
    }),
    "/api/sessions/ses_abc/export?format=markdown&includeEvents=1&reveal=1",
  );
  assert.equal(
    exportRequestPath("ses_abc", { format: "markdown", includeEvents: true }),
    "/api/sessions/ses_abc/export?format=markdown&includeEvents=1",
  );
  // The digest copy path reuses the helper without event flags.
  assert.equal(
    exportRequestPath("ses_abc", { format: "digest", prompt: true }),
    "/api/sessions/ses_abc/export?format=digest&prompt=1",
  );
  // The session id is encoded, so no path traversal can be spliced in.
  assert.equal(
    exportRequestPath("ses/../../x y", { format: "json", includeEvents: true }),
    "/api/sessions/ses%2F..%2F..%2Fx%20y/export?format=json&includeEvents=1",
  );
});

test("api() resolves paths without the document location and keeps pre-set filters", async () => {
  const apiBody = uiFunctionBody(await uiAppSource(), "async function api(");

  // The request target is the caller's path, never an origin-resolved URL.
  assert.doesNotMatch(apiBody, /new URL\(/);
  assert.doesNotMatch(apiBody, /location\./);
  // A path that already carries filters (the benchmark builder) keeps them and
  // gains the later params with `&`, not a second `?`.
  assert.match(apiBody, /path\.includes\("\?"\) \? "&" : "\?"/);
});

test("the export name follows the server metadata and ignores a hostile session id", () => {
  const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  const stamp = "20260102T030405Z";
  // An id shaped like a path traversal plus markup: it must not appear in any
  // name the helper produces.
  const hostileID = 'ses/../../<script>alert(1)</script>"x';

  // Title first — the server's display name wins.
  assert.equal(
    sessionExportName({ id: hostileID, title: "Refactor the parser" }, "json", now),
    `refactor-the-parser-${stamp}.json`,
  );
  // Then the slug.
  assert.equal(
    sessionExportName({ id: hostileID, slug: "parser-refactor" }, "markdown", now),
    `parser-refactor-${stamp}.md`,
  );
  // Then the constant fallback: no record, no title, no slug, no name.
  for (const record of [
    { id: hostileID },
    { id: hostileID, title: "", slug: "" },
    null,
    undefined,
  ]) {
    assert.equal(sessionExportName(record, "html", now), `session-${stamp}.html`);
  }

  for (const title of ["Refactor the parser", "../../etc/passwd"]) {
    const name = sessionExportName({ id: hostileID, title }, "json", now);
    // Not one character of the id survives.
    assert.ok(!name.includes("ses"), name);
    assert.ok(!name.includes("script"), name);
    assert.ok(!name.includes(".."), name);
    assert.ok(!name.includes("<"), name);
    // Whatever it produces, the shared allowlist accepts it unchanged.
    assert.equal(safeDownloadName(name), name);
  }
  // The fallback name is the shared alphabetical fallback, never the id.
  const fallback = sessionExportName({ id: hostileID }, "json", now);
  assert.equal(fallback, `session-${stamp}.json`);
  assert.equal(safeDownloadName(fallback), fallback);
});

test("the client-side export name mirrors the server convention", () => {
  const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  const stamp = "20260102T030405Z";

  assert.equal(
    clientExportFilename("Session abc", "json", now),
    `session-abc-${stamp}.json`,
  );
  assert.equal(
    clientExportFilename("Session abc", "markdown", now),
    `session-abc-${stamp}.md`,
  );
  assert.equal(
    clientExportFilename("Session abc", "html", now),
    `session-abc-${stamp}.html`,
  );
  // An empty display name still yields a name, exactly like the server's
  // fallback, so a session without metadata still downloads.
  assert.equal(clientExportFilename("", "json", now), `session-${stamp}.json`);
  assert.equal(clientExportFilename("!!", "json", now), `session-${stamp}.json`);
  // The slug is capped at 60 characters, and path-ish names collapse to a slug.
  assert.equal(
    clientExportFilename("x".repeat(200), "json", now),
    `${"x".repeat(60)}-${stamp}.json`,
  );
  assert.equal(
    clientExportFilename("../../etc/passwd", "json", now),
    `etc-passwd-${stamp}.json`,
  );
});

test("download names keep the export route's shape and reject everything else", () => {
  for (const name of [
    "session-ses-simple-20260101T120000Z.json",
    "session-a-20260101T120000Z.md",
    "session-a-20260101T120000Z-digest.md",
  ]) {
    assert.equal(safeDownloadName(name), name);
  }

  // The allowlist boundary is exact: 120 characters pass, 121 do not.
  const longest = "a".repeat(120);
  assert.equal(safeDownloadName(longest), longest);
  assert.equal(safeDownloadName("a".repeat(121)), "download");

  for (const hostile of [
    "",
    "   ",
    "../session.md",
    "..\\..\\session.md",
    "/etc/passwd",
    "a b.md",
    ".hidden.md",
    "session%22.md",
    'session".md',
    "session<script>alert(1)</script>.md",
    `${"a".repeat(200)}.md`,
    "-session.md",
    "session.md.",
    "session..md",
    "session.md\t",
    "session\n.md",
    "download.",
  ]) {
    assert.equal(safeDownloadName(hostile), "download", JSON.stringify(hostile));
  }

  // A non-string and an absent request both fall back.
  assert.equal(safeDownloadName(undefined), "download");
  assert.equal(safeDownloadName(null), "download");
  assert.equal(safeDownloadName(42), "download");
  // Callers may still name their own fallback.
  assert.equal(
    safeDownloadName("../x.md", "session.fallback.md"),
    "session.fallback.md",
  );
});
