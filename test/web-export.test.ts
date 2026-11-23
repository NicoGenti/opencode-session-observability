import test from "node:test";
import assert from "node:assert/strict";
import type { EventIndexEntry, NormalizedEvent } from "../src/core/types.ts";
import {
  DEFAULT_DOWNLOAD_NAME,
  EXPORT_FORMATS,
  EXPORT_SESSION_MISSING,
  REVEAL_BANNER,
  REVEAL_CONFIRM,
  REVEAL_COPY_WARNING,
  TOAST,
  TOAST_MS,
  digestToastMessage,
  exportExtension,
  exportFilename,
  exportRequestPath,
  exportToastMessage,
  isSafeDownloadName,
  metricsLine,
  resolveExportTarget,
  safeDownloadName,
  sessionExportName,
  turnChainText,
} from "../src/web/lib/export.ts";
import { ToastController } from "../src/web/lib/toast.ts";

/* ------------------------------------------------------------- filename */

const CLOCK = new Date("2026-01-02T03:04:05.678Z");

test("the export name is slug, client stamp and extension", () => {
  assert.equal(exportFilename("My Session", "markdown", CLOCK), "my-session-20260102T030405Z.md");
  assert.equal(exportFilename("My Session", "json", CLOCK), "my-session-20260102T030405Z.json");
  assert.equal(exportFilename("My Session", "html", CLOCK), "my-session-20260102T030405Z.html");
  // The shared `session` fallback, never an empty slug.
  assert.equal(exportFilename("", "json", CLOCK), "session-20260102T030405Z.json");
  assert.equal(exportFilename(null, "json", CLOCK), "session-20260102T030405Z.json");
  // The slug alphabet is the core one: punctuation collapses, no empty tail.
  assert.equal(exportFilename("Café — 100% done!", "json", CLOCK), "cafe-100-done-20260102T030405Z.json");
  assert.deepEqual([...EXPORT_FORMATS], ["json", "markdown", "html"]);
  assert.equal(exportExtension("markdown"), "md");
  assert.equal(exportExtension("json"), "json");
});

test("a session export is named from the record, never from the route id", () => {
  assert.equal(sessionExportName({ title: "Build task", slug: "x" }, "json", CLOCK), "build-task-20260102T030405Z.json");
  assert.equal(sessionExportName({ slug: "slug-only" }, "json", CLOCK), "slug-only-20260102T030405Z.json");
  assert.equal(sessionExportName(null, "json", CLOCK), "session-20260102T030405Z.json");
  // The record's id is not a candidate at all.
  assert.equal(
    sessionExportName({ title: undefined, slug: undefined }, "json", CLOCK),
    "session-20260102T030405Z.json",
  );
});

/* ------------------------------------------------------------ allowlist */

test("the download allowlist accepts exactly the route's name shape", () => {
  assert.equal(safeDownloadName("session-20260102T030405Z.json"), "session-20260102T030405Z.json");
  assert.equal(safeDownloadName("a_b-c.d.json"), "a_b-c.d.json");
  assert.equal(safeDownloadName("a".repeat(120)), "a".repeat(120));
  for (const bad of [
    "a".repeat(121),
    "name with space",
    "trailing.",
    "..hidden",
    "name..json",
    "quote\".json",
    "slash/name.json",
    "back\\slash.json",
    "<script>.json",
    "",
    undefined,
    42,
  ]) {
    assert.equal(safeDownloadName(bad), DEFAULT_DOWNLOAD_NAME, String(bad));
    assert.equal(isSafeDownloadName(bad), false, String(bad));
  }
  assert.equal(safeDownloadName("bad name", "fallback.bin"), "fallback.bin");
  assert.equal(isSafeDownloadName("ok.json"), true);
  assert.equal(DEFAULT_DOWNLOAD_NAME, "download");
});

/* --------------------------------------------------------------- request */

test("the export request path carries format, events, prompt and reveal", () => {
  assert.equal(
    exportRequestPath("ses_1", { format: "json" }),
    "/api/sessions/ses_1/export?format=json",
  );
  assert.equal(
    exportRequestPath("ses_1", { format: "markdown", includeEvents: true }),
    "/api/sessions/ses_1/export?format=markdown&includeEvents=1",
  );
  assert.equal(
    exportRequestPath("ses_1", { format: "digest", prompt: true }),
    "/api/sessions/ses_1/export?format=digest&prompt=1",
  );
  assert.equal(
    exportRequestPath("ses_1", { format: "html", reveal: true }),
    "/api/sessions/ses_1/export?format=html&reveal=1",
  );
  assert.equal(
    exportRequestPath("ses_1", { format: "digest", prompt: true, reveal: true }),
    "/api/sessions/ses_1/export?format=digest&prompt=1&reveal=1",
  );
  // The id is encoded once, in the path.
  assert.equal(
    exportRequestPath("ses 1/2", { format: "json" }),
    "/api/sessions/ses%201%2F2/export?format=json",
  );
});

/* ---------------------------------------------------------------- target */

function record(id: string, title?: string) {
  return { id, title, slug: id };
}

