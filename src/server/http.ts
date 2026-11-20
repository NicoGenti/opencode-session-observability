import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverDatabase } from "../core/adapters/paths.ts";
import { DatabaseBusyError, UnsupportedSchemaError } from "../core/adapters/sqlite.ts";
import { openWorkerSqliteSource } from "../core/adapters/sqlite-worker-source.ts";
import type { ObservabilitySource } from "../core/types.ts";
import { isAuthorized } from "./auth.ts";
import { readOpenCodeTheme } from "./opencode-theme.ts";
import {
  EpisodeNotFoundError,
  EventNotFoundError,
  ObservabilityService,
  SessionNotFoundError,
} from "../core/service.ts";
import type { EventFilter, EventKind, ExportOptions } from "../core/types.ts";
import {
  BENCHMARK_GROUP_BYS,
  BENCHMARK_OUTCOMES,
  BENCHMARK_TASK_TYPES,
  hasBenchmarkCriteria,
  isBenchmarkGroupBy,
  isBenchmarkOutcome,
  isBenchmarkTaskType,
} from "../core/benchmark.ts";
import type { BenchmarkFilters } from "../core/benchmark.ts";
import {
  DEFAULT_GUARDRAILS,
  GUARDRAIL_MAX,
  evaluateGuardrails,
} from "../core/guardrails.ts";
import type { GuardrailThresholds } from "../core/guardrails.ts";

const UI_ROOT = fileURLToPath(new URL("../ui/", import.meta.url));
const VERSION = "0.1.0";

/**
 * Hard ceiling for one static asset. The largest shipped file is
 * `src/ui/app.js` at ~161 KiB, so 8 MiB keeps roughly 50x headroom for future
 * UI work while a runaway or hostile file can never become an unbounded
 * allocation. The size comes from the file handle's own `stat` before any
 * buffer is allocated, and an oversized file answers exactly like a missing
 * one.
 */
export const MAX_SERVED_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Hard ceiling for a request body. The API is read-only and every action
 * travels in the URL, so no route consumes a payload; the cap still bounds
 * what a client can push at a socket. A declared `Content-Length` is rejected
 * from the header alone, chunked framing is counted as it arrives, and the
 * drain only starts after the Host and token gates accepted the request.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Concurrent requests served at once. This is the throttle that guards every
 * filesystem-backed handler: once it is reached the listener answers 503 with
 * `Retry-After` instead of starting more work. The counter is decremented on
 * every exit path, including failures and aborted connections.
 */
export const MAX_IN_FLIGHT_REQUESTS = 32;

/**
 * Per-client token bucket, checked before routing. Capacity 300 is a burst far
 * above the UI's own traffic (live mode polls at roughly 1-2 requests/second),
 * and the bucket refills at 300 requests/minute (5/second), so interactive use
 * can never drain it while a local loop that hammers the filesystem-backed
 * handlers is answered 429 instead of running unbounded. State is in memory and
 * keyed per remote address.
 */
export const RATE_LIMIT_BURST = 300;
export const RATE_LIMIT_REFILL_PER_MINUTE = 300;

/** Tracked addresses before idle buckets are swept. */
const RATE_LIMIT_MAX_CLIENTS = 1024;

/**
 * The 429 body is a fixed byte string: the limiter runs before routing, so no
 * request-provided value can reach it.
 */
export const RATE_LIMIT_BODY =
  '{"error":"rate_limited","message":"Too many requests. Retry later."}';

/**
 * Node's own request timeout default is five minutes; the listener answers well
 * before that, and the drain deadline below bounds a body that trickles in
 * after its headers were accepted.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A body still streaming after this long is aborted and its socket dropped. */
export const DRAIN_DEADLINE_MS = 10_000;

/**
 * Concurrent body drains. A drain ties up an in-flight slot until the body
 * settles, so unauthenticated trickling uploads are bounded to a small number
 * before they can starve interactive traffic of its slots.
 */
export const MAX_CONCURRENT_DRAINS = 4;

/**
 * `/api/sessions/{id}/diagnostics`. Exported so tests build requests from the
 * same shape the router matches instead of re-typing the pattern.
 */
export const SESSION_DIAGNOSTICS_PATTERN =
  /^\/api\/sessions\/([^/]+)\/diagnostics$/;

/** `/api/sessions/{id}/family-recovery`, shared with the tests that call it. */
export const SESSION_FAMILY_RECOVERY_PATTERN =
  /^\/api\/sessions\/([^/]+)\/family-recovery$/;

/** `/api/sessions/{id}/live`, shared with the tests that call it. */
export const SESSION_LIVE_PATTERN = /^\/api\/sessions\/([^/]+)\/live$/;

