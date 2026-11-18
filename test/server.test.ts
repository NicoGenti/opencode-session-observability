import test from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_PATH,
  EPISODE_COMPARE_PATH,
  SESSION_DIAGNOSTICS_PATTERN,
  SESSION_FAMILY_RECOVERY_PATTERN,
  SESSION_LIVE_PATTERN,
  createObservabilityServer,
} from "../src/server/http.ts";
import { generateToken } from "../src/server/auth.ts";
import { DatabaseBusyError } from "../src/core/adapters/sqlite.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  incompleteFixture,
  longFixture,
  secretsFixture,
  session,
  simpleFixture,
  subagentFixture,
  toolBlock,
  toolsFixture,
  user,
  writeFixtureDb,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

async function withServer<T>(
  fixture: ReturnType<typeof simpleFixture>,
  run: (base: string) => Promise<T>,
  allowReveal = true,
): Promise<T> {
  const { path } = writeFixtureDb(fixture);
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    allowReveal,
  });
  try {
    return await run(server.url);
  } finally {
    await server.close();
  }
}

/**
 * Two sessions with repeated-failure runs that recover on the same tool.
 * `ses_ep` has a read run in turn 1 and a shell run in turn 2; `ses_ep2` has a
 * longer read run. A tool block's position in the message content defines its
 * recorded event id (`a1:0`, `a1:1`, ...), which episode ids embed.
 */
function episodesFixture(): Fixture {
  let call = 0;
  const callBlock = (
    name: string,
    input: unknown,
    at: number,
    status: "completed" | "error" = "completed",
  ): unknown => {
    call += 1;
    return toolBlock({
      callID: `call_${call}`,
      name,
      created: at,
      ran: at + 5,
      completed: at + 10,
      status,
      input,
      output: status === "error" ? "" : "ok",
    });
  };
  const read = { path: "src/a.ts" };
  const shell = { command: "npm test" };
  const otherRead = { path: "src/b.ts", depth: 1 };
  return fixture([
    {
      meta: session("ses_ep", {
        time: { created: BASE, updated: BASE + 1_500, busy: BASE, idle: BASE + 1_500 },
      }),
      messages: [
        user("msg_u1", 1, BASE),
        assistant({
          id: "a1",
          seq: 2,
          created: BASE + 100,
          streamed: BASE + 500,
          completed: BASE + 600,
          content: [
            callBlock("read", read, BASE + 200, "error"),
            callBlock("read", read, BASE + 300, "error"),
            callBlock("read", read, BASE + 400),
          ],
        }),
        idle("msg_i1", 3, BASE + 700, "succeeded"),
        user("msg_u2", 4, BASE + 800),
        assistant({
          id: "a2",
          seq: 5,
          created: BASE + 900,
          streamed: BASE + 1_300,
          completed: BASE + 1_400,
          content: [
            callBlock("shell", shell, BASE + 1_000, "error"),
            callBlock("shell", shell, BASE + 1_100, "error"),
            callBlock("shell", shell, BASE + 1_200),
          ],
        }),
        idle("msg_i2", 6, BASE + 1_500, "succeeded"),
      ],
    },
    {
      meta: session("ses_ep2", {
        time: { created: BASE, updated: BASE + 800, busy: BASE, idle: BASE + 800 },
      }),
      messages: [
        user("msg_bu1", 1, BASE),
        assistant({
          id: "b1",
          seq: 2,
          created: BASE + 100,
          streamed: BASE + 500,
          completed: BASE + 600,
          content: [
            callBlock("read", otherRead, BASE + 200, "error"),
            callBlock("read", otherRead, BASE + 300, "error"),
            callBlock("read", otherRead, BASE + 400, "error"),
            callBlock("read", otherRead, BASE + 500),
          ],
        }),
        idle("msg_bi1", 3, BASE + 800, "succeeded"),
      ],
    },
  ]);
}

/** Builds a diagnostics URL by expanding the exported route pattern. */
function diagnosticsURL(base: string, sessionID: string): string {
  const route = SESSION_DIAGNOSTICS_PATTERN.source
    .slice(1, -1)
    .replaceAll("\\/", "/")
    .replace("([^/]+)", encodeURIComponent(sessionID));
  assert.match(route, SESSION_DIAGNOSTICS_PATTERN);
  return `${base}${route}`;
}

/** Builds a family-recovery URL by expanding the exported route pattern. */
function familyRecoveryURL(base: string, sessionID: string): string {
  const route = SESSION_FAMILY_RECOVERY_PATTERN.source
    .slice(1, -1)
    .replaceAll("\\/", "/")
    .replace("([^/]+)", encodeURIComponent(sessionID));
  assert.match(route, SESSION_FAMILY_RECOVERY_PATTERN);
  return `${base}${route}`;
}

