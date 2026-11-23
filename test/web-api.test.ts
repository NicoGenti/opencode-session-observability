import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  createApiClient,
  requestTarget,
  responseError,
  serializeParams,
  withRefresh,
  type ApiClientConfig,
  type FetchLike,
} from "../src/web/lib/api.ts";

/* --------------------------------------------------------------- serialization */

test("serializeParams keeps the legacy skip and join rules", () => {
  const search = serializeParams({
    q: "hello world",
    limit: 300,
    zero: 0,
    empty: "",
    missing: undefined,
    absent: null,
    off: false,
    on: true,
    kinds: ["tool", "error"],
    numbers: [1, 2],
    none: [],
    text: "false",
  });
  assert.equal(
    search.toString(),
    "q=hello+world&limit=300&zero=0&on=1&kinds=tool%2Cerror&numbers=1%2C2&text=false",
  );
  // The key order is the object's own order, as `for…of Object.entries` gives it.
  assert.deepEqual([...search.keys()], [
    "q",
    "limit",
    "zero",
    "on",
    "kinds",
    "numbers",
    "text",
  ]);
  assert.equal(serializeParams().toString(), "");
});

test("requestTarget appends instead of adding a second question mark", () => {
  assert.equal(requestTarget("/api/sessions"), "/api/sessions");
  assert.equal(
    requestTarget("/api/sessions", { limit: 300 }),
    "/api/sessions?limit=300",
  );
  assert.equal(
    requestTarget("/api/benchmark?from=1", { limit: 2 }),
    "/api/benchmark?from=1&limit=2",
  );
  assert.equal(
    requestTarget("/api/sessions", { limit: 1 }, { reveal: true }),
    "/api/sessions?limit=1&reveal=1",
  );
  // An empty array adds nothing, so no trailing `?`.
  assert.equal(requestTarget("/api/sessions", { kinds: [] }), "/api/sessions");
});

/* ----------------------------------------------------------------------- errors */

test("ApiError carries the status, code and message", () => {
  const error = new ApiError(404, "not_found", "No such session");
  assert.equal(error instanceof Error, true);
  assert.equal(error instanceof ApiError, true);
  assert.equal(error.name, "ApiError");
  assert.equal(error.status, 404);
  assert.equal(error.code, "not_found");
  assert.equal(error.message, "No such session");
});

test("responseError preserves the server error code on the text/export path", async () => {
  const reveal = await responseError(
    json({ error: "reveal_disabled", message: "Reveal is disabled" }, 403),
    "Export failed (403)",
  );
  assert.equal(reveal instanceof ApiError, true);
  assert.equal(reveal.status, 403);
  assert.equal(reveal.code, "reveal_disabled");
  assert.equal(reveal.message, "Reveal is disabled");

  const plain = await responseError(
    new Response("not json", { status: 500 }),
    "Export failed (500)",
  );
  assert.equal(plain.code, "http_error");
  assert.equal(plain.message, "Export failed (500)");
});

test("withRefresh adds refresh=1 only to the forced analysis request", () => {
  const params = { "gr.tokensTotal": "2000000" };
  assert.equal(withRefresh(params, false), params);
  assert.deepEqual(withRefresh(params, true), {
    "gr.tokensTotal": "2000000",
    refresh: 1,
  });
  assert.deepEqual(withRefresh(undefined, true), { refresh: 1 });
});

/* ----------------------------------------------------------------- request flow */

