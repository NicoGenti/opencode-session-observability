import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LIVE_POLL_MS,
  liveBadgeHtml,
  liveStaleHtml,
  liveUnavailableHtml,
  liveWarningsHtml,
  nextLiveCursor,
  shouldHeavyRefresh,
  shouldReplaceLiveWarnings,
  withStaleMarker,
  // @ts-expect-error - plain browser module without type declarations
} from "../src/ui/live.js";
// @ts-expect-error - plain browser module without type declarations
import { escapeHtml } from "../src/ui/format.js";
// @ts-expect-error - plain browser module without type declarations
import { liveErrorDetail } from "../src/ui/app.js";

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

test("the stale marker renders the poll error instead of dropping it", () => {
  const markup = liveStaleHtml("The OpenCode database is locked.");

  assert.match(markup, /stale, retrying — The OpenCode database is locked\./);
  assert.match(liveBadgeHtml(snapshot({ stale: true, staleError: "<b>busy</b>" })), /&lt;b&gt;busy&lt;\/b&gt;/);
  assert.doesNotMatch(liveStaleHtml("<b>busy</b>"), /<b>/);
  assert.equal(liveStaleHtml("   "), '<span class="live-stale" role="status">stale, retrying</span>');
});

test("a first-poll failure with no frame renders a visible unavailable state", () => {
  const markup = liveUnavailableHtml("Request failed (503)");

  assert.match(markup, /Live unavailable/);
  assert.match(markup, /poll failed — Request failed \(503\)/);
  assert.match(markup, /live-badge-unavailable/);
  assert.equal(liveUnavailableHtml(), liveUnavailableHtml(undefined));
  assert.match(liveUnavailableHtml(), /Live unavailable/);
});

/**
 * The text app.js appends to the static marker must be the same text
 * `live.js` would have escaped into the template: same whitespace collapse,
 * same cap, same words.
 */
test("the app error detail matches the rendered marker text", () => {
  const detailMarkup = (detail: string) =>
    `<span class="live-badge live-badge-unavailable"><span class="live-badge-state">Live unavailable</span><span class="live-badge-basis">poll failed${
      detail ? ` — ${escapeHtml(detail)}` : ""
    }</span></span>`;

  const samples = [
    "",
    "   ",
    "Request failed (503)",
    "  The OpenCode\n\t database is locked.  ",
    "<img src=x onerror=alert(1)>",
    "x".repeat(140),
  ];
  for (const sample of samples) {
    const detail = liveErrorDetail(sample);
    // The DOM path renders this text node; the string builder must agree.
    assert.equal(liveUnavailableHtml(sample), detailMarkup(detail), sample);
  }

  const stale = liveBadgeHtml(
    snapshot({ stale: true, staleError: "<b>busy</b>" }),
  );
  assert.ok(
    stale.includes(
      '<span class="live-stale" role="status">stale, retrying — &lt;b&gt;busy&lt;/b&gt;</span>',
    ),
  );
  assert.equal(liveErrorDetail("<b>busy</b>"), "<b>busy</b>");
  assert.equal(liveErrorDetail(undefined), "");
  assert.equal(liveErrorDetail(42), "");
});