/** Builds a live-snapshot URL from the exported route pattern. */
function liveURL(
  base: string,
  sessionID: string,
  params: Record<string, string | number> = {},
): string {
  const route = SESSION_LIVE_PATTERN.source
    .slice(1, -1)
    .replaceAll("\\/", "/")
    .replace("([^/]+)", encodeURIComponent(sessionID));
  assert.match(route, SESSION_LIVE_PATTERN);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return `${base}${route}${suffix ? `?${suffix}` : ""}`;
}

function compareURL(
  base: string,
  params: {
    leftSession: string;
    leftEpisode: string;
    rightSession: string;
    rightEpisode: string;
    reveal?: boolean;
  },
): string {
  const search = new URLSearchParams({
    leftSession: params.leftSession,
    leftEpisode: params.leftEpisode,
    rightSession: params.rightSession,
    rightEpisode: params.rightEpisode,
  });
  if (params.reveal) search.set("reveal", "1");
  return `${base}${EPISODE_COMPARE_PATH}?${search.toString()}`;
}

test("HTTP health, sessions, session and analysis endpoints", async () => {
  await withServer(toolsFixture(), async (base) => {
    const health = await fetch(`${base}/api/health`).then((res) => res.json() as any);
    assert.equal(health.ok, true);
    assert.equal(health.readOnly, true);
    assert.equal(health.revealAllowed, true);
    assert.match(health.dbPath, /opencode\.db$/);

    const sessions = await fetch(`${base}/api/sessions?limit=1`).then((res) =>
      res.json() as any,
    );
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].id, "ses_tools");

    const session = await fetch(`${base}/api/sessions/ses_tools`).then((res) =>
      res.json() as any,
    );
    assert.equal(session.session.id, "ses_tools");
    assert.equal(session.family.parent, null);

    const analysis = await fetch(`${base}/api/sessions/ses_tools/analysis`).then(
      (res) => res.json() as any,
    );
    assert.equal(analysis.analysis.totals.steps, 2);
    assert.equal(analysis.analysis.totals.toolCalls, 2);
    assert.equal(analysis.analysis.turns[0].steps[0].toolCalls[0].input, null);
  });
});

test("HTTP event pages support filters, paging and detail", async () => {
  await withServer(toolsFixture(), async (base) => {
    const page = await fetch(
      `${base}/api/sessions/ses_tools/events?kinds=tool&limit=10`,
    ).then((res) => res.json() as any);
    assert.equal(page.events.length, 2);
    assert.equal(page.page.totalMatched, 2);
    assert.equal(page.events[0].payload, null);
    assert.equal(page.events[0].tool?.input, null);
    assert.ok(page.events[0].tool?.inputPreview);

    const first = await fetch(
      `${base}/api/sessions/ses_tools/events?limit=2&direction=forward`,
    ).then((res) => res.json() as any);
    assert.equal(first.events.length, 2);
    assert.equal(first.page.hasMoreAfter, true);
    const next = await fetch(
      `${base}/api/sessions/ses_tools/events?limit=2&direction=forward&after=${encodeURIComponent(
        first.page.after,
      )}`,
    ).then((res) => res.json() as any);
    assert.ok(next.events.length > 0);
    assert.notEqual(next.events[0].id, first.events[0].id);

    const all = await fetch(
      `${base}/api/sessions/ses_tools/events?limit=100`,
    ).then((res) => res.json() as any);
    const target = all.events[Math.floor(all.events.length / 2)];
    const around = await fetch(
      `${base}/api/sessions/ses_tools/events?limit=3&around=${encodeURIComponent(
        target.id,
      )}`,
    ).then((res) => res.json() as any);
    assert.ok(around.events.some((event: any) => event.id === target.id));

    const detail = await fetch(
      `${base}/api/sessions/ses_tools/events/${encodeURIComponent("msg_a1:1")}`,
    ).then((res) => res.json() as any);
    assert.equal(detail.event.kind, "tool");
    assert.equal(detail.event.tool.name, "read");
    assert.match(JSON.stringify(detail.event.payload), /src\/index\.ts/);
  });
});