test("the export target is the server's record, never the route id", async () => {
  const notifications: string[] = [];
  const found = await resolveExportTarget("ses_1", {
    sessions: [record("ses_1", "One")],
    refresh: async () => [],
    notify: (message: string) => notifications.push(message),
  });
  assert.deepEqual(found, { id: "ses_1", record: record("ses_1", "One") });
  assert.deepEqual([...notifications], []);

  // Absent from the loaded list: one refresh of the constant path may find it.
  let refreshes = 0;
  const refreshed = await resolveExportTarget("ses_old", {
    sessions: [],
    refresh: async () => {
      refreshes += 1;
      return [record("ses_old", "Old")];
    },
    notify: (message: string) => notifications.push(message),
  });
  assert.equal(refreshes, 1);
  assert.equal(refreshed?.id, "ses_old");

  // Absent after the refresh: the operation aborts with the documented sentence.
  const missing = await resolveExportTarget("ses_gone", {
    sessions: [],
    refresh: async () => [],
    notify: (message: string) => notifications.push(message),
  });
  assert.equal(missing, null);
  assert.deepEqual([...notifications], [EXPORT_SESSION_MISSING]);

  // No source id: nothing to look up, so no request and no notification.
  const none = await resolveExportTarget(null, {
    sessions: [record("ses_1")],
    refresh: async () => {
      throw new Error("must not refresh");
    },
    notify: (message: string) => notifications.push(message),
  });
  assert.equal(none, null);
  assert.equal(notifications.length, 1);
});

/* ----------------------------------------------------------- toast copy */

test("the toast vocabulary is the legacy copy verbatim", () => {
  assert.equal(TOAST_MS, 2_400);
  assert.deepEqual(
    { ...TOAST },
    {
      copied: "Copied",
      copyFailed: "Copy failed",
      metricsCopied: "Metrics copied",
      turnChainCopied: "Turn chain copied",
      noTurnAttribution: "This event has no turn attribution.",
      clipboardBlocked: "Copy failed — the browser blocked the clipboard",
      exportedRedacted: "Exported (credentials redacted)",
      exportedUnredacted: "Exported with raw secrets",
      revealDisabled: "Reveal is disabled by the server (start it with --reveal).",
      exportSessionMissing: EXPORT_SESSION_MISSING,
    },
  );
  // Short strings, sentence case, no trailing period except the full sentences.
  for (const value of [
    TOAST.copied,
    TOAST.copyFailed,
    TOAST.metricsCopied,
    TOAST.turnChainCopied,
    TOAST.exportedRedacted,
    TOAST.exportedUnredacted,
  ]) {
    assert.doesNotMatch(value, /\.$/, value);
    assert.equal(value.charAt(0), value.charAt(0).toUpperCase(), value);
  }
});

test("the digest confirmation covers all four prompt and reveal combinations", () => {
  const values = new Set([
    digestToastMessage(false, false),
    digestToastMessage(true, false),
    digestToastMessage(false, true),
    digestToastMessage(true, true),
  ]);
  assert.equal(values.size, 4);
  assert.equal(digestToastMessage(false, false), "Session digest copied (credentials redacted)");
  assert.equal(digestToastMessage(true, false), "Review prompt copied (credentials redacted)");
  assert.equal(
    digestToastMessage(false, true),
    "Session digest copied (unredacted — contains secrets)",
  );
  assert.equal(
    digestToastMessage(true, true),
    "Review prompt copied (unredacted — contains secrets)",
  );
  assert.equal(exportToastMessage(false), "Exported (credentials redacted)");
  assert.equal(exportToastMessage(true), "Exported with raw secrets");
});

test("the reveal copy warning and the reveal confirmation keep their wording", () => {
  assert.deepEqual(
    { ...REVEAL_COPY_WARNING },
    {
      title: "Copy unredacted review material?",
      message:
        "Reveal is active, so API keys, tokens and credentials may appear in the copied text and on your clipboard. Treat the clipboard as sensitive and turn reveal off when you are finished.",
      acceptLabel: "Copy unredacted",
    },
  );
  assert.deepEqual(
    { ...REVEAL_CONFIRM },
    {
      title: "Reveal raw payloads?",
      message:
        "API keys, tokens and credentials may appear on screen and in exports. Turn reveal off when you are finished.",
      acceptLabel: "Reveal secrets",
    },
  );
  assert.equal(REVEAL_BANNER, "Secrets are visible. Do not share this screen or its exports.");
});

/* ----------------------------------------------------------- copy values */

function detailEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "evt_1",
    messageID: "msg_1",
    sessionID: "ses_1",
    seq: 1,
    order: 0,
    orderKey: "1:0",
    timestamp: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
    endTimestamp: Date.UTC(2026, 0, 2, 3, 4, 6, 678),
    kind: "tool",
    actor: "assistant",
    title: "grep",
    text: null,
    textPreview: null,
    agent: "build",
    model: null,
    provider: null,
    status: "error",
    tool: null,
    tokens: { input: 10, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 2 },
    cost: 0.02,
    stepID: "step_1",
    turnID: "turn_1",
    flags: {
      error: true,
      retry: false,
      compaction: false,
      context: false,
      subagent: false,
      approval: false,
      uncertain: false,
    },
    uncertainty: [],
    payload: null,
    ...overrides,
  };
}