test("the badge renders the since cursor yield as a +N events affordance", () => {
  const none = liveBadgeHtml(snapshot());
  assert.doesNotMatch(none, /live-new-events/);

  const page = snapshot({
    newEvents: [
      { id: "evt_1", orderKey: "0001" },
      { id: "evt_2", orderKey: "0002" },
    ],
  });
  const markup = liveBadgeHtml(page);
  assert.match(markup, /class="live-new-events"/);
  assert.match(markup, />\+2 events</);

  const single = liveBadgeHtml(snapshot({ newEvents: [{ id: "evt_1", orderKey: "0001" }] }));
  assert.match(single, />\+1 event</);
  assert.doesNotMatch(single, /\+1 events/);

  // A non-array payload from a hostile/broken response renders nothing.
  assert.doesNotMatch(liveBadgeHtml(snapshot({ newEvents: "nope" })), /live-new-events/);
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
// DOM-free poll decisions
// ---------------------------------------------------------------------------

test("the heavy refresh is skipped on the first tick and on an unchanged frame", () => {
  const frame = snapshot({ openTurn: { id: "turn_1" }, totalInSession: 7 });

  assert.equal(shouldHeavyRefresh(null, frame), false);
  assert.equal(shouldHeavyRefresh(undefined, frame), false);
  assert.equal(shouldHeavyRefresh(frame, null), false);
  assert.equal(shouldHeavyRefresh(frame, snapshot({ ...frame })), false);
});

test("the heavy refresh fires on a new open turn, event count or state", () => {
  const frame = snapshot({ openTurn: { id: "turn_1" }, totalInSession: 7 });

  assert.equal(
    shouldHeavyRefresh(frame, snapshot({ ...frame, openTurn: { id: "turn_2" } })),
    true,
  );
  assert.equal(
    shouldHeavyRefresh(frame, snapshot({ ...frame, openTurn: null })),
    true,
  );
  assert.equal(
    shouldHeavyRefresh(frame, snapshot({ ...frame, totalInSession: 8 })),
    true,
  );
  assert.equal(
    shouldHeavyRefresh(frame, snapshot({ ...frame, state: "idle" })),
    true,
  );
});

test("a 503-style failure keeps the frame and renders the error on it", () => {
  const frame = snapshot({ openTurn: { id: "turn_1" } });
  const stale = withStaleMarker(frame, "The OpenCode database is locked. Retry when the session is idle.");

  assert.ok(stale);
  assert.equal(stale.stale, true);
  assert.equal(stale.openTurn.id, "turn_1");
  assert.equal(stale.staleError, "The OpenCode database is locked. Retry when the session is idle.");
  assert.match(liveBadgeHtml(stale), /stale, retrying — The OpenCode database is locked/);

  // A long message is collapsed and capped so the marker stays one line.
  const long = withStaleMarker(frame, `${"x".repeat(200)}\n\nrest`);
  assert.ok(long.staleError.length <= 90);
  assert.doesNotMatch(long.staleError, /\n/);

  assert.equal(withStaleMarker(null, "boom"), null);
  assert.equal(withStaleMarker(undefined, "boom"), null);
});

test("the since cursor follows the last new event and survives an empty page", () => {
  assert.equal(nextLiveCursor("0005", [{ orderKey: "0006" }, { orderKey: "0008" }]), "0008");
  assert.equal(nextLiveCursor("0005", []), "0005");
  assert.equal(nextLiveCursor("0005", null), "0005");
  assert.equal(nextLiveCursor("0005", undefined), "0005");
  // A malformed tail is skipped rather than poisoning the cursor.
  assert.equal(nextLiveCursor("0005", [{ orderKey: "" }, { orderKey: "0009" }]), "0009");
  // A session switch resets the cursor to null; the next tick re-seeds it.
  assert.equal(nextLiveCursor(null, []), null);
  assert.equal(nextLiveCursor(undefined, []), null);
  assert.equal(nextLiveCursor("", []), null);
});

test("only changed warning markup replaces the live region", () => {
  const first = liveWarningsHtml([warning()]);
  const second = liveWarningsHtml([warning({ note: "10 retry event(s) recorded" })]);

  assert.equal(shouldReplaceLiveWarnings(null, ""), true);
  assert.equal(shouldReplaceLiveWarnings(liveWarningsHtml([warning()]), first), false);
  assert.equal(shouldReplaceLiveWarnings(first, second), true);
  assert.equal(shouldReplaceLiveWarnings(first, ""), true);
  // Equal input yields byte-identical markup, which is what the gate compares.
  assert.equal(liveWarningsHtml([warning()]), first);
});

// ---------------------------------------------------------------------------
// app.js wiring
// ---------------------------------------------------------------------------

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

/**
 * One function's source. The slice stops right after the first `}` in column 0
 * (tolerating CRLF), so a nested block or the next declaration cannot widen it.
 */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  let end = -1;
  for (
    let index = source.indexOf("\n}", start + header.length);
    index !== -1;
    index = source.indexOf("\n}", index + 2)
  ) {
    const after = source[index + 2];
    if (after === undefined || after === "\n" || after === "\r") {
      end = index + 2;
      break;
    }
  }
  return source.slice(start, end === -1 ? source.length : end);
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
  // The cursor is re-seeded by the first tick from the session on screen.
  assert.match(toggle, /state\.liveSince = null/);
  assert.doesNotMatch(toggle, /lastSeenOrderKey\(\)/);
});

test("pollLive fetches the incremental endpoint with the orderKey cursor", async () => {
  const source = await appSource();
  const poll = functionBody(source, "async function pollLive()");
  const cursor = functionBody(source, "function liveSinceCursor()");

  assert.match(poll, /\/api\/sessions\/\$\{encodeURIComponent\(requestedSession\)\}\/live/);
  assert.match(poll, /\{ since \}/);
  assert.match(poll, /state\.liveSince = nextLiveCursor\(since \?\? null, data\.newEvents\)/);
  assert.match(cursor, /nextLiveCursor\(null, state\.live\?\.newEvents\)/);
  assert.match(cursor, /lastSeenOrderKey\(\)/);
});