test("HTTP redacts by default, reveals explicitly and can forbid reveal", async () => {
  await withServer(secretsFixture(), async (base) => {
    const redacted = await fetch(
      `${base}/api/sessions/ses_secrets/events?limit=50`,
    ).then((res) => res.json() as any);
    const text = JSON.stringify(redacted);
    assert.doesNotMatch(text, /sk-supersecretvalue12345/);
    assert.match(text, /\[REDACTED/);

    const revealed = await fetch(
      `${base}/api/sessions/ses_secrets/events?limit=50&reveal=1`,
    ).then((res) => res.json() as any);
    assert.match(JSON.stringify(revealed), /sk-supersecretvalue12345/);

    const sessions = await fetch(`${base}/api/sessions`).then((res) =>
      res.json() as any,
    );
    assert.match(sessions.sessions[0].title, /REDACTED/);
  });

  await withServer(
    secretsFixture(),
    async (base) => {
      const response = await fetch(
        `${base}/api/sessions/ses_secrets/events?reveal=1`,
      );
      assert.equal(response.status, 403);
      assert.equal((await response.json() as any).error, "reveal_disabled");
    },
    false,
  );
});

test("HTTP exports JSON, Markdown, HTML and digest as attachments", async () => {
  await withServer(simpleFixture(), async (base) => {
    for (const [format, mime] of [
      ["json", "application/json"],
      ["markdown", "text/markdown"],
      ["html", "text/html"],
      ["digest", "text/markdown"],
    ]) {
      const response = await fetch(
        `${base}/api/sessions/ses_simple/export?format=${format}`,
      );
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type")?.startsWith(mime));
      assert.match(
        response.headers.get("content-disposition") ?? "",
        /attachment; filename=/,
      );
      assert.equal(
        response.headers.get("x-observability-redacted"),
        "true",
        `${format} must report redaction`,
      );
      const body = await response.text();
      assert.ok(body.length > 100);
      if (format === "json") {
        assert.equal(JSON.parse(body).session.id, "ses_simple");
      }
      if (format === "digest") {
        assert.match(body, /^# Session digest — /);
      }
    }
  });
});

test("HTTP serves the digest and review prompt with reveal parity", async () => {
  await withServer(simpleFixture(), async (base) => {
    const digest = await fetch(
      `${base}/api/sessions/ses_simple/export?format=digest`,
    );
    assert.equal(digest.status, 200);
    assert.match(digest.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.match(
      digest.headers.get("content-disposition") ?? "",
      /-digest\.md"$/,
    );
    const digestBody = await digest.text();
    assert.match(digestBody, /^# Session digest — /);
    assert.doesNotMatch(
      digestBody,
      /You are reviewing an OpenCode coding-agent session/,
    );

    const prompt = await fetch(
      `${base}/api/sessions/ses_simple/export?format=digest&prompt=1`,
    );
    assert.equal(prompt.status, 200);
    assert.match(prompt.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.match(
      prompt.headers.get("content-disposition") ?? "",
      /-review-prompt\.md"$/,
    );
    const promptBody = await prompt.text();
    assert.match(
      promptBody,
      /^You are reviewing an OpenCode coding-agent session from its observability data\./,
    );
    assert.ok(promptBody.includes(`SESSION DIGEST:\n${digestBody}`));
  });

  await withServer(secretsFixture(), async (base) => {
    const revealed = await fetch(
      `${base}/api/sessions/ses_secrets/export?format=digest&reveal=1`,
    );
    assert.equal(revealed.status, 200);
    assert.equal(revealed.headers.get("x-observability-redacted"), "false");
    const body = await revealed.text();
    assert.match(body, /^> UNREDACTED: /m);
    assert.match(body, /sk-testvalue1234567890/);
  });

  await withServer(
    secretsFixture(),
    async (base) => {
      const response = await fetch(
        `${base}/api/sessions/ses_secrets/export?format=digest&reveal=1`,
      );
      assert.equal(response.status, 403);
      assert.equal((await response.json() as any).error, "reveal_disabled");
    },
    false,
  );
});

test("HTTP handles errors, HEAD and static assets", async () => {
  await withServer(simpleFixture(), async (base) => {
    const missing = await fetch(`${base}/api/sessions/ses_missing`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).error, "session_not_found");

    const badFormat = await fetch(
      `${base}/api/sessions/ses_simple/export?format=pdf`,
    );
    assert.equal(badFormat.status, 400);
    const badFormatBody = (await badFormat.json()) as any;
    assert.equal(badFormatBody.error, "invalid_format");
    assert.equal(
      badFormatBody.message,
      "format must be json, markdown, html or digest",
    );

    const post = await fetch(`${base}/api/health`, methods());
    assert.equal(post.status, 405);

    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const app = await fetch(`${base}/ui/app.js`);
    assert.equal(app.status, 200);
    assert.ok(app.headers.get("content-type")?.includes("javascript"));
    const index = await fetch(`${base}/`);
    assert.match(await index.text(), /Session Observability/);

    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);
  });
});

test("HTTP diagnostics returns incidents, episodes and the reveal state", async () => {
  await withServer(episodesFixture(), async (base) => {
    const response = await fetch(diagnosticsURL(base, "ses_ep"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.revealAllowed, true);
    assert.equal(body.redacted, true);
    assert.equal(body.diagnostics.summary.incidents, 2);
    assert.deepEqual(
      body.episodes.map((episode: any) => [
        episode.id,
        episode.tool,
        episode.recovery,
      ]),
      [
        ["ses_ep:ses_ep:t1:read:a1:0", "read", "recovered"],
        ["ses_ep:ses_ep:t2:shell:a2:0", "shell", "recovered"],
      ],
    );
    assert.deepEqual(body.episodes[0].failureEventIDs, ["a1:0", "a1:1"]);
    assert.equal(body.episodes[0].recoveryEventID, "a1:2");
    assert.equal(body.episodes[1].recoveryEventID, "a2:2");

    const revealed = (await fetch(
      `${diagnosticsURL(base, "ses_ep")}?reveal=1`,
    ).then((res) => res.json())) as any;
    assert.equal(revealed.redacted, false);
    assert.equal(revealed.revealAllowed, true);
    assert.equal(revealed.episodes.length, 2);
  });
});

test("HTTP compare aligns episodes within and across sessions", async () => {
  await withServer(episodesFixture(), async (base) => {
    const left = (await fetch(diagnosticsURL(base, "ses_ep")).then((res) =>
      res.json()
    )) as any;
    const right = (await fetch(diagnosticsURL(base, "ses_ep2")).then((res) =>
      res.json()
    )) as any;
    const [readEpisode, shellEpisode] = left.episodes;

    const sameSession = (await fetch(
      compareURL(base, {
        leftSession: "ses_ep",
        leftEpisode: readEpisode.id,
        rightSession: "ses_ep",
        rightEpisode: shellEpisode.id,
      }),
    ).then((res) => res.json())) as any;
    assert.equal(sameSession.revealAllowed, true);
    assert.equal(sameSession.comparison.redacted, true);
    assert.equal(sameSession.comparison.left.sessionID, "ses_ep");
    assert.equal(sameSession.comparison.right.turnIndex, 2);
    assert.equal(sameSession.comparison.alignment.length, 3);

    const crossSession = (await fetch(
      compareURL(base, {
        leftSession: "ses_ep",
        leftEpisode: readEpisode.id,
        rightSession: "ses_ep2",
        rightEpisode: right.episodes[0].id,
      }),
    ).then((res) => res.json())) as any;
    assert.equal(crossSession.revealAllowed, true);
    assert.equal(crossSession.comparison.left.sessionID, "ses_ep");
    assert.equal(crossSession.comparison.right.sessionID, "ses_ep2");
    assert.deepEqual(
      crossSession.comparison.alignment.map((row: any) => [
        row.index,
        row.presence,
      ]),
      [
        [1, "both"],
        [2, "both"],
        [3, "right-only"],
        [4, "both"],
      ],
    );

    const revealed = (await fetch(
      compareURL(base, {
        leftSession: "ses_ep",
        leftEpisode: readEpisode.id,
        rightSession: "ses_ep2",
        rightEpisode: right.episodes[0].id,
        reveal: true,
      }),
    ).then((res) => res.json())) as any;
    assert.equal(revealed.revealAllowed, true);
    assert.equal(revealed.comparison.redacted, false);
    assert.deepEqual(revealed.comparison.alignment[0].left.input, {
      path: "src/a.ts",
    });
  });
});

test("HTTP compare maps bad sessions, episodes and queries to stable errors", async () => {
  await withServer(episodesFixture(), async (base) => {
    const left = (await fetch(diagnosticsURL(base, "ses_ep")).then((res) =>
      res.json()
    )) as any;
    const right = (await fetch(diagnosticsURL(base, "ses_ep2")).then((res) =>
      res.json()
    )) as any;
    const episodeID = left.episodes[0].id;
    const otherID = right.episodes[0].id;

    const missing = await fetch(
      `${base}${EPISODE_COMPARE_PATH}?leftSession=ses_ep&leftEpisode=${encodeURIComponent(
        episodeID,
      )}`,
    );
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as any).error, "invalid_query");

    // The malformed sequence only survives one decoding hop, so it must be
    // double-encoded for the route's strict decode to see it.
    const malformed = await fetch(
      `${base}${EPISODE_COMPARE_PATH}?leftSession=ses_ep&leftEpisode=%25E0%25A4%25A&rightSession=ses_ep2&rightEpisode=${encodeURIComponent(
        otherID,
      )}`,
    );
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as any).error, "invalid_query");

    const malformedPath = await fetch(
      `${base}/api/sessions/%E0%A4%A/diagnostics`,
    );
    assert.equal(malformedPath.status, 400);
    assert.equal(((await malformedPath.json()) as any).error, "invalid_path");

    const unknownSession = await fetch(
      compareURL(base, {
        leftSession: "ses_missing",
        leftEpisode: "ses_missing:ses_missing:t1:read:a1:0",
        rightSession: "ses_ep2",
        rightEpisode: otherID,
      }),
    );
    assert.equal(unknownSession.status, 404);
    assert.equal(
      ((await unknownSession.json()) as any).error,
      "session_not_found",
    );

    const unknownEpisode = await fetch(
      compareURL(base, {
        leftSession: "ses_ep",
        leftEpisode: "ses_ep:ses_ep:t9:read:a9:0",
        rightSession: "ses_ep2",
        rightEpisode: otherID,
      }),
    );
    assert.equal(unknownEpisode.status, 404);
    assert.equal(
      ((await unknownEpisode.json()) as any).error,
      "episode_not_found",
    );
  });
});