/** Episode comparison endpoint, shared with the tests that call it. */
export const EPISODE_COMPARE_PATH = "/api/episodes/compare";

/** Cross-session benchmark endpoint, shared with the tests that call it. */
export const BENCHMARK_PATH = "/api/benchmark";

export interface ServerOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  allowReveal?: boolean;
  /** When set, every /api route except /api/health requires this token. */
  authToken?: string;
  uiRoot?: string;
  /**
   * Test hook: overrides this instance's per-client bucket. Production always
   * uses `RATE_LIMIT_BURST` / `RATE_LIMIT_REFILL_PER_MINUTE`.
   */
  rateLimit?: { burst?: number; refillPerMinute?: number };
}

export interface RunningServer {
  server: Server;
  url: string;
  host: string;
  port: number;
  dbPath: string;
  source: ObservabilitySource;
  service: ObservabilityService;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function securityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * True when the request declares a body through either HTTP/1.1 framing
 * header. No route reads a payload, but a declared body still has to be
 * bounded before the router can ignore it.
 */
function declaresBody(req: IncomingMessage): boolean {
  return (
    req.headers["content-length"] !== undefined ||
    req.headers["transfer-encoding"] !== undefined
  );
}

/**
 * Consumes a declared request body under `limit` and discards it. The declared
 * `Content-Length` is rejected before a single byte is buffered, and a chunked
 * body is counted as it arrives; crossing either bound stops the read and the
 * caller answers 413 with `Connection: close`. A body still streaming when
 * `deadlineMs` elapses is aborted: the socket is destroyed and the caller
 * sends nothing. Nothing accumulates past `limit`, which is the point: the
 * entry point owns the bound even though no route consumes the bytes.
 *
 * Request errors are sunk twice on purpose. One listener settles this promise
 * and is removed with it; a second, permanent no-op listener keeps a late
 * reset (after the response, while the socket closes) from surfacing as an
 * uncaught exception.
 */
function drainBody(
  req: IncomingMessage,
  limit: number,
  deadlineMs: number,
): Promise<"ok" | "too_large" | "timeout"> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      resolve("too_large");
      return;
    }
    let total = 0;
    let settled = false;
    const deadline = setTimeout(() => {
      // Stop reading and drop the connection: trickling bytes cannot hold a
      // socket or this handler open indefinitely.
      req.destroy();
      settle("timeout");
    }, deadlineMs);
    deadline.unref();
    function settle(result: "ok" | "too_large" | "timeout"): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      resolve(result);
    }
    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > limit) {
        req.pause();
        settle("too_large");
      }
    }
    function onEnd(): void {
      settle("ok");
    }
    // A client that aborts mid-body leaves nothing left to bound.
    function onError(): void {
      settle("ok");
    }
    // Permanent sink, never removed by settle(): see the doc comment above.
    req.on("error", () => {});
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

export interface RateLimiterOptions {
  /** Tokens a fresh client may spend at once. */
  burst?: number;
  /** Tokens added per minute, spread evenly over the minute. */
  refillPerMinute?: number;
  /** Injectable clock, used by the tests. */
  now?: () => number;
  /** Tracked addresses before idle buckets are swept. */
  maxClients?: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds a limited client should wait before retrying. */
  retryAfterSeconds: number;
}

/**
 * In-process token bucket, keyed by remote address and consulted before
 * routing. It is deliberately generous (see `RATE_LIMIT_BURST` and
 * `RATE_LIMIT_REFILL_PER_MINUTE`): the real UI never notices it, while a local
 * loop cannot drive the filesystem-backed handlers without bound.
 */
