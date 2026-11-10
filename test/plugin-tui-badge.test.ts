import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  badgeLineInvalidated,
  clearStatusCache,
  formatStatusBadge,
  statusBadgeText,
  type SessionStatusOptions,
  type StatusContext,
} from "../src/plugin/tui-status.ts";
import { statusBadgeText as statusBadgeTextFromTui } from "../src/plugin/tui.ts";

const BASE = "http://127.0.0.1:4517";
const MIDDLE_DOT = " \u00b7 ";

type FetchCall = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

/** A context with no `ui` slice: any toast attempt would throw, so a pass proves none. */
function statusContext(
  options: Record<string, unknown> = {},
  cost: number | null = 0.12,
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

function analysisResponse(rate: number | null): Response {
  return new Response(
    JSON.stringify({
      analysis: { totals: { cacheHitRate: { value: rate, basis: "derived" } } },
    }),
    { status: 200 },
  );
}

test("the badge renders nothing without a session id and never probes or fetches", async () => {
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
  const sessionIDs: Array<string | null | undefined> = [
    undefined,
    null,
    "",
    "   ",
  ];

  for (const sessionID of sessionIDs) {
    assert.equal(
      await statusBadgeText(context, sessionID, options),
      null,
      String(sessionID),
    );
  }

  // The guard runs before the shared cache and the network: a host that renders
  // the footer without a session costs nothing.
  assert.equal(probes, 0);
  assert.equal(calls.length, 0);
});

test("the badge formats the SDK cost and the cached analysis rate", async () => {
  clearStatusCache();
  const calls: FetchCall[] = [];
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: recordFetch(calls, () => analysisResponse(0.38)),
    now: () => 0,
  };

  const text = await statusBadgeText(
    statusContext({ url: BASE }, 0.12),
    "ses_badge",
    options,
  );

  assert.equal(text, `$0.12${MIDDLE_DOT}cache 38%`);
  assert.equal(text, formatStatusBadge({ cost: 0.12, cacheHitRate: 0.38 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE}/api/sessions/ses_badge/analysis`);
});

test("the badge degrades to n/a on offline, 401 and an unparsable body", async () => {
  const cases: Array<{
    readonly sessionID: string;
    readonly health: () => Promise<"ok" | "down" | "auth">;
    readonly respond?: () => Response;
    readonly expected: string;
  }> = [
    {
      sessionID: "ses_badge_down",
      health: async () => "down",
      expected: `$0.12${MIDDLE_DOT}cache n/a`,
    },
    {
      sessionID: "ses_badge_401",
      health: async () => "ok",
      respond: () => new Response("denied", { status: 401 }),
      expected: `$0.12${MIDDLE_DOT}cache n/a`,
    },
    {
      sessionID: "ses_badge_html",
      health: async () => "ok",
      respond: () => new Response("<html>not json</html>", { status: 200 }),
      expected: `$0.12${MIDDLE_DOT}cache n/a`,
    },
  ];

  for (const scenario of cases) {
    clearStatusCache();
    const calls: FetchCall[] = [];
    const options: SessionStatusOptions = {
      health: scenario.health,
      fetch: recordFetch(
        calls,
        scenario.respond ?? (() => analysisResponse(0.5)),
      ),
      now: () => 0,
    };

    assert.equal(
      await statusBadgeText(
        statusContext({ url: BASE }, 0.12),
        scenario.sessionID,
        options,
      ),
      scenario.expected,
      scenario.sessionID,
    );
    // Offline short-circuits before the analysis call; the HTTP failures still
    // made exactly one attempt.
    assert.equal(
      calls.length,
      scenario.respond ? 1 : 0,
      scenario.sessionID,
    );
  }
});

test("the badge never throws and never shows a toast", async () => {
  clearStatusCache();
  let toasts = 0;
  const context = {
    options: { url: BASE },
    data: {
      session: {
        cost: () => {
          throw new Error("sdk exploded");
        },
      },
    },
    ui: {
      toast: {
        show: () => {
          toasts += 1;
          throw new Error("the badge must not toast");
        },
      },
    },
  } as unknown as StatusContext;
  const options: SessionStatusOptions = {
    health: async () => "ok",
    fetch: () => {
      throw new Error("offline");
    },
    now: () => 0,
  };

  const text = await statusBadgeText(context, "ses_badge_never", options);

  assert.equal(text, `n/a${MIDDLE_DOT}cache n/a`);
  assert.equal(toasts, 0);
});

test("the badge keeps its line across same-session re-renders (F5)", () => {
  // Same session (e.g. the host toggling `showDetails`) keeps the text.
  assert.equal(badgeLineInvalidated("ses_1", "ses_1"), false);
  assert.equal(badgeLineInvalidated(undefined, undefined), false);
  assert.equal(badgeLineInvalidated(null, null), false);

  // A session change, including losing or gaining the session, clears it.
  assert.equal(badgeLineInvalidated("ses_1", "ses_2"), true);
  assert.equal(badgeLineInvalidated("ses_1", undefined), true);
  assert.equal(badgeLineInvalidated(undefined, "ses_1"), true);
  assert.equal(badgeLineInvalidated("", undefined), true);
  assert.equal(badgeLineInvalidated(null, "ses_1"), true);
});

test("tui.ts re-exports the badge text and claims prompt.footer.status", async () => {
  assert.equal(statusBadgeTextFromTui, statusBadgeText);

  const source = await readFile(
    new URL("../src/plugin/tui.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /append: "prompt\.footer\.status"/);
  assert.match(source, /await import\("\.\/tui\/statusBadge\.tsx"\)/);
});