test("HTTP compare honours the reveal gate, HEAD and the method gate", async () => {
  await withServer(
    episodesFixture(),
    async (base) => {
      const body = (await fetch(diagnosticsURL(base, "ses_ep")).then((res) =>
        res.json()
      )) as any;
      const [readEpisode, shellEpisode] = body.episodes;

      const forbidden = await fetch(
        compareURL(base, {
          leftSession: "ses_ep",
          leftEpisode: readEpisode.id,
          rightSession: "ses_ep",
          rightEpisode: shellEpisode.id,
          reveal: true,
        }),
      );
      assert.equal(forbidden.status, 403);
      assert.equal(((await forbidden.json()) as any).error, "reveal_disabled");

      const head = await fetch(diagnosticsURL(base, "ses_ep"), {
        method: "HEAD",
      });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");

      const post = await fetch(`${base}${EPISODE_COMPARE_PATH}`, methods());
      assert.equal(post.status, 405);
      assert.equal(((await post.json()) as any).error, "method_not_allowed");
    },
    false,
  );
});

test("HTTP family recovery returns the assessed child family", async () => {
  await withServer(subagentFixture(), async (base) => {
    const response = await fetch(
      `${familyRecoveryURL(base, "ses_parent")}?reveal=1`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.revealAllowed, true);
    assert.equal(body.recovery.schemaVersion, 1);
    assert.equal(body.recovery.redacted, false);
    assert.equal(body.recovery.depth, 1);
    assert.equal(body.recovery.assessments.length, 1);
    assert.equal(
      body.recovery.assessments[0].link.childSessionID,
      "ses_child",
    );

    const hidden = (await fetch(
      familyRecoveryURL(base, "ses_parent"),
    ).then((res) => res.json())) as any;
    assert.equal(hidden.recovery.redacted, true);
    assert.equal(hidden.revealAllowed, true);
  });
});