test("the drawer's metrics line is tab-separated with the derived prompt", () => {
  assert.equal(
    metricsLine(detailEvent()),
    [
      "event=evt_1",
      "turn=turn_1",
      "step=step_1",
      "kind=tool",
      "status=error",
      "prompt=15",
      "input=10",
      "output=20",
      "reasoning=5",
      "cache_read=3",
      "cache_write=2",
      "cost=0.02",
      "duration_ms=1000",
    ].join("\t"),
  );
  // Unrecorded values are empty fields, never zeros.
  const sparse = detailEvent({
    tokens: null,
    cost: null,
    endTimestamp: null,
    turnID: null,
    stepID: null,
    status: null,
  });
  const line = metricsLine(sparse);
  assert.match(line, /\tprompt=\t/);
  assert.match(line, /\tduration_ms=$/);
  assert.equal(metricsLine(null), "");
});

function indexEntry(overrides: Partial<EventIndexEntry> = {}): EventIndexEntry {
  return {
    id: "evt_1",
    messageID: "msg_1",
    sessionID: "ses_1",
    seq: 1,
    orderKey: "1:0",
    timestamp: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
    kind: "tool",
    actor: "assistant",
    title: "grep",
    preview: "pattern foo",
    agent: null,
    model: null,
    provider: null,
    status: "error",
    toolName: "grep",
    toolStatus: "error",
    tokens: null,
    cost: null,
    stepID: null,
    turnID: "turn_1",
    flags: {
      error: true,
      retry: false,
      compaction: false,
      context: false,
      subagent: false,
      approval: false,
      uncertain: false,
    },
    uncertainty: [],
    ...overrides,
  };
}

test("the turn chain copies only the event's own turn, in recorded order", () => {
  const events = [
    indexEntry({ id: "evt_1" }),
    indexEntry({ id: "evt_2", turnID: "turn_2", title: "other" }),
    indexEntry({
      id: "evt_3",
      kind: "text",
      title: "assistant text",
      toolName: null,
      status: null,
      preview: "",
    }),
  ];
  const text = turnChainText({ turnID: "turn_1" }, events);
  assert.ok(text !== null);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "03:04:05.678\ttool\tgrep\terror\tgrep\tpattern foo");
  assert.equal(lines[1], "03:04:05.678\ttext\tassistant text\t\t\t");
  assert.equal(turnChainText({ turnID: null }, events), null);
  assert.equal(turnChainText(null, events), null);
  // An empty turn copies an empty string, which the drawer reports like legacy.
  assert.equal(turnChainText({ turnID: "turn_9" }, events), "");
});

/* --------------------------------------------------------------- toaster */

interface FakeTimer {
  id: number;
  callback: () => void;
  ms: number;
}

function fakeTimers() {
  let next = 0;
  const pending = new Map<number, FakeTimer>();
  return {
    timers: {
      set(callback: () => void, ms: number): unknown {
        const id = ++next;
        pending.set(id, { id, callback, ms });
        return id;
      },
      clear(handle: unknown): void {
        pending.delete(handle as number);
      },
    },
    pending,
    fire(): void {
      for (const [id, timer] of [...pending.entries()]) {
        pending.delete(id);
        timer.callback();
      }
    },
  };
}

test("the toast is single-instance, replaces the previous message and auto-dismisses", () => {
  const clock = fakeTimers();
  const controller = new ToastController(clock.timers);
  const seen: (string | null)[] = [];
  const unsubscribe = controller.subscribe(() => seen.push(controller.getSnapshot()));

  controller.show(TOAST.copied);
  assert.equal(controller.getSnapshot(), "Copied");
  assert.equal(clock.pending.size, 1);
  assert.equal([...clock.pending.values()][0]?.ms, TOAST_MS);

  controller.show(TOAST.metricsCopied);
  assert.equal(controller.getSnapshot(), "Metrics copied");
  // The newer message re-arms the timer instead of stacking a second toast.
  assert.equal(clock.pending.size, 1);

  clock.fire();
  assert.equal(controller.getSnapshot(), null);

  controller.show(TOAST.copyFailed);
  controller.dismiss();
  assert.equal(controller.getSnapshot(), null);
  assert.equal(clock.pending.size, 0);

  controller.show(TOAST.copied);
  controller.dispose();
  assert.equal(clock.pending.size, 0);
  // `dispose` stops the timer without clearing what is on screen.
  assert.equal(controller.getSnapshot(), "Copied");

  // An empty message never replaces the visible one.
  controller.show("");
  assert.equal(controller.getSnapshot(), "Copied");

  unsubscribe();
  assert.deepEqual(seen, [
    "Copied",
    "Metrics copied",
    null,
    "Copy failed",
    null,
    "Copied",
  ]);
});