export class ClientRateLimiter {
  readonly #burst: number;
  readonly #refillPerMs: number;
  readonly #maxClients: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: RateLimiterOptions = {}) {
    this.#burst = options.burst ?? RATE_LIMIT_BURST;
    const refillPerMinute = options.refillPerMinute ?? RATE_LIMIT_REFILL_PER_MINUTE;
    this.#refillPerMs = refillPerMinute / 60_000;
    this.#maxClients = options.maxClients ?? RATE_LIMIT_MAX_CLIENTS;
    this.#now = options.now ?? Date.now;
    if (!Number.isFinite(this.#burst) || this.#burst <= 0) {
      throw new Error("rate limit burst must be a positive number");
    }
    if (!Number.isFinite(this.#refillPerMs) || this.#refillPerMs <= 0) {
      throw new Error("rate limit refill must be a positive number");
    }
  }

  take(key: string): RateLimitVerdict {
    const now = this.#now();
    const stored = this.#buckets.get(key);
    const available =
      stored === undefined
        ? this.#burst
        : Math.min(
            this.#burst,
            stored.tokens + (now - stored.updatedAt) * this.#refillPerMs,
          );
    if (available < 1) {
      this.#buckets.set(key, { tokens: available, updatedAt: now });
      // Whole seconds, at least one: `Retry-After` has second precision.
      const waitMs = (1 - available) / this.#refillPerMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
    this.#buckets.set(key, { tokens: available - 1, updatedAt: now });
    this.#sweep(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Drops buckets that have refilled completely; they behave exactly like a
   * fresh entry, so removing them costs nothing. A bounded map is what keeps
   * the limiter itself out of the resource story.
   */
  #sweep(now: number): void {
    if (this.#buckets.size < this.#maxClients) return;
    for (const [key, bucket] of this.#buckets) {
      const tokens = bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs;
      if (tokens >= this.#burst) this.#buckets.delete(key);
    }
  }
}

/**
 * IPv4-mapped IPv6 addresses key the same bucket as their IPv4 form, so a
 * client cannot double its budget by alternating representations.
 */
function clientKey(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
}

/**
 * Rejects requests whose Host/Origin do not belong to this listener. Without
 * this, a page that DNS-rebinds its own hostname to 127.0.0.1 is treated as
 * same-origin and can read the API.
 */
function requestAllowed(
  req: IncomingMessage,
  bindHost: string,
  port: number,
): boolean {
  const hostHeader = req.headers.host?.toLowerCase();
  if (!hostHeader) return false;
  const authorities = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  const bind = bindHost.toLowerCase();
  if (
    bind &&
    bind !== "0.0.0.0" &&
    bind !== "::" &&
    bind !== "127.0.0.1" &&
    bind !== "::1" &&
    bind !== "localhost"
  ) {
    authorities.add(`${bind}:${port}`);
  }
  const local = (req.socket.localAddress ?? "").toLowerCase();
  if (local) {
    const bare = local.startsWith("::ffff:") ? local.slice(7) : local;
    authorities.add(`${bare}:${port}`);
    authorities.add(`[${bare}]:${port}`);
  }
  if (!authorities.has(hostHeader)) return false;

  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") {
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    try {
      if (!authorities.has(new URL(origin).host.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function bool(search: URLSearchParams, name: string): boolean {
  const value = search.get(name);
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function numberParam(search: URLSearchParams, name: string): number | undefined {
  const raw = search.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function listParams(search: URLSearchParams, ...names: string[]): string[] | undefined {
  const values: string[] = [];
  for (const name of names) {
    for (const raw of search.getAll(name)) {
      for (const part of raw.split(",")) {
        const value = part.trim();
        if (value.length > 0) values.push(value);
      }
    }
  }
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function filterFromSearch(search: URLSearchParams): EventFilter {
  return {
    q: search.get("q")?.trim() || undefined,
    kinds: listParams(search, "kind", "kinds") as EventKind[] | undefined,
    agents: listParams(search, "agent", "agents"),
    models: listParams(search, "model", "models"),
    providers: listParams(search, "provider", "providers"),
    tools: listParams(search, "tool", "tools"),
    statuses: listParams(search, "status", "statuses"),
    errorsOnly: bool(search, "errors") || bool(search, "errorsOnly"),
    retriesOnly: bool(search, "retries") || bool(search, "retriesOnly"),
    compactionsOnly: bool(search, "compactions") || bool(search, "compactionsOnly"),
    subagentsOnly: bool(search, "subagents") || bool(search, "subagentsOnly"),
    contextOnly: bool(search, "context") || bool(search, "contextOnly"),
    from: numberParam(search, "from"),
    to: numberParam(search, "to"),
    minPromptTokens: numberParam(search, "minPromptTokens"),
    maxPromptTokens: numberParam(search, "maxPromptTokens"),
  };
}

/** Longest benchmark filter value echoed back by a validation error. */
const MAX_FILTER_PARAM_LENGTH = 120;

/**
 * A trimmed benchmark string parameter. Values are length-capped so a hostile
 * query cannot grow the response, and an empty value means "not set".
 */
function trimmedParam(
  search: URLSearchParams,
  name: string,
): string | undefined {
  const raw = search.get(name);
  if (raw === null) return undefined;
  const value = raw.trim().slice(0, MAX_FILTER_PARAM_LENGTH);
  return value.length > 0 ? value : undefined;
}

/**
 * A numeric parameter that distinguishes "absent" from "present but not a
 * number", so the benchmark route can answer 400 instead of silently dropping
 * a malformed bound.
 */
function numericParam(
  search: URLSearchParams,
  name: string,
): { value?: number; invalid: boolean } {
  const raw = search.get(name);
  if (raw === null || raw.trim() === "") return { invalid: false };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { invalid: true };
  return { value, invalid: false };
}

/**
 * The closed `gr.*` vocabulary: one bounded budget per query parameter. The
 * bounds come from `GUARDRAIL_MAX`, the same table the browser panel mirrors.
 */
const GUARDRAIL_PARAM_SPECS: ReadonlyArray<{
  name: string;
  key: keyof GuardrailThresholds;
}> = [
  { name: "tokensTotal", key: "tokensTotal" },
  { name: "costTotal", key: "costTotal" },
  { name: "contextRun", key: "contextRun" },
  { name: "retries", key: "retries" },
  { name: "toolFailures", key: "toolFailures" },
  { name: "elapsedMinutes", key: "elapsedMinutes" },
];

/** Count budgets are whole numbers; cost and elapsed minutes may be fractional. */
const GUARDRAIL_INTEGER_KEYS: ReadonlySet<string> = new Set([
  "tokensTotal",
  "contextRun",
  "retries",
  "toolFailures",
]);

/** Plain decimal only: `0x10`, `1e3`, `+5` and `" 12 "` are all rejected. */
const GUARDRAIL_NUMBER_PATTERN = /^\d+(\.\d+)?$/;

/** The accepted budget parameters, exported so tests and docs stay in sync. */
export const GUARDRAIL_PARAM_NAMES: readonly string[] = Object.freeze(
  GUARDRAIL_PARAM_SPECS.map((spec) => `gr.${spec.name}`),
);

interface GuardrailQuery {
  /** At least one known `gr.*` parameter was present. */
  present: boolean;
  /** A present parameter was empty, duplicated, malformed or out of bounds. */
  invalid: boolean;
  /** Present values over the defaults; absent keys keep the default. */
  thresholds: GuardrailThresholds;
}

/**
 * Reads the browser-owned guardrail budgets. The vocabulary is closed: an
 * unknown `gr.*` key is invalid instead of silently ignored, a key repeated in
 * the query is invalid instead of "first one wins", and every present value
 * must be a plain decimal inside its documented bound (and a whole number for
 * the count budgets). Absent keys fall back to `DEFAULT_GUARDRAILS`, so the
 * evaluator stays stateless and the route is still a pure function of the query.
 */
function guardrailQuery(search: URLSearchParams): GuardrailQuery {
  const thresholds: GuardrailThresholds = { ...DEFAULT_GUARDRAILS };
  const seen = new Set<string>();
  let present = false;
  for (const key of search.keys()) {
    if (!key.startsWith("gr.")) continue;
    present = true;
    if (seen.has(key)) return { present, invalid: true, thresholds };
    seen.add(key);
    const name = key.slice("gr.".length);
    const spec = GUARDRAIL_PARAM_SPECS.find((entry) => entry.name === name);
    if (!spec) return { present, invalid: true, thresholds };
    const values = search.getAll(key);
    // Exactly one value per key: a duplicate is ambiguous, never "first wins".
    if (values.length !== 1) return { present, invalid: true, thresholds };
    const raw = values[0] ?? "";
    if (!GUARDRAIL_NUMBER_PATTERN.test(raw)) {
      return { present, invalid: true, thresholds };
    }
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > GUARDRAIL_MAX[spec.key]
    ) {
      return { present, invalid: true, thresholds };
    }
    if (GUARDRAIL_INTEGER_KEYS.has(spec.key) && !Number.isInteger(value)) {
      return { present, invalid: true, thresholds };
    }
    thresholds[spec.key] = value;
  }
  return { present, invalid: false, thresholds };
}

interface CompareQuery {
  leftSessionID: string;
  leftEpisodeID: string;
  rightSessionID: string;
  rightEpisodeID: string;
}

const COMPARE_REQUIRED_PARAMS = [
  "leftSession",
  "leftEpisode",
  "rightSession",
  "rightEpisode",
] as const;

/**
 * Reads the four required comparison parameters. Returns null when one is
 * absent or empty; `decodeURIComponent` is strict, so a malformed sequence
 * throws `URIError` and the route answers with a stable 400 instead of a 500.
 * A single encoding is already undone by `URLSearchParams`; the second decode
 * only matters for ids a client encoded by hand with `encodeURIComponent`.
 */
function compareQuery(search: URLSearchParams): CompareQuery | null {
  const values: string[] = [];
  for (const name of COMPARE_REQUIRED_PARAMS) {
    const raw = search.get(name);
    if (raw === null || raw === "") return null;
    values.push(decodeURIComponent(raw));
  }
  const [leftSessionID, leftEpisodeID, rightSessionID, rightEpisodeID] = values;
  if (!leftSessionID || !leftEpisodeID || !rightSessionID || !rightEpisodeID) {
    return null;
  }
  return { leftSessionID, leftEpisodeID, rightSessionID, rightEpisodeID };
}

export async function createObservabilityServer(
  options: ServerOptions = {},
): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  if (host.trim() === "") throw new Error("host must not be empty");
  const authToken =
    options.authToken === undefined ? undefined : options.authToken.trim();
  if (options.authToken !== undefined && authToken === "") {
    throw new Error("authToken must not be empty");
  }
  const authRequired = authToken !== undefined;
  const loopback =
    host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !authRequired) {
    throw new Error("non-loopback hosts require authToken");
  }
  const port = options.port ?? 4517;
  const allowReveal = options.allowReveal === true;
  const uiRoot = resolve(options.uiRoot ?? UI_ROOT);
  // The CLI theme is process-static: it is resolved here, before the http
  // server exists, so no request handler ever reads a config file. /api/health
  // serves this value from the closure.
  const theme = readOpenCodeTheme();
  const dbPath = options.dbPath ?? discoverDatabase().path;
  const source = openWorkerSqliteSource(dbPath);
  try {
    await source.ready();
  } catch (error) {
    source.close();
    throw error;
  }
  const service = new ObservabilityService(source);
  let boundPort = port;
  // Bodies currently being drained. Bounded by MAX_CONCURRENT_DRAINS so a few
  // slow uploads cannot occupy the in-flight slots interactive requests need.
  let draining = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Gate order matters: a request that fails a cheap check is answered
      // before any body work, so an unauthenticated or forged upload never
      // holds a socket or a handler.
      //
      // (a) The request target. The base only resolves origin-form request
      // targets; it must be a syntactically valid authority even when --host
      // is an IPv6 literal.
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const path = decodeURIComponent(requestUrl.pathname);
      if (path.includes("\0")) {
        sendJson(req, res, 400, {
          error: "invalid_path",
          message: "Malformed request path.",
        });
        return;
      }
      // (b) Host/Origin allowlist, before the router can act on the path.
      if (!requestAllowed(req, host, boundPort)) {
        sendJson(req, res, 403, {
          error: "forbidden_host",
          message: "Request host is not allowed.",
        });
        return;
      }
      const bodyBearing = declaresBody(req);
      // (c) A request without a body can be refused from its method alone. One
      // that frames a body keeps its answer until the bytes are bounded below,
      // which is what preserves the existing 405/413 mappings.
      if (!bodyBearing && req.method !== "GET" && req.method !== "HEAD") {
        sendJson(req, res, 405, {
          error: "method_not_allowed",
          message: "Only GET and HEAD are supported.",
        });
        return;
      }
      const search = requestUrl.searchParams;
      // (d) Authentication, before any body work: an unauthenticated upload is
      // answered 401 and the connection closes without the payload being read.
      if (
        authToken !== undefined &&
        path.startsWith("/api/") &&
        path !== "/api/health" &&
        !isAuthorized(req, authToken)
      ) {
        sendJson(
          req,
          res,
          401,
          {
            error: "unauthorized",
            message: "A valid access token is required.",
          },
          {
            "WWW-Authenticate": 'Bearer realm="opencode-observability"',
            ...(bodyBearing ? { Connection: "close" } : {}),
          },
        );
        return;
      }
      // (e) The declared body is bounded here, after the gates that can reject
      // the request without consuming it. Only an /api target can consume a
      // payload, so a body sent to a static path is never drained: it is
      // refused by the method gate below and its socket closed.
      if (bodyBearing && path.startsWith("/api/")) {
        // A drain holds an in-flight slot until its body settles. Refusing the
        // over-cap request before the counter moves keeps the refusal cheap and
        // indistinguishable from the in-flight 503.
        if (draining >= MAX_CONCURRENT_DRAINS) {
          sendJson(
            req,
            res,
            503,
            { error: "busy", message: "Too many concurrent requests." },
            { "Retry-After": "1" },
          );
          return;
        }
        draining += 1;
        try {
          const verdict = await drainBody(
            req,
            MAX_BODY_BYTES,
            DRAIN_DEADLINE_MS,
          );
          if (verdict === "timeout") return; // the deadline destroyed the socket
          if (verdict === "too_large") {
            sendJson(
              req,
              res,
              413,
              {
                error: "payload_too_large",
                message: "Request body is too large.",
              },
              { Connection: "close" },
            );
            return;
          }
        } finally {
          // Every outcome (ok / too_large / timeout / aborted socket) releases
          // the drain slot, including the early returns above.
          draining -= 1;
        }
      }
      // (f) A body-bearing request reaches the method gate only after its body
      // is bounded, so 413 keeps priority over 405 exactly as before.
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(
          req,
          res,
          405,
          {
            error: "method_not_allowed",
            message: "Only GET and HEAD are supported.",
          },
          bodyBearing ? { Connection: "close" } : {},
        );
        return;
      }
      const revealRequested = bool(search, "reveal");
      if (revealRequested && !allowReveal) {
        sendJson(req, res, 403, {
          error: "reveal_disabled",
          message: "Raw payload reveal is disabled by the server configuration.",
        });
        return;
      }
      const reveal = revealRequested && allowReveal;
      // `?refresh=1` drops the dataset cache for the routes that own a manual
      // refresh. The live route is polled and keeps requestKey coherence
      // (session.time.updated) on its own, and the benchmark loads its own
      // bounded working set, so both are excluded from the per-request flush.
      if (
        !SESSION_LIVE_PATTERN.test(path) &&
        path !== BENCHMARK_PATH &&
        bool(search, "refresh")
      ) {
        service.clearCache();
      }

      if (path === "/api/health") {
        sendJson(req, res, 200, {
          ok: true,
          name: "opencode-session-observability",
          version: VERSION,
          source: service.describe(),
          dbPath: basename(dbPath),
          revealAllowed: allowReveal,
          authRequired,
          readOnly: true,
          // Resolved once in createObservabilityServer; serving a request never
          // touches the CLI config.
          theme,
        });
        return;
      }

      if (path === "/api/sessions") {
        const sessions = await service.listSessions({
          query: search.get("q") ?? undefined,
          limit: numberParam(search, "limit") ?? 200,
          reveal,
        });
        sendJson(req, res, 200, { sessions, revealAllowed: allowReveal });
        return;
      }

      let match = /^\/api\/sessions\/([^/]+)$/.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const data = await service.getSession(sessionID, { reveal });
        sendJson(req, res, 200, { ...data, revealAllowed: allowReveal });
        return;
      }

      match = /^\/api\/sessions\/([^/]+)\/analysis$/.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const fromSeq = numberParam(search, "fromSeq");
        const toSeq = numberParam(search, "toSeq");
        const guardrails = guardrailQuery(search);
        if (guardrails.invalid) {
          sendJson(req, res, 400, {
            error: "invalid_guardrails",
            message:
              "Guardrail budgets must be finite, non-negative numbers inside their documented bounds, and only the documented gr.* keys are accepted.",
          });
          return;
        }
        const { analysis } = await service.analyze(sessionID, {
          fromSeq,
          toSeq,
          reveal,
          windowed: fromSeq !== undefined || toSeq !== undefined,
        });
        // A route-level sibling, never an `Analysis` field: exports and the
        // plugin RPC keep their shape and `analysis.health` stays authoritative.
        if (guardrails.present) {
          const evaluated = evaluateGuardrails(analysis, guardrails.thresholds);
          sendJson(req, res, 200, {
            analysis,
            guardrails: evaluated,
            revealAllowed: allowReveal,
          });
          return;
        }
        sendJson(req, res, 200, { analysis, revealAllowed: allowReveal });
        return;
      }

      match = SESSION_DIAGNOSTICS_PATTERN.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const data = await service.diagnostics(sessionID, { reveal });
        sendJson(req, res, 200, { ...data, revealAllowed: allowReveal });
        return;
      }

      match = SESSION_FAMILY_RECOVERY_PATTERN.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const recovery = await service.familyRecovery(sessionID, { reveal });
        sendJson(req, res, 200, { recovery, revealAllowed: allowReveal });
        return;
      }

      match = /^\/api\/sessions\/([^/]+)\/events\/(.+)$/.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const eventID = match[2]!;
        const event = await service.eventDetail(sessionID, eventID, { reveal });
        sendJson(req, res, 200, { event, revealAllowed: allowReveal });
        return;
      }

      match = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const direction =
          search.get("direction") === "forward" ? "forward" : "backward";
        const page = await service.events({
          sessionID,
          ...filterFromSearch(search),
          limit: numberParam(search, "limit") ?? 240,
          before: search.get("before") ?? undefined,
          after: search.get("after") ?? undefined,
          around: search.get("around") ?? undefined,
          direction,
          reveal,
        });
        sendJson(req, res, 200, { ...page, revealAllowed: allowReveal });
        return;
      }

      match = SESSION_LIVE_PATTERN.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const since = search.get("since");
        const snapshot = await service.liveSnapshot(sessionID, {
          reveal,
          lastTurns: numberParam(search, "lastTurns"),
          since: since === null || since === "" ? undefined : since,
        });
        sendJson(req, res, 200, { ...snapshot, revealAllowed: allowReveal });
        return;
      }

