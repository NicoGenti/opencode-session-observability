import test from "node:test";
import assert from "node:assert/strict";
import type { NormalizedEvent, Step, TokenUsage, Turn } from "../src/core/types.ts";
import {
  LINE_HEIGHTS,
  PREVIEW_CHARS_PER_LINE,
  PREVIEW_LINE_HEIGHT,
  PREVIEW_MAX_LINES,
  TURN_HEADER_HEIGHT,
  STEP_HEADER_HEIGHT,
  buildLedgerRows,
  clampCursor,
  eventBadges,
  eventMetrics,
  eventRowHeight,
  eventSubLine,
  kindBadge,
  moveCursor,
  previewLineCount,
  rowHeight,
  rowKey,
  type LedgerRow,
} from "../src/web/lib/ledger.ts";

const UNAVAILABLE = { value: null, basis: "unavailable" } as const;

const TOKENS: TokenUsage = {
  input: 100,
  output: 50,
  reasoning: 0,
  cacheRead: 20,
  cacheWrite: 0,
};

interface EventOptions {
  id?: string;
  seq?: number;
  kind?: NormalizedEvent["kind"];
  title?: string;
  agent?: string | null;
  model?: NormalizedEvent["model"];
  provider?: string | null;
  status?: string | null;
  tool?: NormalizedEvent["tool"];
  tokens?: TokenUsage | null;
  cost?: number | null;
  stepID?: string | null;
  turnID?: string | null;
  textPreview?: string | null;
  description?: string;
  approximate?: boolean;
  flags?: Partial<NormalizedEvent["flags"]>;
  uncertainty?: string[];
}

function event(options: EventOptions = {}): NormalizedEvent {
  const seq = options.seq ?? 1;
  return {
    id: options.id ?? `evt-${seq}`,
    messageID: `msg-${seq}`,
    sessionID: "sess-1",
    seq,
    order: 0,
    orderKey: `${String(seq).padStart(6, "0")}:0`,
    timestamp: 1_700_000_000_000 + seq,
    endTimestamp: null,
    kind: options.kind ?? "assistant",
    actor: "assistant",
    title: options.title ?? `Event ${seq}`,
    text: null,
    textPreview: options.textPreview ?? null,
    agent: options.agent ?? null,
    model: options.model ?? null,
    provider: options.provider ?? null,
    status: options.status ?? null,
    tool: options.tool ?? null,
    tokens: options.tokens === undefined ? null : options.tokens,
    cost: options.cost ?? null,
    stepID: options.stepID ?? null,
    turnID: options.turnID ?? null,
    flags: {
      error: false,
      retry: false,
      compaction: false,
      context: false,
      subagent: false,
      approval: false,
      uncertain: false,
      ...options.flags,
    },
    uncertainty: options.uncertainty ?? [],
    payload: null,
    meta: options.approximate ? { timestampApproximate: true } : undefined,
    ...(options.description !== undefined
      ? { meta: { timestampApproximate: options.approximate === true, description: options.description } }
      : {}),
  };
}

