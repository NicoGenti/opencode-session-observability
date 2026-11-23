import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { EventIndexEntry } from "../src/core/types.ts";
import type { LiveSnapshot } from "../src/core/live.ts";
import {
  LIVE_POLL_MS,
  LIVE_UNAVAILABLE_VIEW,
  LIVE_WARNINGS_NOTE,
  MAX_LIVE_EVENT_LINKS,
  cappedEventIDs,
  eventLinkLabel,
  liveBadgeView,
  liveErrorDetail,
  liveSinceCursor,
  liveStaleText,
  liveUnavailableText,
  liveWarningLevel,
  liveWarningsSignature,
  newEventsLabel,
  nextLiveCursor,
  shouldHeavyRefresh,
  shouldReplaceLiveWarnings,
  withStaleMarker,
} from "../src/web/lib/live.ts";

const AS_OF = 1_700_000_000_000;

function snapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    state: "running",
    basis: "derived",
    asOf: AS_OF,
    openTurn: null,
    warnings: [],
    coverage: {
      fromSeq: 1,
      toSeq: 3,
      minSeq: 1,
      maxSeq: 3,
      complete: true,
      messages: 2,
      windowMessages: 2,
    },
    totalInSession: 3,
    newEvents: null,
    ...overrides,
  };
}

function entry(orderKey: string): EventIndexEntry {
  return {
    id: `evt_${orderKey}`,
    messageID: "msg_1",
    sessionID: "ses_1",
    seq: 1,
    orderKey,
    timestamp: AS_OF,
    kind: "text",
    actor: "assistant",
    title: "t",
    preview: "",
    agent: null,
    model: null,
    provider: null,
    status: null,
    toolName: null,
    toolStatus: null,
    tokens: null,
    cost: null,
    stepID: null,
    turnID: null,
    flags: {
      error: false,
      retry: false,
      compaction: false,
      context: false,
      subagent: false,
      approval: false,
      uncertain: false,
    },
    uncertainty: [],
  };
}

/* ------------------------------------------------------------- badge copy */

test("the badge distinguishes live, incomplete and historical states in text", () => {
  assert.deepEqual(liveBadgeView(snapshot()), {
    label: "Live — recording",
    kind: "live",
  });
  for (const state of ["idle", "unknown"] as const) {
    assert.deepEqual(liveBadgeView(snapshot({ state })), {
      label: "Incomplete — no terminal outcome",
      kind: "incomplete",
    });
  }
  assert.deepEqual(liveBadgeView(snapshot({ state: "ended" })), {
    label: "Historical — recording complete",
    kind: "historical",
  });
  // Unknown or hostile states fall back to the incomplete reading.
  assert.equal(
    liveBadgeView({ state: "surprise" }).label,
    "Incomplete — no terminal outcome",
  );
  assert.equal(liveBadgeView(null).kind, "incomplete");
  assert.deepEqual(LIVE_UNAVAILABLE_VIEW, {
    label: "Live unavailable",
    kind: "unavailable",
  });
});

test("the since cursor yield is a +N events affordance", () => {
  assert.equal(newEventsLabel(null), null);
  assert.equal(newEventsLabel([]), null);
  assert.equal(newEventsLabel("nope"), null);
  assert.equal(newEventsLabel([{ orderKey: "1" }]), "+1 event");
  assert.equal(newEventsLabel([{ orderKey: "1" }, { orderKey: "2" }]), "+2 events");
});

/* --------------------------------------------------------- error markers */

test("the poll error is collapsed and capped to one line", () => {
  assert.equal(liveErrorDetail(undefined), "");
  assert.equal(liveErrorDetail(42), "");
  assert.equal(liveErrorDetail("   "), "");
  assert.equal(liveErrorDetail("  The database\n\t is locked.  "), "The database is locked.");
  const long = liveErrorDetail("x".repeat(200));
  assert.equal(long.length, 90);
  assert.ok(long.endsWith("…"));
  // The escaped detail never carries markup of its own.
  assert.equal(liveErrorDetail("<b>busy</b>"), "<b>busy</b>");
});