interface FakeCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  responses: ReadonlyArray<Response | (() => Response)>,
  calls: FakeCall[],
): FetchLike {
  let index = 0;
  return async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof next === "function" ? next() : next;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(overrides: Partial<ApiClientConfig> = {}): ApiClientConfig {
  return {
    token: () => "t0",
    revealAllowed: () => false,
    reveal: () => false,
    requestToken: async () => null,
    ...overrides,
  };
}

test("the client sends Accept, the auth header, no-store and the params", async () => {
  const calls: FakeCall[] = [];
  const api = createApiClient({
    ...config(),
    fetch: fakeFetch([json({ sessions: [] })], calls),
  });
  const data = await api<{ sessions: unknown[] }>("/api/sessions", {
    q: "needle",
    limit: 300,
  });
  assert.deepEqual(data, { sessions: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/sessions?q=needle&limit=300");
  assert.deepEqual(calls[0].init?.headers, {
    Accept: "application/json",
    Authorization: "Bearer t0",
  });
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal("signal" in (calls[0].init ?? {}), false);
});

test("reveal=1 needs both the server allowance and the current toggle", async () => {
  const calls: FakeCall[] = [];
  const api = createApiClient({
    ...config({ revealAllowed: () => true, reveal: () => true }),
    fetch: fakeFetch([json({}), json({}), json({})], calls),
  });
  await api<unknown>("/api/sessions/ses_1");
  await api<unknown>("/api/sessions/ses_1/export", {}, { noReveal: true });
  await api<unknown>("/api/sessions/ses_1/analysis");

  assert.equal(calls[0].url, "/api/sessions/ses_1?reveal=1");
  assert.equal(calls[1].url, "/api/sessions/ses_1/export");
  assert.equal(calls[2].url, "/api/sessions/ses_1/analysis?reveal=1");

  const denied: FakeCall[] = [];
  const deniedApi = createApiClient({
    ...config({ revealAllowed: () => false, reveal: () => true }),
    fetch: fakeFetch([json({})], denied),
  });
  await deniedApi<unknown>("/api/sessions/ses_1");
  assert.equal(denied[0].url, "/api/sessions/ses_1");
});

test("a 401 clears the token, asks once and retries with the new one", async () => {
  const calls: FakeCall[] = [];
  const cleared: number[] = [];
  const accepted: string[] = [];
  const asked: number[] = [];
  const api = createApiClient({
    fetch: fakeFetch([json({ error: "unauthorized" }, 401), json({ sessions: [] })], calls),
    token: () => "old",
    revealAllowed: () => false,
    reveal: () => false,
    requestToken: async () => {
      asked.push(1);
      return " new ";
    },
    acceptToken: (token) => accepted.push(token),
    clearToken: () => cleared.push(1),
  });

  const data = await api<{ sessions: unknown[] }>("/api/sessions");
  assert.deepEqual(data, { sessions: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(cleared, [1]);
  assert.deepEqual(asked, [1]);
  assert.deepEqual(accepted, ["new"]);
  const headers = calls[1].init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.Authorization, "Bearer new");
});

test("a cancelled prompt throws the 401 and never retries", async () => {
  const calls: FakeCall[] = [];
  const cleared: number[] = [];
  const api = createApiClient({
    fetch: fakeFetch([json({ error: "unauthorized", message: "Token required" }, 401)], calls),
    token: () => "old",
    revealAllowed: () => false,
    reveal: () => false,
    requestToken: async () => null,
    clearToken: () => cleared.push(1),
  });
  await assert.rejects(api<unknown>("/api/sessions"), (error: unknown) => {
    assert.equal(error instanceof ApiError, true);
    const apiError = error as ApiError;
    assert.equal(apiError.status, 401);
    assert.equal(apiError.code, "unauthorized");
    assert.equal(apiError.message, "Token required");
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(cleared, [1]);
});

test("a second 401 is final", async () => {
  const calls: FakeCall[] = [];
  const api = createApiClient({
    fetch: fakeFetch([json({}, 401), json({}, 401), json({})], calls),
    token: () => "old",
    revealAllowed: () => false,
    reveal: () => false,
    requestToken: async () => "new",
    acceptToken: () => {},
    clearToken: () => {},
  });
  await assert.rejects(api<unknown>("/api/sessions"), (error: unknown) => {
    assert.equal((error as ApiError).status, 401);
    assert.equal((error as ApiError).code, "http_error");
    assert.equal((error as ApiError).message, "Request failed (401)");
    return true;
  });
  assert.equal(calls.length, 2);
});

test("non-OK responses become ApiError with the documented fallbacks", async () => {
  const calls: FakeCall[] = [];
  const api = createApiClient({
    ...config(),
    fetch: fakeFetch(
      [
        json({ error: "bad_request", message: "limit must be a number" }, 400),
        new Response("not json", { status: 500 }),
      ],
      calls,
    ),
  });
  await assert.rejects(api<unknown>("/api/sessions"), (error: unknown) => {
    assert.equal((error as ApiError).code, "bad_request");
    assert.equal((error as ApiError).message, "limit must be a number");
    return true;
  });
  await assert.rejects(api<unknown>("/api/sessions"), (error: unknown) => {
    assert.equal((error as ApiError).code, "http_error");
    assert.equal((error as ApiError).message, "Request failed (500)");
    return true;
  });
});

test("the abort signal is forwarded to fetch", async () => {
  const calls: FakeCall[] = [];
  const api = createApiClient({ ...config(), fetch: fakeFetch([json({})], calls) });
  const controller = new AbortController();
  await api<unknown>("/api/sessions", {}, { signal: controller.signal });
  assert.equal(calls[0].init?.signal, controller.signal);
});

test("the client is the one request sink for policy and reveal recovery", async () => {
  const allowed: boolean[] = [];
  const errors: ApiError[] = [];
  const api = createApiClient({
    ...config(),
    onRevealAllowed: (value) => allowed.push(value),
    onError: (error) => errors.push(error),
    fetch: fakeFetch(
      [
        json({ analysis: {}, revealAllowed: false }),
        json({ error: "reveal_disabled", message: "Reveal is disabled" }, 403),
        json({ sessions: [], revealAllowed: true }),
      ],
      [],
    ),
  });

  await api<{ revealAllowed?: boolean }>("/api/sessions/ses_1/analysis");
  await assert.rejects(api<unknown>("/api/sessions/ses_1/events"));
  await api<{ revealAllowed?: boolean }>("/api/sessions");

  assert.deepEqual(allowed, [false, true]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "reveal_disabled");
});