test("HTTP family recovery maps an unknown session to a stable 404", async () => {
  await withServer(subagentFixture(), async (base) => {
    const response = await fetch(familyRecoveryURL(base, "ses_missing"));
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as any).error, "session_not_found");
  });
});

test("HTTP family recovery honours the reveal gate", async () => {
  await withServer(
    subagentFixture(),
    async (base) => {
      const forbidden = await fetch(
        `${familyRecoveryURL(base, "ses_parent")}?reveal=1`,
      );
      assert.equal(forbidden.status, 403);
      assert.equal(
        ((await forbidden.json()) as any).error,
        "reveal_disabled",
      );
    },
    false,
  );
});

test("HTTP family recovery rejects writes and answers HEAD without a body", async () => {
  await withServer(subagentFixture(), async (base) => {
    const post = await fetch(familyRecoveryURL(base, "ses_parent"), methods());
    assert.equal(post.status, 405);
    assert.equal(((await post.json()) as any).error, "method_not_allowed");

    const head = await fetch(familyRecoveryURL(base, "ses_parent"), {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
});

test("HTTP family recovery clears the dataset cache when ?refresh is set", async () => {
  const { path } = writeFixtureDb(subagentFixture());
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    allowReveal: true,
  });
  try {
    let cleared = 0;
    const clear = server.service.clearCache.bind(server.service);
    server.service.clearCache = () => {
      cleared += 1;
      clear();
    };

    const warm = await fetch(familyRecoveryURL(server.url, "ses_parent"));
    assert.equal(warm.status, 200);
    assert.equal(cleared, 0);
    assert.equal(server.service.describe().cacheEntries, 2);

    const refreshed = await fetch(
      `${familyRecoveryURL(server.url, "ses_parent")}?refresh=1`,
    );
    assert.equal(refreshed.status, 200);
    assert.equal(cleared, 1);
    assert.equal(server.service.describe().cacheEntries, 2);
  } finally {
    await server.close();
  }
});

test("HTTP live never clears the dataset cache, even with ?refresh=1", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    allowReveal: true,
  });
  try {
    let cleared = 0;
    const clear = server.service.clearCache.bind(server.service);
    server.service.clearCache = () => {
      cleared += 1;
      clear();
    };

    const warm = await fetch(liveURL(server.url, "ses_simple"));
    assert.equal(warm.status, 200);
    const before = (await warm.json()) as any;
    assert.equal(cleared, 0);
    assert.equal(server.service.describe().cacheEntries, 1);

    // The live route is polled: a per-poll global flush would defeat the
    // requestKey coherence the route relies on.
    const polled = await fetch(
      `${liveURL(server.url, "ses_simple")}?refresh=1&since=0`,
    );
    assert.equal(polled.status, 200);
    const after = (await polled.json()) as any;
    assert.equal(cleared, 0);
    assert.equal(server.service.describe().cacheEntries, 1);
    assert.equal(after.totalInSession, before.totalInSession);

    // Every other route keeps its explicit refresh.
    const analysis = await fetch(
      `${server.url}/api/sessions/ses_simple/analysis?refresh=1`,
    );
    assert.equal(analysis.status, 200);
    assert.equal(cleared, 1);
  } finally {
    await server.close();
  }
});

