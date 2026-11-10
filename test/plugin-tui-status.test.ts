import test from "node:test";
import assert from "node:assert/strict";
import {
  clearStatusCache,
  fetchSessionStatus,
  formatStatusBadge,
  peekStatusCache,
  type SessionStatusOptions,
  type StatusContext,
} from "../src/plugin/tui-status.ts";
import {
  fetchSessionStatus as fetchFromTui,
  formatStatusBadge as formatFromTui,
} from "../src/plugin/tui.ts";

const BASE = "http://127.0.0.1:4517";
const MIDDLE_DOT = " \u00b7 ";

type FetchCall = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

type CostSource = number | null;

/** A context with no `ui` slice: any toast attempt would throw, so a pass proves none. */
function statusContext(
  options: Record<string, unknown> = {},
  cost: CostSource = 0.12,
): StatusContext {
  return {
    options,
    data: {
      session: {
        cost: () => cost as number,
      },
    },
  };
}

function recordFetch(
  calls: FetchCall[],
  respond: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return respond(url);
  };
}

function analysisBody(rate: number | null): string {
  return JSON.stringify({
    analysis: { totals: { cacheHitRate: { value: rate, basis: "derived" } } },
  });
}

function analysisResponse(rate: number | null): Response {
  return new Response(analysisBody(rate), { status: 200 });
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

test("formatStatusBadge pins the four golden strings", () => {
  assert.equal(
    formatStatusBadge({ cost: 0.12, cacheHitRate: 0.38 }),
    "$0.12 · cache 38%",
  );
  assert.equal(
    formatStatusBadge({ cost: null, cacheHitRate: 0.38 }),
    "n/a · cache 38%",
  );
  assert.equal(
    formatStatusBadge({ cost: 0.12, cacheHitRate: null }),
    "$0.12 · cache n/a",
  );
  assert.equal(
    formatStatusBadge({ cost: null, cacheHitRate: null }),
    "n/a · cache n/a",
  );
  assert.equal(
    formatStatusBadge({ cost: 0.12, cacheHitRate: 0.38 }),
    `$0.12${MIDDLE_DOT}cache 38%`,
  );
});

test("formatStatusBadge guards domain and finiteness per field", () => {
  assert.equal(formatStatusBadge({ cost: 0, cacheHitRate: 0 }), "$0.00 · cache 0%");
  assert.equal(
    formatStatusBadge({ cost: 1.005, cacheHitRate: 1 }),
    "$1.00 · cache 100%",
  );
  assert.equal(
    formatStatusBadge({ cost: Number.NaN, cacheHitRate: 0.375 }),
    "n/a · cache 38%",
  );
  assert.equal(
    formatStatusBadge({ cost: Number.POSITIVE_INFINITY, cacheHitRate: 0.375 }),
    "n/a · cache 38%",
  );
  assert.equal(
    formatStatusBadge({ cost: 0.12, cacheHitRate: -0.1 }),
    "$0.12 · cache n/a",
  );
  assert.equal(
    formatStatusBadge({ cost: 0.12, cacheHitRate: 1.2 }),
    "$0.12 · cache n/a",
  );
  assert.equal(
    formatStatusBadge({ cost: 0.12, cacheHitRate: Number.NaN }),
    "$0.12 · cache n/a",
  );
  assert.equal(
    formatStatusBadge({ cost: 0.12, cacheHitRate: Number.NEGATIVE_INFINITY }),
    "$0.12 · cache n/a",
  );
});

test("tui.ts re-exports the status seam without a second implementation", () => {
  assert.equal(formatFromTui, formatStatusBadge);
  assert.equal(fetchFromTui, fetchSessionStatus);
});

test("fetchSessionStatus reads cost from the SDK and the rate from analysis", async () => {
  clearStatusCache();
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => analysisResponse(0.38)),
    now: () => 0,
  };

  const result = await fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_ok", options);

  assert.deepEqual(result, { cost: 0.12, cacheHitRate: 0.38 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE}/api/sessions/ses_ok/analysis`);
  assert.equal(headersOf(calls[0]!).Authorization, undefined);
});

test("fetchSessionStatus encodes the session id into the analysis URL", async () => {
  clearStatusCache();
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => analysisResponse(0.5)),
    now: () => 0,
  };

  await fetchSessionStatus(statusContext({ url: BASE }, 0), "ses a/b", options);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE}/api/sessions/ses%20a%2Fb/analysis`);
});

test("fetchSessionStatus sends the bearer token only when health requires auth", async () => {
  clearStatusCache();
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "auth",
    fetch: recordFetch(calls, () => analysisResponse(0.2)),
    now: () => 0,
  };

  const result = await fetchSessionStatus(
    statusContext({ url: BASE, token: "tok-secret" }, 0.12),
    "ses_auth",
    options,
  );

  assert.deepEqual(result, { cost: 0.12, cacheHitRate: 0.2 });
  assert.equal(calls.length, 1);
  assert.equal(headersOf(calls[0]!).Authorization, "Bearer tok-secret");
});

