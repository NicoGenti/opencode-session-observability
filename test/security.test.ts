import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientRateLimiter,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_DRAINS,
  MAX_IN_FLIGHT_REQUESTS,
  MAX_SERVED_FILE_BYTES,
  RATE_LIMIT_BODY,
  RATE_LIMIT_BURST,
  RATE_LIMIT_REFILL_PER_MINUTE,
  createObservabilityServer,
} from "../src/server/http.ts";
import {
  openCodeThemeReadCount,
  resetOpenCodeThemeCache,
} from "../src/server/opencode-theme.ts";
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
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * A POST with a real body. The server never reads a payload, so the socket can
 * be closed right after the 413 lands. Once the response headers arrived, a
 * reset is treated as the end of the exchange: the status is the answer, and
 * the body is whatever was flushed before the connection dropped.
 */
function postWithBody(
  port: number,
  pathname: string,
  body: Buffer,
  chunked = false,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const headers: Record<string, string> = chunked
    ? {}
    : { "Content-Length": String(body.length) };
  Object.assign(headers, extraHeaders);
  return new Promise((resolve, reject) => {
    let settled = false;
    let status: number | undefined;
    let responseHeaders: http.IncomingHttpHeaders = {};
    let text = "";
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve({ status: status ?? 0, body: text, headers: responseHeaders });
    };
    const fail = (error: Error): void => {
      if (settled) return;
      // Headers already arrived: the exchange has an answer, so a reset while
      // the body is still flushing is not a test failure.
      if (status !== undefined) {
        done();
        return;
      }
      settled = true;
      reject(error);
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers,
      },
      (res) => {
        status = res.statusCode ?? 0;
        responseHeaders = res.headers;
        res.on("data", (chunk) => (text += chunk));
        res.on("end", done);
        res.on("aborted", done);
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    req.end(body);
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

// ---------------------------------------------------------------------------
// Server response surface and resource bounds
// (code-scanning alerts 11, 12, 13, 14 and their bundle mirror, 17)
// ---------------------------------------------------------------------------

test("error responses are generic JSON and never echo the request", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    const payload = "ses_<script>alert(1)";
    const missing = await request(
      server.port,
      `/api/sessions/${encodeURIComponent(payload)}`,
    );
    assert.equal(missing.status, 404);
    const missingBody = JSON.parse(missing.body) as {
      error: string;
      message: string;
    };
    assert.equal(missingBody.error, "session_not_found");
    // Fixed text: the id from the request path never reaches the body.
    assert.equal(missingBody.message, "Session not found.");
    assert.doesNotMatch(missing.body, /script|alert/);
    // Fixed JSON type plus the defensive headers on the same response.
    assert.equal(
      missing.headers["content-type"],
      "application/json; charset=utf-8",
    );
    assert.equal(missing.headers["x-content-type-options"], "nosniff");
    assert.equal(missing.headers["cache-control"], "no-store");

    const unrouted = await request(
      server.port,
      `/no-route/${encodeURIComponent(payload)}`,
    );
    assert.equal(unrouted.status, 404);
    assert.equal(
      (JSON.parse(unrouted.body) as { message: string }).message,
      "No route for this request.",
    );
    assert.doesNotMatch(unrouted.body, /script|alert|no-route/);
  } finally {
    await server.close();
  }
});

test("every error response body is a literal pinned to the reviewed table", async () => {
  const source = await readFile(
    new URL("../src/server/http.ts", import.meta.url),
    "utf8",
  );
  const block = handleCatchBlock(source);

  // Each branch pairs an identity test with a constant status and body, in the
  // documented order. Nothing here reads the exception, so an exception that
  // carries an absolute path or markup has nowhere to put it.
  const branches = [
    ...block.matchAll(
      /error instanceof (\w+)\)\s*\{\s*sendJson\(\s*req,\s*res,\s*(\d{3}),\s*\{\s*error:\s*"([a-z_]+)",\s*message:\s*"([^"]*)",?\s*\}\s*\);/g,
    ),
  ].map((match) => ({
    type: match[1],
    status: Number(match[2]),
    body: JSON.stringify({ error: match[3], message: match[4] }),
  }));

  assert.deepEqual(branches, [
    {
      type: "SessionNotFoundError",
      status: 404,
      body: '{"error":"session_not_found","message":"Session not found."}',
    },
    {
      type: "EventNotFoundError",
      status: 404,
      body: '{"error":"event_not_found","message":"Event not found."}',
    },
    {
      type: "EpisodeNotFoundError",
      status: 404,
      body: '{"error":"episode_not_found","message":"Episode not found."}',
    },
    {
      type: "DatabaseBusyError",
      status: 503,
      body: '{"error":"database_busy","message":"The OpenCode database is locked. Retry when the session is idle."}',
    },
    {
      type: "UnsupportedSchemaError",
      status: 500,
      body: '{"error":"unsupported_schema","message":"The database schema is not supported by this build."}',
    },
    {
      type: "URIError",
      status: 400,
      body: '{"error":"invalid_path","message":"Malformed request path."}',
    },
    {
      type: "SyntaxError",
      status: 400,
      body: '{"error":"invalid_query","message":"Invalid request."}',
    },
  ]);

  // The fallback is the one generic body; the last send in the block is it.
  const fallback = block.slice(block.lastIndexOf("sendJson("));
  assert.match(
    fallback,
    /^sendJson\(\s*req,\s*res,\s*500,\s*\{\s*error:\s*"internal_error",\s*message:\s*"Internal error\.",?\s*\}\s*\);/,
  );
  assert.doesNotMatch(block, /opencode\.db|alice|SECRET/);
});

test("an unknown exception from a route becomes a fixed 500 body", async () => {
  // A subclass no branch tests for, carrying a marker that must not reach the
  // wire even though the object does travel into the catch block.
  class UnknownRouteFailure extends Error {
    constructor() {
      super("SECRET-FAILURE-MARKER at C:\\Users\\alice\\.local\\share");
      this.name = "UnknownRouteFailure";
    }
  }

  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    server.service.listSessions = async () => {
      throw new UnknownRouteFailure();
    };
    const response = await request(server.port, "/api/sessions");
    assert.equal(response.status, 500);
    assert.equal(
      response.body,
      '{"error":"internal_error","message":"Internal error."}',
    );
    assert.doesNotMatch(response.body, /SECRET-FAILURE-MARKER|alice/);
  } finally {
    await server.close();
  }
});