test("HTTP live returns the derived snapshot shape", async () => {
  await withServer(toolsFixture(), async (base) => {
    const response = await fetch(liveURL(base, "ses_tools"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;

    assert.equal(body.revealAllowed, true);
    assert.equal(body.state, "ended");
    assert.equal(body.basis, "derived");
    assert.equal(typeof body.asOf, "number");
    assert.equal(body.openTurn, null);
    assert.deepEqual(body.warnings, []);
    assert.equal(body.coverage.complete, true);
    assert.ok(body.totalInSession > 0);
    assert.equal(body.newEvents, null);
    assert.equal("turnWindow" in body, false);

    const windowed = (await fetch(
      liveURL(base, "ses_tools", { lastTurns: 1 }),
    ).then((res) => res.json())) as any;
    assert.deepEqual(windowed.turnWindow, { last: 1, of: 1 });
  });
});

test("HTTP live trims new events by since and caps the page", async () => {
  await withServer(longFixture(30), async (base) => {
    const first = (await fetch(
      `${base}/api/sessions/ses_long/events?limit=1&direction=forward`,
    ).then((res) => res.json())) as any;
    const since = first.events[0].orderKey as string;

    const body = (await fetch(
      liveURL(base, "ses_long", { since }),
    ).then((res) => res.json())) as any;

    assert.equal(body.newEvents.length, 50);
    for (const event of body.newEvents) {
      assert.ok(event.orderKey > since, `${event.orderKey} is not after ${since}`);
    }
  });
});

test("HTTP live maps unknown sessions, rejects writes and answers HEAD", async () => {
  await withServer(simpleFixture(), async (base) => {
    const missing = await fetch(liveURL(base, "ses_missing"));
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as any).error, "session_not_found");

    const post = await fetch(liveURL(base, "ses_simple"), methods());
    assert.equal(post.status, 405);
    assert.equal(((await post.json()) as any).error, "method_not_allowed");

    const head = await fetch(liveURL(base, "ses_simple"), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
});

test("HTTP live maps a locked database to a stable 503", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    allowReveal: true,
  });
  try {
    server.service.liveSnapshot = async () => {
      throw new DatabaseBusyError("database is locked");
    };
    const response = await fetch(liveURL(server.url, "ses_simple"));
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as any).error, "database_busy");
  } finally {
    await server.close();
  }
});

test("HTTP live requires the access token when one is configured", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const token = generateToken();
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    allowReveal: true,
    authToken: token,
  });
  try {
    const unauthorized = await fetch(liveURL(server.url, "ses_simple"));
    assert.equal(unauthorized.status, 401);
    assert.equal(((await unauthorized.json()) as any).error, "unauthorized");

    const authorized = await fetch(liveURL(server.url, "ses_simple"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.status, 200);
    assert.equal(((await authorized.json()) as any).state, "ended");
  } finally {
    await server.close();
  }
});

