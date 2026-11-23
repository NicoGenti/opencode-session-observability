import test from "node:test";
import assert from "node:assert/strict";
import type { CompactionTransaction, Metric } from "../src/core/types.ts";
import {
  COMPACTION_NOTE,
  NO_COMPACTIONS_TEXT,
  buildCompactionCards,
  compactionStats,
} from "../src/web/lib/compactions.ts";

function metric(value: number | null, basis: Metric["basis"] = "measured"): Metric {
  return { value, basis };
}

function compaction(overrides: Partial<CompactionTransaction> = {}): CompactionTransaction {
  return {
    eventID: "evt-compaction-1",
    turnID: "turn-1",
    timestamp: 1_700_000_020_000,
    status: "completed",
    reason: "context",
    model: null,
    provider: null,
    tokens: { input: 0, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0.01,
    summaryChars: 1_200,
    summaryPreview: "Summary of the work so far",
    contextBefore: metric(90_000, "derived"),
    contextAfter: metric(12_000, "derived"),
    contextDelta: metric(-78_000, "derived"),
    removedTokens: metric(78_000, "derived"),
    duration: metric(null, "unavailable"),
    uncertainty: [],
    ...overrides,
  };
}

test("compactions: one numbered card per transaction with its status and reason", () => {
  const model = buildCompactionCards([compaction(), compaction({ eventID: "evt-compaction-2", reason: null })]);
  assert.equal(model.cards.length, 2);
  assert.equal(model.cards[0]?.title, "Compaction 1");
  assert.equal(model.cards[1]?.title, "Compaction 2");
  assert.equal(model.cards[0]?.status.label, "completed");
  assert.equal(model.cards[0]?.status.kind, "compaction");
  assert.equal(model.cards[1]?.reason, "unknown");
  assert.equal(model.cards[0]?.eventID, "evt-compaction-1");
});

test("compactions: a failed transaction keeps the error badge treatment", () => {
  const model = buildCompactionCards([compaction({ status: "failed" })]);
  assert.equal(model.cards[0]?.status.kind, "error");
});

test("compactions: the seven legacy facts keep their labels and provenance", () => {
  const stats = compactionStats(compaction());
  assert.deepEqual(
    stats.map((entry) => entry.label),
    ["Context before", "Context after", "Removed", "Summary", "Output tokens", "Cost", "Duration"],
  );
  assert.equal(stats[0]?.value.text, "90,000");
  assert.equal(stats[0]?.value.mark, "D");
  assert.equal(stats[2]?.value.text, "78,000");
  assert.equal(stats[3]?.value.text, "1,200 chars");
  assert.equal(stats[4]?.value.text, "500");
  assert.equal(stats[5]?.value.text, "$0.0100");
  assert.equal(stats[6]?.value.text, "—");
  assert.equal(stats[6]?.value.mark, "—");
});

test("compactions: a missing value is never printed as zero", () => {
  const stats = compactionStats(
    compaction({ cost: null, tokens: null, summaryChars: 0 }),
  );
  assert.equal(stats[4]?.value.text, "—");
  assert.equal(stats[5]?.value.text, "—");
  assert.equal(stats[3]?.value.text, "0 chars");
});

test("compactions: an empty session states the fact instead of rendering a card", () => {
  const model = buildCompactionCards([]);
  assert.deepEqual(model.cards, []);
  assert.equal(model.emptyNote, NO_COMPACTIONS_TEXT);
  assert.equal(NO_COMPACTIONS_TEXT, "No compactions recorded in this session.");
});

test("compactions: every card repeats the separate-transaction accounting note", () => {
  const model = buildCompactionCards([compaction()]);
  assert.equal(model.cards[0]?.note, COMPACTION_NOTE);
  assert.match(COMPACTION_NOTE, /excluded from turn\/step totals/);
});

test("compactions: the preview is kept as recorded and omitted when absent", () => {
  const withPreview = buildCompactionCards([compaction()]);
  assert.equal(withPreview.cards[0]?.summaryPreview, "Summary of the work so far");
  const without = buildCompactionCards([compaction({ summaryPreview: "" })]);
  assert.equal(without.cards[0]?.summaryPreview, null);
});