test("the error catch block consumes the exception only through instanceof", async () => {
  const source = await readFile(
    new URL("../src/server/http.ts", import.meta.url),
    "utf8",
  );
  const block = handleCatchBlock(source);

  // Every occurrence of the binding is either the catch parameter or an
  // `instanceof` test. Comments and string literals are removed first: the wire
  // bodies spell the `error` field name, and one message ends with the word
  // "error.", but neither names the exception. Counting what is left is the
  // tight assertion, because a property read, a string conversion or an
  // interpolation would add an occurrence that neither form covers.
  const code = block
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\/[^\r\n]*/g, "");
  const named = [...code.matchAll(/\berror\b(?!\s*:)/g)].length;
  const identityTests = [
    ...block.matchAll(/error instanceof (\w+)/g),
  ].map((match) => match[1]);
  assert.equal(named, identityTests.length + 1, code);
  assert.match(block, /catch \(error\) \{/);
  assert.deepEqual(identityTests, [
    "SessionNotFoundError",
    "EventNotFoundError",
    "EpisodeNotFoundError",
    "DatabaseBusyError",
    "UnsupportedSchemaError",
    "URIError",
    "SyntaxError",
  ]);
  // No call receives the exception: only the catch declaration names it.
  assert.doesNotMatch(code.replace("catch (error) {", ""), /\w+\(\s*error\b/);
  // No property access, no string conversion, no template interpolation.
  assert.doesNotMatch(code, /\berror\s*[.[]/);
  assert.doesNotMatch(code, /String\s*\(|toString|JSON\.stringify/);
  assert.doesNotMatch(block, /\$\{/);

  // The bodies are constants, and the response-committed guard from the
  // earlier review still runs before anything can be written.
  for (const literal of [
    "session_not_found",
    "database_busy",
    "Internal error.",
  ]) {
    assert.ok(block.includes(literal), literal);
  }
  assert.match(
    block,
    /if \(\s*res\.headersSent\s*\) \{\s*try \{\s*res\.end\(\);\s*\} catch \{[\s\S]*?\}\s*return;\s*\}/,
  );
  assert.ok(
    block.indexOf("res.headersSent") < block.indexOf("instanceof"),
    "the guard must run before the chain",
  );
});

test("oversized request bodies are rejected before they are buffered", async () => {
  assert.equal(MAX_BODY_BYTES, 64 * 1024);
  // The concurrency throttle keeps its existing value; only the per-request
  // bounds are new.
  assert.equal(MAX_IN_FLIGHT_REQUESTS, 32);
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    // Declared length above the cap: rejected from the header alone.
    const declared = await postWithBody(
      server.port,
      "/api/health",
      Buffer.alloc(MAX_BODY_BYTES + 1),
    );
    assert.equal(declared.status, 413);
    const body = JSON.parse(declared.body) as { error: string; message: string };
    assert.equal(body.error, "payload_too_large");
    assert.equal(body.message, "Request body is too large.");
    assert.equal(declared.headers["x-content-type-options"], "nosniff");
    assert.equal(declared.headers["cache-control"], "no-store");
    // The connection is dropped with the answer: the unread tail is never
    // allowed to linger on a keep-alive socket.
    assert.equal(declared.headers["connection"], "close");

    // Chunked framing without Content-Length: counted as it arrives.
    const chunked = await postWithBody(
      server.port,
      "/api/health",
      Buffer.alloc(MAX_BODY_BYTES + 1),
      true,
    );
    assert.equal(chunked.status, 413);
    assert.equal(chunked.headers["connection"], "close");
    // A reset can arrive while the response body is still flushing; the status
    // and headers above are the contract, and a flushed body must still map.
    if (chunked.body.length > 0) {
      assert.equal(
        (JSON.parse(chunked.body) as { error: string }).error,
        "payload_too_large",
      );
    }

    // A small body still reaches the router and keeps its own mapping.
    const small = await postWithBody(
      server.port,
      "/api/health",
      Buffer.from("{}"),
    );
    assert.equal(small.status, 405);
    assert.equal(
      (JSON.parse(small.body) as { error: string }).error,
      "method_not_allowed",
    );

    // The unbounded read is what changed: plain GETs are untouched.
    const health = await request(server.port, "/api/health");
    assert.equal(health.status, 200);
  } finally {
    await server.close();
  }
});

test("the token bucket refills at the documented rate and never overspends", () => {
  // Pinned so a change to the production budget is a deliberate edit here.
  assert.equal(RATE_LIMIT_BURST, 300);
  assert.equal(RATE_LIMIT_REFILL_PER_MINUTE, 300);

  let now = 1_000_000;
  const limiter = new ClientRateLimiter({
    burst: 3,
    refillPerMinute: 60, // one token per second
    now: () => now,
  });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(limiter.take("127.0.0.1").allowed, true);
  }
  const limited = limiter.take("127.0.0.1");
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfterSeconds, 1);
  // Budgets are per client: another address still has its own bucket.
  assert.equal(limiter.take("127.0.0.2").allowed, true);

  // A tenth of a second is not a token yet; a full second is.
  now += 100;
  assert.equal(limiter.take("127.0.0.1").allowed, false);
  now += 1_000;
  assert.equal(limiter.take("127.0.0.1").allowed, true);
});

test("the client map stays bounded under a flood of source addresses", () => {
  const maxClients = 4;
  const limiter = new ClientRateLimiter({
    burst: 1,
    refillPerMinute: 1,
    maxClients,
    // Frozen clock: nothing ever refills, so only hard eviction can bound it.
    now: () => 0,
  });

  for (let index = 0; index < maxClients * 8; index += 1) {
    assert.equal(limiter.take(`192.0.2.${index}`).allowed, true);
    assert.ok(limiter.size <= maxClients, `size ${limiter.size} after ${index}`);
  }
  assert.ok(limiter.size <= maxClients);

  // The most recent addresses kept their spent bucket: eviction was oldest-first
  // rather than clearing the whole map.
  assert.equal(limiter.take(`192.0.2.${maxClients * 8 - 1}`).allowed, false);
  assert.ok(limiter.size <= maxClients);

  // The first flooded address was evicted, so it starts over with a full burst.
  assert.equal(limiter.take("192.0.2.0").allowed, true);
  assert.equal(limiter.size, maxClients);
});

test("idle buckets are reclaimed before the oldest live ones", () => {
  let now = 0;
  const limiter = new ClientRateLimiter({
    burst: 1,
    refillPerMinute: 60, // one token per second
    maxClients: 3,
    now: () => now,
  });

  assert.equal(limiter.take("192.0.2.1").allowed, true);
  assert.equal(limiter.take("192.0.2.2").allowed, true);

  // 192.0.2.1 spends its refilled token and is live again at 1500 ms.
  now = 1500;
  assert.equal(limiter.take("192.0.2.1").allowed, true);

  // Reaching the ceiling sweeps 192.0.2.2, which has fully refilled, instead
  // of the older-but-live 192.0.2.1.
  now = 2000;
  assert.equal(limiter.take("192.0.2.3").allowed, true);
  assert.equal(limiter.size, 2);

  // 192.0.2.1 kept its spent bucket: only half a token has refilled since.
  assert.equal(limiter.take("192.0.2.1").allowed, false);
});

test("the rate limiter refuses a burst below one token", () => {
  assert.throws(
    () => new ClientRateLimiter({ burst: 0.5 }),
    /rate limit burst must be at least one token/,
  );
});

test("a flooding client gets 429 with Retry-After and is served after refill", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    rateLimit: { burst: 4, refillPerMinute: 60 },
  });
  try {
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await request(server.port, "/api/health")).status, 200);
    }

    const limited = await request(server.port, "/api/health");
    assert.equal(limited.status, 429);
    // A fixed body and a second-precision hint, both built before routing.
    assert.equal(limited.body, RATE_LIMIT_BODY);
    assert.equal(limited.headers["retry-after"], "1");
    assert.equal(
      limited.headers["content-type"],
      "application/json; charset=utf-8",
    );
    assert.equal(limited.headers["cache-control"], "no-store");
    // No route ran: the body carries no health payload at all.
    assert.doesNotMatch(limited.body, /ok|dbPath|version/);

    // Still limited while the bucket is empty, with the same fixed body.
    const again = await request(server.port, "/api/health");
    assert.equal(again.status, 429);
    assert.equal(again.body, RATE_LIMIT_BODY);

    // One token per second: after a second the client is served again.
    await delay(1_100);
    assert.equal((await request(server.port, "/api/health")).status, 200);
  } finally {
    await server.close();
  }
});