test("the heavy refresh decision comes from the DOM-free helper", async () => {
  const poll = functionBody(await appSource(), "async function pollLive()");

  assert.match(poll, /const heavy = shouldHeavyRefresh\(previous, data\)/);
  assert.match(poll, /if \(heavy\) await refreshCurrent\(\)/);
  assert.doesNotMatch(poll, /openTurnChanged|stateChanged|const grew/);
});

test("a failed poll keeps the previous frame with the stale marker", async () => {
  const poll = functionBody(await appSource(), "async function pollLive()");

  assert.match(poll, /catch \(error\) \{/);
  assert.match(poll, /state\.live = withStaleMarker\(state\.live, error\.message\)/);
  assert.match(poll, /state\.liveError = state\.live === null \? error\.message : null/);
  assert.match(poll, /renderLive\(\)/);
});

test("the live poll never asks the server to flush its cache", async () => {
  const source = await appSource();
  const poll = functionBody(source, "async function pollLive()");
  const refresh = functionBody(source, "async function refreshCurrent(options = {})");

  assert.doesNotMatch(poll, /refresh: 1/);
  assert.doesNotMatch(poll, /force/);
  assert.match(refresh, /force: options\.force === true/);
  assert.match(
    source,
    /addEventListener\("click", \(\) => void refreshCurrent\(\{ force: true \}\)\)/,
  );
});

test("loadSessionData only forwards refresh when the caller forces it", async () => {
  const load = functionBody(await appSource(), "async function loadSessionData(options = {})");

  assert.match(load, /refresh: options\.force === true \? 1 : undefined/);
  // The cursor belongs to the analysis just replaced.
  assert.match(load, /state\.liveSince = null/);
});

test("a session switch clears the live frame and in-flight ticket", async () => {
  const source = await appSource();
  const select = functionBody(source, "async function selectSession(");

  assert.match(select, /state\.live = null/);
  assert.match(select, /state\.liveError = null/);
  assert.match(select, /state\.liveSince = null/);
  assert.match(select, /liveWarningsMarkup = null/);
  assert.match(select, /liveRequestSeq \+= 1/);
});

test("the badge renders in the session header and warnings above the pane", async () => {
  const source = await appSource();
  const header = functionBody(source, "function renderHeader()");
  const renderLive = functionBody(source, "function renderLive()");

  assert.match(header, /id="live-badge-slot"/);
  assert.match(header, /renderLive\(\)/);
  assert.match(renderLive, /liveBadgeHtml\(/);
  assert.match(renderLive, /liveUnavailableHtml\(\)/);
  assert.match(renderLive, /liveWarningsHtml\(warnings\)/);
  assert.match(renderLive, /shouldReplaceLiveWarnings\(liveWarningsMarkup, markup\)/);
  assert.match(renderLive, /dom\.liveWarnings\.hidden/);
  // The poll error never reaches the HTML sink: the escaped template is built
  // without it and the detail is appended as text (issue #78).
  assert.match(renderLive, /liveErrorDetail\(state\.live\.staleError\)/);
  assert.match(renderLive, /liveErrorDetail\(state\.liveError\)/);
  assert.match(renderLive, /\{ \.\.\.state\.live, staleError: undefined \}/);
  assert.match(renderLive, /querySelector\("\.live-stale"\)/);
  assert.match(renderLive, /querySelector\("\.live-badge-basis"\)/);
  assert.match(renderLive, /\.append\(` — \$\{detail\}`\)/);
  assert.doesNotMatch(renderLive, /liveUnavailableHtml\(state\.liveError\)/);
  assert.doesNotMatch(renderLive, /innerHTML = state\.live/);
  assert.match(
    source,
    /import \{[^}]*liveWarningsHtml[^}]*\} from "\.\/live\.js";/,
  );
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
  assert.match(block, /\.live-badge-unavailable \{ border-style: dashed/);
  assert.match(block, /\.live-new-events \{/);
  assert.match(block, /\.live-warning \{/);
  assert.match(block, /var\(--warning\)/);
  // The warning hue is a border/tint only; it is never used as the text colour.
  assert.doesNotMatch(block, /color:\s*var\(--warning\)/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
});