test("stale and unavailable markers keep the documented wording", () => {
  assert.equal(liveStaleText(), "stale, retrying");
  assert.equal(liveStaleText("   "), "stale, retrying");
  assert.equal(
    liveStaleText("The OpenCode database is locked."),
    "stale, retrying — The OpenCode database is locked.",
  );
  assert.equal(liveUnavailableText(), "poll failed");
  assert.equal(liveUnavailableText("Request failed (503)"), "poll failed — Request failed (503)");
});

/* --------------------------------------------------------- poll decisions */

test("the heavy refresh is skipped on the first tick and an unchanged frame", () => {
  const frame = snapshot({ openTurn: null, totalInSession: 7 });
  assert.equal(shouldHeavyRefresh(null, frame), false);
  assert.equal(shouldHeavyRefresh(undefined, frame), false);
  assert.equal(shouldHeavyRefresh(frame, null), false);
  assert.equal(shouldHeavyRefresh(frame, snapshot({ totalInSession: 7 })), false);
});

test("the heavy refresh fires on an open-turn change, event growth or a state move", () => {
  const openTurn = {
    index: 1,
    id: "turn_1",
    startedAt: AS_OF,
    steps: 1,
    tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { value: 0, basis: "derived" as const },
    uncertainty: ["session-in-progress"],
  };
  const frame = snapshot({ openTurn, totalInSession: 7 });

  assert.equal(shouldHeavyRefresh(frame, { ...frame }), false);
  // A new open turn, or the open turn closing, is a change.
  assert.equal(
    shouldHeavyRefresh(frame, snapshot({ openTurn: { ...openTurn, id: "turn_2" }, totalInSession: 7 })),
    true,
  );
  assert.equal(shouldHeavyRefresh(frame, snapshot({ openTurn: null, totalInSession: 7 })), true);
  // So is one more recorded event, or a moved liveness state.
  assert.equal(shouldHeavyRefresh(frame, snapshot({ totalInSession: 8 })), true);
  assert.equal(shouldHeavyRefresh(frame, snapshot({ state: "idle" })), true);
});

test("a failed poll keeps the frame and carries the collapsed error", () => {
  const frame = snapshot();
  const stale = withStaleMarker(frame, "The OpenCode database is locked. Retry when idle.");

  assert.ok(stale);
  assert.equal(stale.stale, true);
  assert.equal(stale.staleError, "The OpenCode database is locked. Retry when idle.");
  assert.equal(stale.totalInSession, 3);
  assert.equal(withStaleMarker(null, "boom"), null);
  assert.equal(withStaleMarker(undefined, "boom"), null);

  const quiet = withStaleMarker(frame, "   ");
  assert.ok(quiet);
  assert.equal(quiet.stale, true);
  assert.equal("staleError" in quiet, false);
});

test("the since cursor follows the last new event and survives an empty page", () => {
  assert.equal(nextLiveCursor("0005", [{ orderKey: "0006" }, { orderKey: "0008" }]), "0008");
  assert.equal(nextLiveCursor("0005", []), "0005");
  assert.equal(nextLiveCursor("0005", null), "0005");
  assert.equal(nextLiveCursor("0005", undefined), "0005");
  assert.equal(nextLiveCursor("0005", [{ orderKey: "" }, { orderKey: "0009" }]), "0009");
  assert.equal(nextLiveCursor(null, []), null);
  assert.equal(nextLiveCursor(undefined, []), null);
  assert.equal(nextLiveCursor("", []), null);
  // Malformed entries are skipped rather than trusted.
  assert.equal(nextLiveCursor("0005", [{ orderKey: 7 }, { orderKey: "0002" }]), "0002");
});

test("the poll cursor prefers the tracked value, then the frame, then the analysis", () => {
  const frame = snapshot({ newEvents: [entry("0006"), entry("0008")] });
  assert.equal(liveSinceCursor("0010", frame, "0004"), "0010");
  assert.equal(liveSinceCursor(null, frame, "0004"), "0008");
  assert.equal(liveSinceCursor(null, snapshot({ newEvents: [] }), "0004"), "0004");
  assert.equal(liveSinceCursor(null, null, undefined), null);
});