test("the OpenCode theme is read once at server creation, never while serving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observability-theme-"));
  const previousConfig = process.env.OPENCODE_CLI_CONFIG;
  const { path: dbPath } = writeFixtureDb(simpleFixture());
  let first: Awaited<ReturnType<typeof createObservabilityServer>> | undefined;
  let second: Awaited<ReturnType<typeof createObservabilityServer>> | undefined;
  try {
    const configPath = join(dir, "cli.json");
    await writeFile(
      configPath,
      JSON.stringify({ theme: { name: "nightowl", mode: "dark" } }),
      "utf8",
    );
    process.env.OPENCODE_CLI_CONFIG = configPath;
    resetOpenCodeThemeCache();

    first = await createObservabilityServer({ dbPath, port: 0 });
    // The server resolves the theme while it is being created: a fresh process
    // has exactly one config read before any request is served.
    assert.equal(openCodeThemeReadCount(), 1);

    // Rewriting the config cannot change what is reported. Every served request
    // answers from the value stored at creation and reads no file.
    await writeFile(
      configPath,
      JSON.stringify({ theme: { name: "daylight" } }),
      "utf8",
    );
    for (let index = 0; index < 3; index += 1) {
      const health = JSON.parse((await request(first.port, "/api/health")).body);
      assert.deepEqual(health.theme, { name: "nightowl", mode: "dark" });
      assert.equal(openCodeThemeReadCount(), 1);
    }

    // A second server in the same process resolves the same candidate list
    // through the memo: it still reports the theme and adds no file read.
    second = await createObservabilityServer({ dbPath, port: 0 });
    assert.equal(openCodeThemeReadCount(), 1);
    const secondHealth = JSON.parse(
      (await request(second.port, "/api/health")).body,
    );
    assert.deepEqual(secondHealth.theme, { name: "nightowl", mode: "dark" });
    assert.equal(openCodeThemeReadCount(), 1);
  } finally {
    await first?.close();
    await second?.close();
    resetOpenCodeThemeCache();
    if (previousConfig === undefined) delete process.env.OPENCODE_CLI_CONFIG;
    else process.env.OPENCODE_CLI_CONFIG = previousConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unauthenticated oversized upload is refused before it is drained", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const token = "test-token-0123456789abcdef";
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    authToken: token,
  });
  try {
    // If the drain ran first this would be 413; auth answers without reading.
    const refused = await postWithBody(
      server.port,
      "/api/sessions",
      Buffer.alloc(MAX_BODY_BYTES + 1),
    );
    assert.equal(refused.status, 401);
    assert.equal(
      (JSON.parse(refused.body) as { error: string }).error,
      "unauthorized",
    );
    assert.equal(refused.headers["connection"], "close");

    // The same oversized upload with the token is bounded and answered 413.
    const bounded = await postWithBody(
      server.port,
      "/api/sessions",
      Buffer.alloc(MAX_BODY_BYTES + 1),
      false,
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(bounded.status, 413);
    assert.equal(bounded.headers["connection"], "close");

    // Authentication still precedes the reveal policy gate.
    const reveal = await request(server.port, "/api/sessions?reveal=1");
    assert.equal(reveal.status, 401);
  } finally {
    await server.close();
  }
});

