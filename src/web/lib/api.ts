/**
 * The typed fetch wrapper, a strict port of `api()` (`src/ui/app.js:279-333`).
 *
 * Contract kept verbatim:
 *
 * - Parameters are serialized with `URLSearchParams`; `undefined`, `null`, `""`
 *   and `false` are skipped, arrays are comma-joined (an empty array is
 *   skipped), `true` becomes `"1"` and everything else becomes `String(value)`.
 * - The request target is root-relative: no origin, no `<base>`, so a response
 *   can never come from anywhere but this UI's own server.
 * - `Accept: application/json`, the `Authorization` header when a token exists,
 *   and `cache: "no-store"`.
 * - `reveal=1` is appended only when reveal is allowed, currently on, and the
 *   call did not opt out (`noReveal`).
 * - A 401 clears the token, asks for a new one and retries exactly once; a
 *   declined prompt falls through to the `ApiError(401, ...)`.
 * - Any other failure becomes `ApiError(status, code, message)` from the JSON
 *   body, with `http_error` and `Request failed (<status>)` as fallbacks.
 *
 * The client is also the app's one request sink: `onError` sees every handled
 * failure (so `reveal_disabled` turns reveal off wherever it happens) and
 * `onRevealAllowed` sees every payload that states the server policy.
 */

import { get, set } from "./settings.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type ApiParam = string | number | boolean | readonly (string | number)[] | null | undefined;

export type ApiParams = Record<string, ApiParam>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiRequestOptions {
  /** Skip the `reveal=1` parameter for this call (downloads, share links). */
  noReveal?: boolean;
  /** Internal: the 401 retry sets this so a second 401 throws. */
  authRetried?: boolean;
  /** Lets the caller abandon an in-flight request (session switches, unmount). */
  signal?: AbortSignal;
}

export type ApiFn = <T>(
  path: string,
  params?: ApiParams,
  options?: ApiRequestOptions,
) => Promise<T>;

export interface ApiClientConfig {
  /** Defaults to the global `fetch`; tests inject a fake. */
  fetch?: FetchLike;
  token(): string | null;
  revealAllowed(): boolean;
  reveal(): boolean;
  /** Resolves with a pasted token, or `null` when the user cancels. */
  requestToken(): Promise<string | null>;
  acceptToken?(token: string): void;
  clearToken?(): void;
  /** Shared error sink: called with every handled non-OK response. */
  onError?(error: ApiError): void;
  /** Shared policy sink: called when a JSON payload carries `revealAllowed`. */
  onRevealAllowed?(allowed: boolean): void;
}

export function serializeParams(params: ApiParams = {}): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(","));
    } else if (value === true) {
      search.set(key, "1");
    } else {
      search.set(key, String(value));
    }
  }
  return search;
}

export interface RequestTargetOptions {
  reveal?: boolean;
}

/** The URL `api()` would request; exported so the contract is directly testable. */
export function requestTarget(
  path: string,
  params: ApiParams = {},
  options: RequestTargetOptions = {},
): string {
  const search = serializeParams(params);
  // The one database selector. A stored key is appended once to every /api
  // request, read through the same settings accessor every other module uses.
  // An explicit caller `db` wins, so the catalogue's per-row count request is
  // never duplicated; `/api/health` is startup-defined and never carries it.
  if (path.startsWith("/api/") && path !== "/api/health" && !search.has("db")) {
    const stored = get("dbKey");
    if (typeof stored === "string" && stored.length > 0) search.set("db", stored);
  }
  if (options.reveal) search.set("reveal", "1");
  const query = search.toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

function authHeader(token: string | null): Record<string, string> {
  const value = typeof token === "string" ? token.trim() : "";
  return value ? { Authorization: `Bearer ${value}` } : {};
}

/**
 * The one failure decoder: preserves the server's `error` code and `message`
 * so a typed `ApiError` keeps `reveal_disabled` recognisable. `api()` and the
 * text/export fetch paths share it.
 */
export async function responseError(
  response: Response,
  fallback: string,
): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const code = typeof record?.error === "string" ? record.error : "http_error";
  const message =
    typeof record?.message === "string" ? record.message : fallback;
  return new ApiError(response.status, code, message);
}

/**
 * The forced analysis request (`refreshCurrent({ force: true })`,
 * `app.js:463-470`): only a manual refresh asks the server to drop its dataset
 * cache, and only on the request that carries the force.
 */
export function withRefresh(
  params: ApiParams | undefined,
  refresh: boolean,
): ApiParams | undefined {
  if (!refresh) return params;
  return { ...(params ?? {}), refresh: 1 };
}

export function createApiClient(config: ApiClientConfig): ApiFn {
  const request: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));

  const call = async (
    path: string,
    params: ApiParams,
    options: ApiRequestOptions,
    token: string | null,
  ): Promise<Response> => {
    const reveal =
      config.revealAllowed() && config.reveal() && options.noReveal !== true;
    return request(requestTarget(path, params, { reveal }), {
      headers: { Accept: "application/json", ...authHeader(token) },
      cache: "no-store",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };

  const api = async <T,>(
    path: string,
    params: ApiParams = {},
    options: ApiRequestOptions = {},
  ): Promise<T> => {
    let response = await call(path, params, options, config.token());
    if (response.status === 401 && options.authRetried !== true) {
      config.clearToken?.();
      const entered = await config.requestToken();
      const token = typeof entered === "string" ? entered.trim() : "";
      if (token) {
        config.acceptToken?.(token);
        // The retry carries the token the user just entered, not the value the
        // caller's auth snapshot still holds.
        response = await call(
          path,
          params,
          { ...options, authRetried: true },
          token,
        );
      }
    }
    if (!response.ok) {
      const error = await responseError(
        response,
        `Request failed (${response.status})`,
      );
      // A stale database selection self-heals once: when the rejected key is the
      // one stored in this browser, clearing it lets the next request fall back
      // to the startup database. An explicit per-row key never clears a
      // different stored choice, and there is no retry loop here.
      if (error.status === 400 && error.code === "invalid_db") {
        const stored = get("dbKey");
        const explicit = typeof params.db === "string" ? params.db : "";
        if (
          typeof stored === "string" &&
          stored !== "" &&
          (explicit === "" || explicit === stored)
        ) {
          set("dbKey", "");
        }
      }
      config.onError?.(error);
      throw error;
    }
    const data = (await response.json()) as T;
    if (data && typeof data === "object") {
      const allowed = (data as Record<string, unknown>).revealAllowed;
      if (typeof allowed === "boolean") config.onRevealAllowed?.(allowed);
    }
    return data;
  };

  return api;
}
