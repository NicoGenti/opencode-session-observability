import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// @ts-expect-error - plain browser module without type declarations
import { LIVE_POLL_MS, liveBadgeHtml, liveStaleHtml, liveWarningsHtml } from "../src/ui/live.js";

const AS_OF = 1_700_000_000_000;

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "running",
    basis: "derived",
    asOf: AS_OF,
    openTurn: null,
    warnings: [],
    totalInSession: 3,
    ...overrides,
  };
}

function warning(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "retry-count",
    label: "Retry count",
    triggered: true,
    level: "watch",
    evaluable: true,
    note: "9 retry event(s) recorded",
    eventIDs: ["evt_1", "evt_2"],
    turnIDs: [],
    basis: "derived",
    uncertainty: ["session-in-progress"],
    ...overrides,
  };
}

test("the badge distinguishes live, incomplete and historical states in text", () => {
  const live = liveBadgeHtml(snapshot());
  assert.match(live, /Live — recording/);
  assert.match(live, /live-badge-live/);

  for (const state of ["idle", "unknown"]) {
    const incomplete = liveBadgeHtml(snapshot({ state }));
    assert.match(incomplete, /Incomplete — no terminal outcome/);
    assert.match(incomplete, /live-badge-incomplete/);
  }

  const historical = liveBadgeHtml(snapshot({ state: "ended" }));
  assert.match(historical, /Historical — recording complete/);
  assert.match(historical, /live-badge-historical/);
});

test("the badge keeps the derived basis and the asOf stamp", () => {
  const markup = liveBadgeHtml(snapshot());

  assert.match(markup, /derived · as of /);
  assert.match(markup, /2023-11-14T22:13:20\.000Z/);
  assert.match(markup, /live-badge-basis/);
  assert.doesNotMatch(markup, /stale, retrying/);
});

test("a stale frame keeps its badge and adds the retry marker", () => {
  const markup = liveBadgeHtml(snapshot({ stale: true }));

  assert.match(markup, /Live — recording/);
  assert.match(markup, /stale, retrying/);
  assert.match(markup, /live-stale/);
  assert.equal(liveStaleHtml(), '<span class="live-stale" role="status">stale, retrying</span>');
});

test("an unrecognized state falls back to the incomplete reading", () => {
  const markup = liveBadgeHtml(snapshot({ state: "surprise" }));

  assert.match(markup, /Incomplete — no terminal outcome/);
  assert.match(markup, /live-badge-incomplete/);
});

test("warning rows mirror the health-rule rhythm with capped event links", () => {
  const ids = Array.from({ length: 15 }, (_, index) => `evt_${index}`);
  const markup = liveWarningsHtml([
    warning({ eventIDs: ids }),
    warning({ id: "low-cache-hit", label: "Low cache hit rate", level: "strong", note: "6 of 7 turns" }),
  ]);

  assert.match(markup, /class="live-warnings-section"/);
  assert.match(markup, /Live warnings/);
  assert.match(markup, /class="health-rule live-warning"/);
  assert.match(markup, /Retry count/);
  assert.match(markup, /Low cache hit rate/);
  assert.match(markup, /health-level-strong/);
  assert.match(markup, /Triggered/);
  assert.match(markup, /9 retry event\(s\) recorded/);
  assert.match(markup, /never persisted or exported/);
  assert.equal((markup.match(/data-event-id=/g) ?? []).length, 12);
  assert.equal((markup.match(/data-event-id="evt_0"/g) ?? []).length, 1);
});

test("warning rows escape every dynamic string and render nothing when empty", () => {
  const markup = liveWarningsHtml([
    warning({
      label: '<script>alert("x")</script>',
      note: "<b>note</b>",
      eventIDs: ['evt"1'],
    }),
  ]);

  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;b&gt;note&lt;\/b&gt;/);
  assert.match(markup, /data-event-id="evt&quot;1"/);
  assert.equal(liveWarningsHtml([]), "");
  assert.equal(liveWarningsHtml(undefined), "");
});

