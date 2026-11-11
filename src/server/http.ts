import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { discoverDatabase } from "../core/adapters/paths.ts";
import { DatabaseBusyError, UnsupportedSchemaError } from "../core/adapters/sqlite.ts";
import { openWorkerSqliteSource } from "../core/adapters/sqlite-worker-source.ts";
import type { ObservabilitySource } from "../core/types.ts";
import { isAuthorized } from "./auth.ts";
import { PACKAGE_ROOT, readPackageVersion } from "./package-root.ts";
import { readOpenCodeTheme } from "./opencode-theme.ts";
import {
  EpisodeNotFoundError,
  EventNotFoundError,
  ObservabilityService,
  SessionNotFoundError,
} from "../core/service.ts";
import type { EventFilter, EventKind, ExportOptions } from "../core/types.ts";

// The UI is shipped as `src/ui` (see the package `files` entry) and is not
// emitted into `dist`, so resolve it from the package root instead of from
// this module's directory; that keeps both the src and dist layouts correct.
const UI_ROOT = join(PACKAGE_ROOT, "src", "ui");
const VERSION = readPackageVersion();

/**
 * `/api/sessions/{id}/diagnostics`. Exported so tests build requests from the
 * same shape the router matches instead of re-typing the pattern.
 */
export const SESSION_DIAGNOSTICS_PATTERN =
  /^\/api\/sessions\/([^/]+)\/diagnostics$/;

/** `/api/sessions/{id}/family-recovery`, shared with the tests that call it. */
export const SESSION_FAMILY_RECOVERY_PATTERN =
  /^\/api\/sessions\/([^/]+)\/family-recovery$/;

/** Episode comparison endpoint, shared with the tests that call it. */
export const EPISODE_COMPARE_PATH = "/api/episodes/compare";

export interface ServerOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  allowReveal?: boolean;
  /** When set, every /api route except /api/health requires this token. */
  authToken?: string;
  uiRoot?: string;
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

function errorBody(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof SessionNotFoundError) {
    return { status: 404, code: "session_not_found", message: error.message };
  }
  if (error instanceof EventNotFoundError) {
    return { status: 404, code: "event_not_found", message: error.message };
  }
  if (error instanceof EpisodeNotFoundError) {
    return { status: 404, code: "episode_not_found", message: error.message };
  }
  if (error instanceof DatabaseBusyError) {
    return {
      status: 503,
      code: "database_busy",
      message: "The OpenCode database is locked. Retry when the session is idle.",
    };
  }
  if (error instanceof UnsupportedSchemaError) {
    return { status: 500, code: "unsupported_schema", message: error.message };
  }
  if (error instanceof URIError) {
    return { status: 400, code: "invalid_path", message: "Malformed request path." };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, code: "invalid_query", message: "Invalid request." };
  }
  // Never reflect raw exception messages: they can embed absolute paths.
  return { status: 500, code: "internal_error", message: "Internal error." };
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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!requestAllowed(req, host, boundPort)) {
        sendJson(req, res, 403, {
          error: "forbidden_host",
          message: "Request host is not allowed.",
        });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(req, res, 405, {
          error: "method_not_allowed",
          message: "Only GET and HEAD are supported.",
        });
        return;
      }
      // The base only resolves origin-form request targets; it must be a
      // syntactically valid authority even when --host is an IPv6 literal.
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const path = decodeURIComponent(requestUrl.pathname);
      if (path.includes("\0")) {
        sendJson(req, res, 400, {
          error: "invalid_path",
          message: "Malformed request path.",
        });
        return;
      }
      const search = requestUrl.searchParams;
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
          { "WWW-Authenticate": 'Bearer realm="opencode-observability"' },
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
      if (bool(search, "refresh")) service.clearCache();

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
          theme: readOpenCodeTheme(),
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
        const { analysis } = await service.analyze(sessionID, {
          fromSeq,
          toSeq,
          reveal,
          windowed: fromSeq !== undefined || toSeq !== undefined,
        });
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

      match = /^\/api\/sessions\/([^/]+)\/export$/.exec(path);
      if (match) {
        const sessionID = match[1]!;
        const formatRaw = (search.get("format") ?? "json").toLowerCase();
        if (formatRaw !== "json" && formatRaw !== "markdown" && formatRaw !== "html") {
          sendJson(req, res, 400, {
            error: "invalid_format",
            message: "format must be json, markdown or html",
          });
          return;
        }
        const options: ExportOptions = {
          format: formatRaw,
          reveal,
          includeEvents: search.get("includeEvents") !== "0",
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
        message: `No route for ${path}`,
      });
    } catch (error) {
      const mapped = errorBody(error);
      sendJson(req, res, mapped.status, {
        error: mapped.code,
        message: mapped.message,
      });
    }
  };

  let inFlight = 0;
  const MAX_IN_FLIGHT = 32;
  const server = createServer((req, res) => {
    if (inFlight >= MAX_IN_FLIGHT) {
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
    void handle(req, res).finally(() => {
      inFlight--;
    });
  });

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

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  try {
    const body = await readFile(path);
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(path).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
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