test("HTTP live redacts by default and reveals under the reveal gate", async () => {
  await withServer(secretsFixture(), async (base) => {
    const redacted = (await fetch(
      liveURL(base, "ses_secrets", { since: "0" }),
    ).then((res) => res.json())) as any;
    const redactedText = JSON.stringify(redacted);
    assert.doesNotMatch(redactedText, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(redactedText, /\[REDACTED/);

    const revealed = (await fetch(
      liveURL(base, "ses_secrets", { since: "0", reveal: 1 }),
    ).then((res) => res.json())) as any;
    assert.match(
      JSON.stringify(revealed),
      /sk-abcdefghijklmnopqrstuvwxyz/,
    );
  });

  await withServer(
    secretsFixture(),
    async (base) => {
      const forbidden = await fetch(
        liveURL(base, "ses_secrets", { reveal: 1 }),
      );
      assert.equal(forbidden.status, 403);
      assert.equal(
        ((await forbidden.json()) as any).error,
        "reveal_disabled",
      );
    },
    false,
  );
});

/**
 * Three one-turn sessions that all record the same failing tool, so the
 * benchmark's recurring-pattern group-by has a real group to report. `agent`
 * and `updated` distinguish the candidates and pin the recency order.
 */
function benchmarkFixture(): Fixture {
  const entry = (
    id: string,
    agent: string,
    outcome: "succeeded" | "failed",
    updated: number,
  ) => ({
    meta: session(id, {
      agent,
      outcome,
      time: { created: BASE, updated, busy: BASE, idle: updated },
    }),
    messages: [
      user(`${id}_u1`, 1, BASE),
      assistant({
        id: `${id}_a1`,
        seq: 2,
        created: BASE + 100,
        streamed: BASE + 300,
        completed: BASE + 400,
        content: [
          toolBlock({
            name: "grep",
            created: BASE + 150,
            ran: BASE + 200,
            completed: BASE + 250,
            status: "error",
            input: { pattern: "TODO" },
            output: "",
          }),
        ],
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 50, cacheWrite: 0 },
        cost: 0.01,
      }),
      idle(`${id}_i1`, 3, BASE + 500, outcome),
    ],
  });
  return fixture([
    entry("ses_new", "build", "succeeded", BASE + 9_000),
    entry("ses_mid", "explorer", "failed", BASE + 8_000),
    entry("ses_old", "build", "succeeded", BASE + 1_000),
  ]);
}

/** Builds a benchmark URL from the exported route constant. */
function benchmarkURL(base: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params);
  const suffix = search.toString();
  return `${base}${BENCHMARK_PATH}${suffix ? `?${suffix}` : ""}`;
}

test("HTTP benchmark returns grouped rollups, patterns and provenance notes", async () => {
  await withServer(benchmarkFixture(), async (base) => {
    const body = (await fetch(
      benchmarkURL(base, { directory: "fixtures", groupBy: "agent" }),
    ).then((res) => res.json())) as any;
    assert.equal(body.revealAllowed, true);

    const benchmark = body.benchmark;
    assert.equal(benchmark.groupBy, "agent");
    assert.deepEqual(
      benchmark.groups.map((group: any) => group.key),
      ["build", "explorer"],
    );
    assert.deepEqual(
      benchmark.groups.map((group: any) => group.count),
      [2, 1],
    );
    assert.equal(benchmark.overall.count, 3);
    assert.equal(benchmark.overall.rollups.turns, 3);
    assert.equal(benchmark.overall.rollups.costSum.basis, "derived");
    assert.equal(benchmark.overall.rollups.costPerSession.value, 0.01);
    assert.equal(benchmark.overall.rollups.completions.succeeded, 2);
    assert.equal(benchmark.overall.rollups.completions.failed, 1);
    assert.equal(benchmark.sessionsCapped, false);
    assert.equal(benchmark.candidatesConsidered, 3);
    assert.match(
      benchmark.basisNotes[0],
      /^Compared 3 of 3 candidate session\(s\)/,
    );

    const pattern = benchmark.recurringPatterns.find(
      (item: any) => item.kind === "failing-tool",
    );
    assert.equal(pattern.key, "grep");
    assert.equal(pattern.sessionCount, 3);
    assert.deepEqual(pattern.sessionIDs, ["ses_new", "ses_mid", "ses_old"]);

    const bounded = (await fetch(
      benchmarkURL(base, { from: String(BASE + 5_000) }),
    ).then((res) => res.json())) as any;
    assert.equal(bounded.benchmark.overall.count, 2);
    assert.equal(bounded.benchmark.candidatesConsidered, 2);
  });
});