test("an aborted upload cannot crash the listener", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  try {
    // A declared body that never finishes keeps the drain waiting; destroying
    // the socket makes the handler resume with a dead response object.
    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await once(socket, "connect");
    socket.write(
      `POST /api/health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 16\r\n\r\nx`,
    );
    await delay(50);
    socket.destroy();
    await delay(150);

    // The listener is still healthy: the aborted request left no uncaught
    // error behind and its in-flight slot was released.
    assert.equal((await request(server.port, "/api/health")).status, 200);
  } finally {
    await server.close();
  }
});

test("the request pipeline ships a last-resort error sink and a headersSent guard", async () => {
  const source = await readFile(
    new URL("../src/server/http.ts", import.meta.url),
    "utf8",
  );
  // A committed response is finished instead of sending a second time.
  assert.match(source, /if \(res\.headersSent\) \{/);
  // A permanent request error sink exists for every request...
  assert.match(source, /req\.on\("error", \(\) => \{\}\)/);
  // ...and the handle promise has no rejection path left open.
  assert.doesNotMatch(source, /void handle\(req, res\)/);
  assert.match(source, /inFlight -= 1/);
  // The drain slot is released on every drain outcome, not only success.
  assert.match(source, /finally\s*\{[^}]*draining -= 1/);
});

test("concurrent body drains are capped so uploads cannot occupy every slot", async () => {
  assert.equal(MAX_CONCURRENT_DRAINS, 4);
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  const sockets: net.Socket[] = [];
  try {
    // Every trickling upload starts a drain (and holds it open) until the cap.
    for (let index = 0; index < MAX_CONCURRENT_DRAINS; index += 1) {
      const socket = net.connect({ host: "127.0.0.1", port: server.port });
      sockets.push(socket);
      await once(socket, "connect");
      socket.write(
        `POST /api/health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 16\r\n\r\nx`,
      );
    }

    // A body-bearing request over the drain cap is refused from the gate: if it
    // were drained it would reach the method gate and answer 405 instead. Each
    // admitted retry releases its slot, so this converges on the saturated state.
    let busy = await postWithBody(
      server.port,
      "/api/health",
      Buffer.from("x".repeat(16)),
    );
    const deadline = Date.now() + 2_000;
    while (busy.status !== 503 && Date.now() < deadline) {
      await delay(50);
      busy = await postWithBody(
        server.port,
        "/api/health",
        Buffer.from("x".repeat(16)),
      );
    }
    assert.equal(busy.status, 503);
    assert.equal((JSON.parse(busy.body) as { error: string }).error, "busy");
    assert.equal(busy.headers["retry-after"], "1");
    assert.equal(busy.headers["connection"], "close");

    // Destroying the trickling uploads releases their slots: a body-bearing
    // request is admitted again and reaches the method gate.
    for (const socket of sockets) socket.destroy();
    await delay(150);
    const admitted = await postWithBody(
      server.port,
      "/api/health",
      Buffer.alloc(16).fill("x".charCodeAt(0)),
    );
    assert.equal(admitted.status, 405);
  } finally {
    for (const socket of sockets) socket.destroy();
    await server.close();
  }
});

test("the in-flight cap answers 503 instead of starting more work", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({ dbPath: path, port: 0 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Uploads can no longer hold every slot (drains are capped), so the handler
  // itself is paused: each stalled call keeps one in-flight slot occupied.
  server.service.listSessions = async () => {
    await gate;
    return [];
  };
  const pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < MAX_IN_FLIGHT_REQUESTS; index += 1) {
      pending.push(request(server.port, "/api/sessions"));
    }
    await delay(200);

    const busy = await request(server.port, "/api/sessions");
    assert.equal(busy.status, 503);
    assert.equal((JSON.parse(busy.body) as { error: string }).error, "busy");
    assert.equal(busy.headers["retry-after"], "1");
  } finally {
    release();
    await Promise.all(pending);
    await server.close();
  }
});