function toolCall(overrides: Partial<NonNullable<NormalizedEvent["tool"]>> = {}) {
  return {
    callID: "call-1",
    name: "bash",
    status: "completed" as const,
    input: { command: "ls" },
    inputPreview: "ls",
    output: "ok",
    outputPreview: "ok",
    error: null,
    metadata: null,
    createdAt: 1,
    ranAt: 2,
    completedAt: 3,
    duration: { value: 1_000, basis: "derived" as const },
    childSessionIDs: [],
    executed: true,
    ...overrides,
  };
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: "step-1",
    turnID: "turn-1",
    index: 1,
    trigger: "User message",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    startUnknown: false,
    agent: null,
    model: { providerID: "openai", id: "gpt-5" },
    provider: "openai",
    finish: "stop",
    toolNames: [],
    toolCalls: [],
    tokens: TOKENS,
    cost: 0.01,
    promptTokens: { value: 120, basis: "measured" },
    cacheHitRate: { value: 0.2, basis: "derived" },
    ttft: UNAVAILABLE,
    modelTime: { value: 900, basis: "derived" },
    toolTime: { value: 100, basis: "measured" },
    totalTime: { value: 1_000, basis: "measured" },
    residualTime: { value: 0, basis: "derived" },
    outputSpeed: { value: 50, basis: "derived" },
    status: "completed",
    subagentSessionIDs: [],
    eventIDs: ["evt-2"],
    responseText: "",
    reasoningText: "",
    uncertainty: [],
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    index: 1,
    trigger: { kind: "user", eventID: "evt-1", label: "User message" },
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    status: "completed",
    steps: [step()],
    eventIDs: ["evt-2"],
    nonStepEventIDs: [],
    firstStepStart: 1_700_000_000_000,
    lastStepEnd: 1_700_000_001_000,
    tokens: TOKENS,
    tokensComplete: true,
    promptTokensLatest: { value: 120, basis: "measured" },
    promptTokensCumulative: { value: 120, basis: "derived" },
    cacheHitRate: { value: 0.2, basis: "derived" },
    contextDelta: UNAVAILABLE,
    cost: { value: 0.01, basis: "derived" },
    modelTime: { value: 900, basis: "derived" },
    toolTime: { value: 100, basis: "measured" },
    totalTime: { value: 1_000, basis: "measured" },
    residualTime: { value: 0, basis: "derived" },
    outputSpeed: { value: 50, basis: "derived" },
    uncertainty: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------- height model */

test("ledger: the legacy height table is ported verbatim", () => {
  assert.deepEqual([...LINE_HEIGHTS], [20, 18, 18, 17]);
  // Title only: 16 + 20 + 2.
  assert.equal(eventRowHeight(event()), 38);
  // + sub-line: 16 + 20 + (3 + 18) + 2.
  assert.equal(eventRowHeight(event({ agent: "build" })), 59);
  // + preview: one more 3 + 18.
  assert.equal(eventRowHeight(event({ agent: "build", textPreview: "hello" })), 80);
  // + metrics: one more 3 + 17.
  const full = event({
    agent: "build",
    textPreview: "hello",
    tokens: TOKENS,
    tool: toolCall(),
    cost: 0.02,
  });
  assert.equal(eventRowHeight(full), 100);
});

test("ledger: preview line counts never exceed four and drive the estimate", () => {
  assert.equal(PREVIEW_MAX_LINES, 4);
  assert.equal(previewLineCount(""), 0);
  assert.equal(previewLineCount("short"), 1);
  assert.equal(previewLineCount("x".repeat(PREVIEW_CHARS_PER_LINE + 1)), 2);
  assert.equal(previewLineCount("x".repeat(PREVIEW_CHARS_PER_LINE * 3)), 3);
  assert.equal(previewLineCount("x".repeat(PREVIEW_CHARS_PER_LINE * 40)), 4);
  // Explicit newlines count as line breaks.
  assert.equal(previewLineCount("a\nb\nc"), 3);
  assert.equal(previewLineCount("a\n\nb"), 3);
});

test("ledger: rowHeight reserves one line height per preview line beyond the first", () => {
  const one = event({ agent: "build", textPreview: "x".repeat(10) });
  const two = event({ agent: "build", textPreview: "x".repeat(PREVIEW_CHARS_PER_LINE + 1) });
  const four = event({ agent: "build", textPreview: "x".repeat(PREVIEW_CHARS_PER_LINE * 4) });
  assert.equal(rowHeight({ type: "event", key: "e", event: one, eventID: one.id }), eventRowHeight(one));
  assert.equal(
    rowHeight({ type: "event", key: "e", event: two, eventID: two.id }),
    eventRowHeight(two) + PREVIEW_LINE_HEIGHT,
  );
  // 4 preview lines: 38 + 20 + 18 + 3*(1+4-1) ... expressed as legacy + 3 lines.
  assert.equal(
    rowHeight({ type: "event", key: "e", event: four, eventID: four.id }),
    eventRowHeight(four) + 3 * PREVIEW_LINE_HEIGHT,
  );
  assert.equal(rowHeight({ type: "turn", key: "t", turn: null }), TURN_HEADER_HEIGHT);
  assert.equal(
    rowHeight({ type: "step", key: "s", turn: null, step: undefined, stepID: "s" }),
    STEP_HEADER_HEIGHT,
  );
});

test("ledger: the description wins over the derived preview", () => {
  const withDescription = event({
    textPreview: "derived preview",
    description: "recorded description",
  });
  const withoutDescription = event({ textPreview: "derived preview" });
  assert.equal(previewLineCount("x".repeat(PREVIEW_CHARS_PER_LINE * 2)), 2);
  // Same line budget for both, the rendered text is the description.
  assert.equal(
    rowHeight({ type: "event", key: "a", event: withDescription, eventID: "a" }),
    rowHeight({ type: "event", key: "b", event: withoutDescription, eventID: "b" }),
  );
});

/* ---------------------------------------------------------------- row model */

test("ledger: turn and step headers are inserted on sequence changes", () => {
  const turns = [turn()];
  const events = [
    event({ id: "evt-user", seq: 1, kind: "user", turnID: "turn-1", stepID: null }),
    event({ id: "evt-assistant", seq: 2, turnID: "turn-1", stepID: "step-1" }),
    event({ id: "evt-tool", seq: 3, kind: "tool", turnID: "turn-1", stepID: "step-1" }),
  ];
  const rows = buildLedgerRows(events, turns);
  assert.deepEqual(
    rows.map((row) => row.type),
    ["turn", "event", "step", "event", "event"],
  );
  assert.deepEqual(
    rows.map(rowKey),
    ["turn:turn-1", "event:evt-user", "step:turn-1:step-1", "event:evt-assistant", "event:evt-tool"],
  );
});

test("ledger: a leading unattached run gets no header; a later one does", () => {
  const turns = [turn()];
  const leading = buildLedgerRows(
    [event({ id: "a", seq: 1, turnID: null })],
    turns,
  );
  assert.deepEqual(leading.map((row) => row.type), ["event"]);

  const later = buildLedgerRows(
    [
      event({ id: "a", seq: 1, turnID: "turn-1", stepID: "step-1" }),
      event({ id: "b", seq: 2, turnID: null }),
      event({ id: "c", seq: 3, turnID: null }),
      event({ id: "d", seq: 4, turnID: "turn-1", stepID: "step-1" }),
    ],
    turns,
  );
  assert.deepEqual(
    later.map((row) => row.type),
    ["turn", "step", "event", "turn", "event", "event", "turn", "step", "event"],
  );
  const unattached = later[3];
  assert.equal(unattached.type, "turn");
  if (unattached.type === "turn") assert.equal(unattached.turn, null);
});

test("ledger: a step header without a matching step still identifies its index", () => {
  const rows = buildLedgerRows(
    [event({ id: "a", seq: 1, turnID: "turn-1", stepID: "missing" })],
    [turn()],
  );
  const header = rows.find((row) => row.type === "step") as Extract<LedgerRow, { type: "step" }>;
  assert.equal(header.step, undefined);
  // The header still identifies its step id and keeps the unknown marker.
  assert.equal(header.stepID, "missing");
  assert.equal(header.turn?.id, "turn-1");
});

/* ---------------------------------------------------------------- accessible */

/*
 * The event button has no `aria-label`: its visible text is the accessible
 * name. `LedgerRow.tsx` is pinned for that in the review-fix suite; the pure row
 * model no longer exposes a separate label that could drift from the screen.
 */

test("ledger: sub-line and metrics mirror the legacy strings", () => {
  const full = event({
    agent: "build",
    model: { providerID: "openai", id: "gpt-5", variant: "mini" },
    tool: toolCall({ name: "read", status: "running" }),
    stepID: "step-9",
  });
  assert.equal(
    eventSubLine(full),
    "agent build · openai/gpt-5#mini · tool read (running) · step step-9",
  );
  assert.deepEqual(eventMetrics(full), ["1.00 s"]);
  const withTokens = event({ tokens: TOKENS, cost: 0.5 });
  assert.deepEqual(eventMetrics(withTokens), [
    "prompt 120",
    "out 50",
    "cache 16.7%",
    "$0.5000",
  ]);
});

test("ledger: badges follow the flag rules without duplicating the event kind", () => {
  assert.deepEqual(eventBadges(event({ kind: "error", flags: { error: true } })), []);
  assert.deepEqual(eventBadges(event({ kind: "retry", flags: { retry: true } })), []);
  assert.deepEqual(eventBadges(event({ kind: "compaction", flags: { compaction: true } })), []);
  const badges = eventBadges(
    event({
      flags: { error: true, retry: true, compaction: true, context: true, subagent: true },
      uncertainty: ["missing start"],
    }),
  );
  assert.deepEqual(
    badges.map((badge) => badge.label),
    ["error", "retry", "compaction", "context", "subagent", "uncertain"],
  );
  assert.equal(badges[5].title, "missing start");
  assert.deepEqual(kindBadge(event({ kind: "error" })), { label: "error", kind: "error" });
  assert.deepEqual(kindBadge(event({ kind: "tool" })), { label: "tool", kind: "tool" });
  assert.deepEqual(kindBadge(event({ kind: "text" })), { label: "text", kind: "neutral" });
});

/* -------------------------------------------------------------------- cursor */

test("ledger: the cursor clamps at both ends and lands on zero from nothing", () => {
  assert.equal(clampCursor(-3, 10), 0);
  assert.equal(clampCursor(99, 10), 9);
  assert.equal(clampCursor(0, 0), -1);
  assert.equal(moveCursor(-1, 3, 1), 0);
  assert.equal(moveCursor(-1, 3, -1), 0);
  assert.equal(moveCursor(1, 3, 1), 2);
  assert.equal(moveCursor(1, 3, -1), 0);
  assert.equal(moveCursor(2, 3, 1), 2);
  assert.equal(moveCursor(0, 3, -1), 0);
  assert.equal(moveCursor(0, 0, 1), -1);
});
