import test from "node:test";
import assert from "node:assert/strict";
import { createObservabilityServer } from "../src/server/http.ts";
import {
  secretsFixture,
  simpleFixture,
  toolsFixture,
  writeFixtureDb,
} from "./fixtures/build.ts";

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

function methods(): RequestInit {
  return { method: "POST" };
}