test("static files above the served-file cap answer exactly like missing ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observability-ui-"));
  try {
    const okBody = "console.log('ok');";
    await writeFile(join(dir, "ok.js"), okBody);
    await writeFile(
      join(dir, "huge.js"),
      Buffer.alloc(MAX_SERVED_FILE_BYTES + 1, 0x61),
    );
    const { path } = writeFixtureDb(simpleFixture());
    const server = await createObservabilityServer({
      dbPath: path,
      port: 0,
      uiRoot: dir,
    });
    try {
      const ok = await request(server.port, "/ui/ok.js");
      assert.equal(ok.status, 200);
      assert.equal(ok.body, okBody);
      assert.match(ok.headers["content-type"] ?? "", /javascript/);
      assert.equal(ok.headers["content-length"], String(okBody.length));

      const huge = await request(server.port, "/ui/huge.js");
      const missing = await request(server.port, "/ui/missing.js");
      assert.equal(huge.status, 404);
      assert.equal(missing.status, 404);
      // Existence is not observable: oversized and absent answer identically.
      assert.equal(huge.body, missing.body);
      assert.equal(
        (JSON.parse(huge.body) as { message: string }).message,
        "Static file not found.",
      );
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every shipped UI asset fits under the served-file cap", async () => {
  assert.equal(MAX_SERVED_FILE_BYTES, 8 * 1024 * 1024);
  const root = new URL("../src/ui/", import.meta.url);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  let count = 0;
  let largest = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = await stat(join(entry.parentPath, entry.name));
    count += 1;
    largest = Math.max(largest, info.size);
    assert.ok(
      info.size <= MAX_SERVED_FILE_BYTES,
      `${entry.name} is ${info.size} bytes, above the cap`,
    );
  }
  assert.ok(count > 10, `expected the UI tree, saw ${count} files`);
  // The cap keeps at least 4x headroom over the largest real asset.
  assert.ok(
    MAX_SERVED_FILE_BYTES >= largest * 4,
    `largest asset ${largest} leaves less than 4x headroom`,
  );
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

async function uiFormatSource(): Promise<string> {
  return readFile(new URL("../src/ui/format.js", import.meta.url), "utf8");
}

/**
 * The `catch (error)` block of `handle()`, brace-matched from its opening `{`.
 * Anchored on the handler declaration so the server's other catch blocks (the
 * request-error sink at the end of the file, the file-open path) can never be
 * picked up by mistake.
 */
function handleCatchBlock(source: string): string {
  const handler = source.indexOf("const handle = async (req: IncomingMessage");
  assert.ok(handler >= 0, "handle() not found");
  const catchAt = source.indexOf("} catch (error) {", handler);
  assert.ok(catchAt >= 0, "handle() error catch not found");
  const handlerEnd = source.slice(catchAt).search(/\r?\n {4}\}\r?\n {2}\};/);
  assert.ok(handlerEnd >= 0, "the extracted catch escapes handle()");
  const declarationStart = source.indexOf("catch", catchAt);
  const open = source.indexOf("{", catchAt);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(declarationStart, index + 1);
    }
  }
  assert.fail("unterminated catch block");
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

