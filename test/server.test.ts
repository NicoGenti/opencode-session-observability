import test from "node:test";
import assert from "node:assert/strict";
import {
  EPISODE_COMPARE_PATH,
  SESSION_DIAGNOSTICS_PATTERN,
  createObservabilityServer,
} from "../src/server/http.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  secretsFixture,
  session,
  simpleFixture,
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

test("HTTP exports JSON, Markdown and HTML as attachments", async () => {
  await withServer(simpleFixture(), async (base) => {
    for (const [format, mime] of [
      ["json", "application/json"],
      ["markdown", "text/markdown"],
      ["html", "text/html"],
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
      const body = await response.text();
      assert.ok(body.length > 100);
      if (format === "json") {
        assert.equal(JSON.parse(body).session.id, "ses_simple");
      }
    }
  });
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

function methods(): RequestInit {
  return { method: "POST" };
}