test("fetchSessionStatus returns a null rate on offline, 401 and unparsable bodies", async () => {
  clearStatusCache();
  const offlineCalls: FetchCall[] = [];
  const offline: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(offlineCalls, () => {
      throw new Error("offline");
    }),
    now: () => 0,
  };
  const down = await fetchSessionStatus(
    statusContext({ url: BASE }, 0.12),
    "ses_offline",
    offline,
  );
  assert.deepEqual(down, { cost: 0.12, cacheHitRate: null });
  assert.equal(offlineCalls.length, 1);

  // Negative results are cached for the same TTL: no second fetch.
  const repeat = await fetchSessionStatus(
    statusContext({ url: BASE }, 0.12),
    "ses_offline",
    offline,
  );
  assert.deepEqual(repeat, { cost: 0.12, cacheHitRate: null });
  assert.equal(offlineCalls.length, 1);

  const cases: Array<[string, () => Response]> = [
    ["ses_401", () => new Response("denied", { status: 401 })],
    ["ses_html", () => new Response("<html>not json</html>", { status: 200 })],
    ["ses_null", () => analysisResponse(null)],
    [
      "ses_domain",
      () => new Response(analysisBody(1.5), { status: 200 }),
    ],
  ];
  for (const [sessionID, respond] of cases) {
    clearStatusCache();
    const calls: FetchCall[] = [];
    const result = await fetchSessionStatus(statusContext({ url: BASE }, 0.12), sessionID, {
      health: async () => "ok",
      fetch: recordFetch(calls, respond),
      now: () => 0,
    });
    assert.deepEqual(result, { cost: 0.12, cacheHitRate: null }, sessionID);
    assert.equal(calls.length, 1, sessionID);
  }
});

test("fetchSessionStatus returns null cost when the SDK cost is unusable", async () => {
  clearStatusCache();
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => analysisResponse(0.38)),
    now: () => 0,
  };

  const nullCost = await fetchSessionStatus(statusContext({ url: BASE }, null), "ses_null_cost", options);
  assert.deepEqual(nullCost, { cost: null, cacheHitRate: 0.38 });

  const throwing: StatusContext = {
    options: { url: BASE },
    data: {
      session: {
        cost: () => {
          throw new Error("sdk exploded");
        },
      },
    },
  };
  const guarded = await fetchSessionStatus(throwing, "ses_throwing_cost", options);
  assert.deepEqual(guarded, { cost: null, cacheHitRate: 0.38 });
});

test("fetchSessionStatus reuses a cached result inside the 15s TTL", async () => {
  clearStatusCache();
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => analysisResponse(0.4)),
    now: () => 0,
  };

  await fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_ttl_hit", options);
  await fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_ttl_hit", options);

  assert.equal(calls.length, 1);
});

test("fetchSessionStatus expires the cache after the TTL using the injected clock", async () => {
  clearStatusCache();
  let clock = 0;
  let served = 0;
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => {
      served += 1;
      return analysisResponse(served === 1 ? 0.2 : 0.6);
    }),
    now: () => clock,
  };

  const first = await fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_ttl_expiry", options);
  assert.equal(first.cacheHitRate, 0.2);
  assert.equal(calls.length, 1);

  clock = 14_999;
  const cached = await fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_ttl_expiry", options);
  assert.equal(cached.cacheHitRate, 0.2);
  assert.equal(calls.length, 1);

  clock = 15_001;
  const refreshed = await fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_ttl_expiry", options);
  assert.equal(refreshed.cacheHitRate, 0.6);
  assert.equal(calls.length, 2);
});

test("fetchSessionStatus shares one in-flight analysis request across callers", async () => {
  clearStatusCache();
  let release: (response: Response) => void = () => {};
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => gate),
    now: () => 0,
  };
  const context = statusContext({ url: BASE }, 0.12);

  const pending = Array.from({ length: 5 }, () =>
    fetchSessionStatus(context, "ses_shared", options),
  );
  release(analysisResponse(0.25));
  const results = await Promise.all(pending);

  assert.equal(calls.length, 1);
  for (const result of results) {
    assert.deepEqual(result, { cost: 0.12, cacheHitRate: 0.25 });
  }
});

test("fetchSessionStatus ignores a missing or blank session id", async () => {
  clearStatusCache();
  const calls: FetchCall[] = [];
  let probes = 0;
  const options: SessionStatusOptions = {
    health: async () => {
      probes += 1;
      return "ok";
    },
    fetch: recordFetch(calls, () => analysisResponse(0.38)),
    now: () => 0,
  };
  const context = statusContext({ url: BASE }, 0.12);

  for (const sessionID of [undefined, "", "  "] as unknown as string[]) {
    const result = await fetchSessionStatus(context, sessionID, options);
    assert.deepEqual(result, { cost: null, cacheHitRate: null }, String(sessionID));
  }

  // No health probe, no analysis fetch, and no cache entry: the guard runs first.
  assert.equal(probes, 0);
  assert.equal(calls.length, 0);
  assert.equal(peekStatusCache(""), null);
  assert.equal(peekStatusCache("  "), null);
});

test("fetchSessionStatus drops the expired entry before the refresh starts", async () => {
  clearStatusCache();
  let clock = 0;
  let release: (response: Response) => void = () => {};
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => {
      if (calls.length === 1) return analysisResponse(0.2);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
    now: () => clock,
  };

  await fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_evict", options);
  assert.deepEqual(peekStatusCache("ses_evict"), {
    cacheHitRate: 0.2,
    expiresAt: 15_000,
  });

  clock = 15_001;
  const pending = fetchSessionStatus(statusContext({ url: BASE }, 0.12), "ses_evict", options);
  await new Promise((resolve) => setImmediate(resolve));

  // The stale entry is gone while its replacement is still in flight.
  assert.equal(peekStatusCache("ses_evict"), null);

  release(analysisResponse(0.6));
  const refreshed = await pending;
  assert.equal(refreshed.cacheHitRate, 0.6);
  assert.deepEqual(peekStatusCache("ses_evict"), {
    cacheHitRate: 0.6,
    expiresAt: 30_001,
  });
});