test("only a changed warning set replaces the live region", () => {
  const first = [{ id: "retry-count", label: "Retry count", note: "9 retries" }];
  const second = [{ id: "retry-count", label: "Retry count", note: "10 retries" }];

  assert.equal(shouldReplaceLiveWarnings(null, ""), true);
  assert.equal(shouldReplaceLiveWarnings("", ""), false);
  assert.equal(
    shouldReplaceLiveWarnings(liveWarningsSignature(first), liveWarningsSignature(first)),
    false,
  );
  assert.equal(
    shouldReplaceLiveWarnings(liveWarningsSignature(first), liveWarningsSignature(second)),
    true,
  );
  assert.equal(liveWarningsSignature([]), "");
  assert.equal(liveWarningsSignature(null), "");
});

test("warning evidence ids are capped, de-duplicated and labelled", () => {
  const ids = Array.from({ length: 15 }, (_, index) => `evt_${index}`);
  const capped = cappedEventIDs({ eventIDs: [ids[0], ids[0], ...ids.slice(1)] });
  assert.equal(capped.length, MAX_LIVE_EVENT_LINKS);
  assert.deepEqual(capped.slice(0, 3), ["evt_0", "evt_1", "evt_2"]);
  assert.deepEqual(cappedEventIDs({ eventIDs: [42, "", "evt_2"] }), ["evt_2"]);
  assert.deepEqual(cappedEventIDs(null), []);
  assert.equal(eventLinkLabel(0), "Open event 1 in Trajectory");
  assert.equal(eventLinkLabel(11), "Open event 12 in Trajectory");
  assert.equal(liveWarningLevel("watch"), "watch");
  assert.equal(liveWarningLevel("strong"), "strong");
  assert.equal(liveWarningLevel("critical"), null);
  assert.match(LIVE_WARNINGS_NOTE, /never persisted or exported/);
});

/* ------------------------------------------------------- poller invariants */

async function hookSource(): Promise<string> {
  return readFile(new URL("../src/web/hooks/useLivePoll.ts", import.meta.url), "utf8");
}

test("the poller is one 5 s interval, visibility-gated and sequence-guarded", async () => {
  const source = await hookSource();
  assert.equal(LIVE_POLL_MS, 5_000);
  // Exactly one timer is armed and cleared; the app mounts the hook once.
  assert.equal((source.match(/setInterval\(/g) ?? []).length, 1);
  assert.equal((source.match(/clearInterval\(/g) ?? []).length, 1);
  assert.match(source, /LIVE_POLL_MS/);
  assert.match(source, /visibilityState === "visible"/);
  assert.match(source, /visibilitychange/);
  // A session switch or an off toggle invalidates in-flight work, and both the
  // success and the failure path check the ticket before touching state.
  assert.match(source, /sequence\.current \+= 1/);
  assert.match(source, /ticket !== sequence\.current/);
  assert.match(source, /withStaleMarker/);
  assert.match(source, /shouldHeavyRefresh/);
  assert.match(source, /nextLiveCursor/);
  assert.match(source, /shouldReplaceLiveWarnings/);
  // The request is the incremental endpoint with the `since` cursor.
  assert.match(source, /\/api\/sessions\/\$\{encodeURIComponent\(sessionID\)\}\/live/);
  assert.match(source, /\{ since: cursor \?\? undefined \}/);
  // A failed first poll leaves `error`; the hook never blanks the frame itself.
  assert.doesNotMatch(source, /refresh: 1/);
});

test("the live view renders the badge and the warnings above guardrails", async () => {
  const view = await readFile(
    new URL("../src/web/components/TrajectoryView.tsx", import.meta.url),
    "utf8",
  );
  const badge = view.indexOf("<LiveBadge");
  const warnings = view.indexOf("<LiveWarnings");
  const guardrails = view.indexOf("<GuardrailsSection");
  assert.ok(badge >= 0 && warnings > badge, "badge before warnings");
  assert.ok(guardrails > warnings, "guardrails sit below the live warnings");
});