test("downloadBlob clicks a detached anchor and never inserts it into the document", async () => {
  const downloadBlob = uiFunctionBody(
    await uiFormatSource(),
    "export function downloadBlob(",
  );

  // The blob URL and the checked name are still the only values the anchor
  // receives: the sink is the click, not the attribute writes.
  assert.match(downloadBlob, /const url = URL\.createObjectURL\(blob\)/);
  assert.match(downloadBlob, /anchor\.href = url;/);
  assert.match(downloadBlob, /anchor\.download = safeDownloadName\(filename\)/);

  // The download starts from a detached anchor: the element is clicked but
  // never appended, so there is no DOM-insertion sink left to feed (alert 23).
  assert.match(downloadBlob, /anchor\.click\(\);/);
  assert.doesNotMatch(downloadBlob, /document\.body/);
  assert.doesNotMatch(downloadBlob, /appendChild|\.append\(|insertAdjacent/);
  // Nothing was inserted, so nothing needs removing either.
  assert.doesNotMatch(downloadBlob, /anchor\.remove\(\)/);

  // The revoke keeps today's timing: one 2 s timeout after the click.
  assert.match(
    downloadBlob,
    /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 2_000\);/,
  );
  assert.ok(
    downloadBlob.indexOf("anchor.click()") <
      downloadBlob.indexOf("URL.revokeObjectURL(url)"),
    "the URL must be revoked after the click",
  );
});

test("the format module's only node insertion is the clipboard fallback", async () => {
  const source = await uiFormatSource();

  // The whole module is checked, not one function: a future helper cannot
  // reintroduce markup next to the download path.
  assert.doesNotMatch(source, /insertAdjacent(HTML|Element|Text)/);
  assert.doesNotMatch(source, /\.(inner|outer)HTML\s*=/);

  // Exactly one `appendChild` remains, and it is the execCommand clipboard
  // fallback: its textarea receives the text as a value, never as markup.
  assert.equal([...source.matchAll(/\.appendChild\(/g)].length, 1);
  const copyText = uiFunctionBody(source, "export async function copyText(");
  assert.match(copyText, /document\.body\.appendChild\(area\)/);
  assert.match(copyText, /area\.value = text;/);
});