test("HTTP benchmark requires a filter and validates the closed vocabularies", async () => {
  await withServer(benchmarkFixture(), async (base) => {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, "invalid_filters"],
      [{ groupBy: "model" }, "invalid_filters"],
      [{ agent: "   " }, "invalid_filters"],
      [{ agent: "build", from: "not-a-number" }, "invalid_filters"],
      [{ agent: "build", to: "1e" }, "invalid_filters"],
      [{ agent: "build", groupBy: "directory" }, "invalid_group_by"],
      [{ agent: "build", outcome: "pending" }, "invalid_filters"],
      [{ agent: "build", taskType: "retry" }, "invalid_filters"],
    ];
    for (const [params, code] of cases) {
      const response = await fetch(benchmarkURL(base, params));
      assert.equal(response.status, 400, JSON.stringify(params));
      assert.equal(
        ((await response.json()) as any).error,
        code,
        JSON.stringify(params),
      );
    }

    const empty = await fetch(
      benchmarkURL(base, { agent: "nobody", groupBy: "agent" }),
    );
    assert.equal(empty.status, 200);
    const body = (await empty.json()) as any;
    assert.equal(body.benchmark.overall.count, 0);
    assert.deepEqual(body.benchmark.groups, []);
    assert.deepEqual(body.benchmark.recurringPatterns, []);
    assert.equal(body.benchmark.sessionsCapped, false);
    assert.match(body.benchmark.basisNotes[0], /^Compared 0 of 0/);
  });
});

test("HTTP benchmark is GET-only, answers HEAD and requires the access token", async () => {
  await withServer(benchmarkFixture(), async (base) => {
    const url = benchmarkURL(base, { agent: "build" });
    const post = await fetch(url, methods());
    assert.equal(post.status, 405);
    assert.equal(((await post.json()) as any).error, "method_not_allowed");

    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  const { path } = writeFixtureDb(benchmarkFixture());
  const token = generateToken();
  const server = await createObservabilityServer({
    dbPath: path,
    port: 0,
    allowReveal: true,
    authToken: token,
  });
  try {
    const unauthorized = await fetch(benchmarkURL(server.url, { agent: "build" }));
    assert.equal(unauthorized.status, 401);
    assert.equal(((await unauthorized.json()) as any).error, "unauthorized");

    const authorized = await fetch(
      benchmarkURL(server.url, { agent: "build" }),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(authorized.status, 200);
    assert.equal(
      ((await authorized.json()) as any).benchmark.overall.count,
      2,
    );
  } finally {
    await server.close();
  }
});

test("HTTP benchmark redacts by default and carries no payload text", async () => {
  await withServer(secretsFixture(), async (base) => {
    const redacted = (await fetch(
      benchmarkURL(base, { directory: "fixtures" }),
    ).then((res) => res.json())) as any;
    assert.equal(redacted.benchmark.overall.count, 1);
    assert.doesNotMatch(
      JSON.stringify(redacted),
      /sk-supersecretvalue12345/,
    );

    const revealed = (await fetch(
      benchmarkURL(base, { directory: "fixtures", reveal: "1" }),
    ).then((res) => res.json())) as any;
    assert.equal(revealed.benchmark.overall.count, 1);
    assert.doesNotMatch(
      JSON.stringify(revealed),
      /sk-supersecretvalue12345/,
    );
  });

  await withServer(
    secretsFixture(),
    async (base) => {
      const forbidden = await fetch(
        benchmarkURL(base, { directory: "fixtures", reveal: "1" }),
      );
      assert.equal(forbidden.status, 403);
      assert.equal(
        ((await forbidden.json()) as any).error,
        "reveal_disabled",
      );
    },
    false,
  );
});

test("HTTP benchmark names the windowed exclusion without dropping full-range sessions", async () => {
  await withServer(incompleteFixture(), async (base) => {
    const body = (await fetch(
      benchmarkURL(base, { directory: "fixtures" }),
    ).then((res) => res.json())) as any;
    const rollups = body.benchmark.overall.rollups;

    // A benchmark always loads the full range, so every compared session is
    // comparable: an unfinished recording is not a windowed one.
    assert.equal(body.benchmark.overall.count, 1);
    assert.equal(rollups.windowedCount, 0);
    assert.equal(rollups.averagedSessions, 1);
    assert.equal(rollups.completions.unrecorded, 1);
    assert.match(
      body.benchmark.basisNotes[1],
      /^Windowed sessions \(coverage\.complete = false\) are counted in sums and completion counts and excluded from averages; 0 of 1 compared session\(s\) are windowed/,
    );
  });
});

function methods(): RequestInit {
  return { method: "POST" };
}