test("live.js imports only ./format.js and touches no DOM", async () => {
  const source = await readFile(new URL("../src/ui/live.js", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(specifiers, ["./format.js"]);
  assert.doesNotMatch(source, /(^|[^\w.])document\./m);
  assert.doesNotMatch(source, /(^|[^\w.])window\./m);
  assert.equal(LIVE_POLL_MS, 5_000);
});

// ---------------------------------------------------------------------------
// app.js wiring
// ---------------------------------------------------------------------------

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const next = source.indexOf("\nfunction ", start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("the live toggle polls every 5 seconds and stops cleanly", async () => {
  const source = await appSource();
  const toggle = functionBody(source, "function toggleLive()");
  const stop = functionBody(source, "function stopLive()");

  assert.match(toggle, /stopLive\(\)/);
  assert.match(toggle, /void pollLive\(\)/);
  assert.match(toggle, /setInterval\(/);
  assert.match(toggle, /\},\s*5_000\);/);
  assert.match(stop, /clearInterval\(state\.liveTimer\)/);
  assert.match(stop, /state\.liveTimer = null/);
  assert.match(toggle, /state\.liveSince = lastSeenOrderKey\(\)/);
});

test("pollLive fetches the incremental endpoint with the orderKey cursor", async () => {
  const poll = functionBody(await appSource(), "async function pollLive()");

  assert.match(poll, /\/api\/sessions\/\$\{encodeURIComponent\(requestedSession\)\}\/live/);
  assert.match(poll, /\{ since \}/);
  assert.match(poll, /data\.newEvents/);
  assert.match(poll, /state\.liveSince = data\.newEvents\[data\.newEvents\.length - 1\]\.orderKey/);
});

test("the heavy refresh runs only on an open-turn, count or state change", async () => {
  const poll = functionBody(await appSource(), "async function pollLive()");

  assert.match(poll, /const openTurnChanged = \(data\.openTurn\?\.id \?\? null\) !==/);
  assert.match(poll, /const grew = \(data\.totalInSession \?\? 0\) >/);
  assert.match(poll, /const stateChanged = data\.state !== previous\?\.state/);
  assert.match(poll, /if \(previous && \(openTurnChanged \|\| grew \|\| stateChanged\)\) \{/);
  assert.match(poll, /await refreshCurrent\(\)/);
});

test("a failed poll keeps the previous frame with the stale marker", async () => {
  const poll = functionBody(await appSource(), "async function pollLive()");

  assert.match(poll, /catch \(error\) \{/);
  assert.match(poll, /state\.live = \{ \.\.\.state\.live, stale: true/);
  assert.match(poll, /renderLive\(\)/);
});

test("a session switch clears the live frame and in-flight ticket", async () => {
  const source = await appSource();
  const select = functionBody(source, "async function selectSession(");

  assert.match(select, /state\.live = null/);
  assert.match(select, /state\.liveSince = null/);
  assert.match(select, /liveRequestSeq \+= 1/);
});

test("the badge renders in the session header and warnings above the pane", async () => {
  const source = await appSource();
  const header = functionBody(source, "function renderHeader()");
  const renderLive = functionBody(source, "function renderLive()");

  assert.match(header, /id="live-badge-slot"/);
  assert.match(header, /renderLive\(\)/);
  assert.match(renderLive, /liveBadgeHtml\(state\.live\)/);
  assert.match(renderLive, /liveWarningsHtml\(warnings\)/);
  assert.match(renderLive, /dom\.liveWarnings\.hidden/);
  assert.match(source, /import \{ liveBadgeHtml, liveWarningsHtml \} from "\.\/live\.js";/);
  assert.match(source, /dom\.liveWarnings = \$\("#live-warnings"\)/);
});

test("the live warning container exists above the active pane", async () => {
  const html = await readFile(new URL("../src/ui/index.html", import.meta.url), "utf8");

  const warnings = html.indexOf('id="live-warnings"');
  const view = html.indexOf('id="view"');
  assert.ok(warnings >= 0 && view > warnings);
  assert.match(html, /follow the session every 5 seconds/i);
});

test("live styles use existing tokens only and no hex literals", async () => {
  const css = await readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8");
  const start = css.indexOf("/* -------------------------------------------------------------- live mode */");
  const end = css.indexOf("/* --------------------------------------------------------------- drawer */");
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end);

  assert.match(block, /\.live-badge \{/);
  assert.match(block, /\.live-badge-live/);
  assert.match(block, /\.live-badge-incomplete \{ border-style: dashed/);
  assert.match(block, /\.live-warning \{/);
  assert.match(block, /var\(--warning\)/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
});