      match = /^\/api\/sessions\/([^/]+)\/export$/.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const formatRaw = (search.get("format") ?? "json").toLowerCase();
        if (
          formatRaw !== "json" &&
          formatRaw !== "markdown" &&
          formatRaw !== "html" &&
          formatRaw !== "digest"
        ) {
          sendJson(req, res, 400, {
            error: "invalid_format",
            message: "format must be json, markdown, html or digest",
          });
          return;
        }
        const options: ExportOptions = {
          format: formatRaw,
          reveal,
          includeEvents: search.get("includeEvents") !== "0",
          prompt: bool(search, "prompt"),
        };
        const result = await service.export(sessionID, options);
        sendText(req, res, 200, result.content, result.mime, {
          "Content-Disposition": `attachment; filename="${result.filename.replaceAll('"', "")}"`,
          "X-Observability-Redacted": String(result.redacted),
        });
        return;
      }

      if (path === EPISODE_COMPARE_PATH) {
        let query: CompareQuery | null;
        try {
          query = compareQuery(search);
        } catch {
          sendJson(req, res, 400, {
            error: "invalid_query",
            message: "Malformed query string.",
          });
          return;
        }
        if (!query) {
          sendJson(req, res, 400, {
            error: "invalid_query",
            message:
              "leftSession, leftEpisode, rightSession and rightEpisode are required.",
          });
          return;
        }
        const comparison = await service.compareEpisodes({ ...query, reveal });
        sendJson(req, res, 200, { comparison, revealAllowed: allowReveal });
        return;
      }

      if (path === BENCHMARK_PATH) {
        // Filters are explicit user-supplied criteria, so no search oracle is
        // involved; a parameter that is present but malformed is a 400 rather
        // than a silently empty comparison.
        const groupBy = trimmedParam(search, "groupBy");
        if (groupBy !== undefined && !isBenchmarkGroupBy(groupBy)) {
          sendJson(req, res, 400, {
            error: "invalid_group_by",
            message: `groupBy must be one of ${BENCHMARK_GROUP_BYS.join(", ")}.`,
          });
          return;
        }
        const from = numericParam(search, "from");
        const to = numericParam(search, "to");
        if (from.invalid || to.invalid) {
          sendJson(req, res, 400, {
            error: "invalid_filters",
            message: "from and to must be finite epoch milliseconds.",
          });
          return;
        }
        // `outcome` is documented as case-insensitive, so the closed vocabulary
        // is matched on the folded value; the echoed message keeps the canonical
        // spellings.
        const outcomeParam = trimmedParam(search, "outcome");
        const outcome =
          outcomeParam === undefined ? undefined : outcomeParam.toLowerCase();
        if (outcome !== undefined && !isBenchmarkOutcome(outcome)) {
          sendJson(req, res, 400, {
            error: "invalid_filters",
            message: `outcome must be one of ${BENCHMARK_OUTCOMES.join(", ")}.`,
          });
          return;
        }
        const taskType = trimmedParam(search, "taskType");
        if (taskType !== undefined && !isBenchmarkTaskType(taskType)) {
          sendJson(req, res, 400, {
            error: "invalid_filters",
            message: `taskType must be one of ${BENCHMARK_TASK_TYPES.join(", ")}.`,
          });
          return;
        }
        const filters: BenchmarkFilters = {
          from: from.value,
          to: to.value,
          model: trimmedParam(search, "model"),
          provider: trimmedParam(search, "provider"),
          agent: trimmedParam(search, "agent"),
          directory: trimmedParam(search, "directory"),
          outcome,
          taskType,
          groupBy,
        };
        if (!hasBenchmarkCriteria(filters)) {
          sendJson(req, res, 400, {
            error: "invalid_filters",
            message:
              "At least one filter is required: from, to, model, provider, agent, directory, outcome or taskType.",
          });
          return;
        }
        const benchmark = await service.benchmark(filters, { reveal });
        sendJson(req, res, 200, { benchmark, revealAllowed: allowReveal });
        return;
      }

      if (path === "/" || path === "/index.html") {
        await serveFile(req, res, join(uiRoot, "index.html"));
        return;
      }

      if (path.startsWith("/ui/")) {
        const relative = path.slice("/ui/".length);
        const safe = normalize(relative).replace(/^([/\\])+/, "");
        const target = resolve(uiRoot, safe);
        if (!target.startsWith(uiRoot + sep) && target !== uiRoot) {
          sendJson(req, res, 403, {
            error: "forbidden",
            message: "Path escapes the UI root.",
          });
          return;
        }
        await serveFile(req, res, target);
        return;
      }

      if (path === "/favicon.ico") {
        res.statusCode = 204;
        res.end();
        return;
      }

      sendJson(req, res, 404, {
        error: "not_found",
        // Fixed text: the request path is attacker-controlled and must never
        // travel into a response body.
        message: "No route for this request.",
      });
    } catch (error) {
      // A response may already be partly committed when a later stage fails; a
      // second send would throw ERR_HTTP_HEADERS_SENT and take the process down,
      // so an already-committed response is simply finished.
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // The socket is already gone.
        }
        return;
      }
      // Identity-only mapping, inlined into this catch scope so the caught
      // exception is consumed by the `instanceof` chain and by nothing else:
      // each branch hands `sendJson` a status number plus a literal body, never
      // the exception or anything derived from it. The order below is the
      // documented status contract.
      if (error instanceof SessionNotFoundError) {
        sendJson(req, res, 404, {
          error: "session_not_found",
          message: "Session not found.",
        });
      } else if (error instanceof EventNotFoundError) {
        sendJson(req, res, 404, {
          error: "event_not_found",
          message: "Event not found.",
        });
      } else if (error instanceof EpisodeNotFoundError) {
        sendJson(req, res, 404, {
          error: "episode_not_found",
          message: "Episode not found.",
        });
      } else if (error instanceof DatabaseBusyError) {
        sendJson(req, res, 503, {
          error: "database_busy",
          message:
            "The OpenCode database is locked. Retry when the session is idle.",
        });
      } else if (error instanceof UnsupportedSchemaError) {
        sendJson(req, res, 500, {
          error: "unsupported_schema",
          message: "The database schema is not supported by this build.",
        });
      } else if (error instanceof URIError) {
        sendJson(req, res, 400, {
          error: "invalid_path",
          message: "Malformed request path.",
        });
      } else if (error instanceof SyntaxError) {
        sendJson(req, res, 400, {
          error: "invalid_query",
          message: "Invalid request.",
        });
      } else {
        // Never reflect raw exception messages: they can embed absolute paths.
        sendJson(req, res, 500, {
          error: "internal_error",
          message: "Internal error.",
        });
      }
    }
  };

  let inFlight = 0;
  const limiter = new ClientRateLimiter(options.rateLimit);
  const server = createServer((req, res) => {
    // A request error has no default listener. Sink it for every request before
    // anything else, so a reset (a client aborting an upload, or a socket
    // closed after a 401/413) can never become an uncaught exception. This
    // listener is intentionally permanent.
    req.on("error", () => {});
    // The per-client budget is checked before routing: a flood never reaches a
    // filesystem-backed handler.
    const budget = limiter.take(clientKey(req));
    if (!budget.allowed) {
      sendText(
        req,
        res,
        429,
        RATE_LIMIT_BODY,
        "application/json; charset=utf-8",
        {
          "Retry-After": String(budget.retryAfterSeconds),
          ...(declaresBody(req) ? { Connection: "close" } : {}),
        },
      );
      return;
    }
    if (inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      sendJson(
        req,
        res,
        503,
        { error: "busy", message: "Too many concurrent requests." },
        { "Retry-After": "1" },
      );
      return;
    }
    inFlight++;
    // No rejection may escape: handle() maps its own errors, a failure after
    // the response was committed is absorbed by the headersSent guard, and the
    // stderr write is best-effort. The counter is decremented on every path.
    void (async () => {
      try {
        await handle(req, res);
      } catch (error) {
        try {
          process.stderr.write(
            `opencode-observability: request failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        } catch {
          // A failing log sink must not become a crash either.
        }
      } finally {
        inFlight -= 1;
      }
    })();
  });
  // Explicit bound instead of Node's five-minute default.
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : port;
  boundPort = actualPort;
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    server,
    url: `http://${displayHost}:${actualPort}`,
    host,
    port: actualPort,
    dbPath,
    source,
    service,
    close: async () => {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
      source.close();
    },
  };
}

/**
 * Serves one static file under `MAX_SERVED_FILE_BYTES`. The size is read from
 * the handle's own `stat` before any buffer is allocated, and the read stops
 * at that size, so the allocation is bounded by the cap even if the file grows
 * between the stat and the read. An oversized file is answered exactly like a
 * missing one: the response never reveals whether it exists.
 */
async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SERVED_FILE_BYTES) {
        sendJson(req, res, 404, {
          error: "not_found",
          message: "Static file not found.",
        });
        return;
      }
      const body = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead } = await handle.read(
          body,
          offset,
          body.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      securityHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[extname(path).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Length", String(offset));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(offset === body.length ? body : body.subarray(0, offset));
    } finally {
      // A close failure is not a request failure: the bytes were already sent.
      try {
        await handle.close();
      } catch {
        // Nothing left to release.
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      sendJson(req, res, 404, {
        error: "not_found",
        message: "Static file not found.",
      });
      return;
    }
    throw error;
  }
}
