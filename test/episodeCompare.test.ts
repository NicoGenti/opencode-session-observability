import test from "node:test";
import assert from "node:assert/strict";
import { compareEpisodeData } from "../src/core/episodeCompare.ts";
import type {
  AttemptSummary,
  EpisodeCompareInput,
  EpisodeComparison,
  EpisodeTotals,
  TurnSummary,
} from "../src/core/episodeCompare.ts";
import { metric } from "../src/core/types.ts";
import type { DiagnosticEpisode } from "../src/core/episodes.ts";
import type { InputComparability } from "../src/core/diagnostics.ts";
import type { Metric, TokenUsage } from "../src/core/types.ts";

function m(
  value: number | null,
  basis: "derived" | "estimated" = "derived",
): Metric {
  return metric(value, basis);
}

function tokens(
  input: number,
  output = 10,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
): TokenUsage {
  return { input, output, reasoning, cacheRead, cacheWrite };
}

function totals(overrides: Partial<EpisodeTotals> = {}): EpisodeTotals {
  return {
    tokens: tokens(1_000),
    tokensComplete: true,
    cost: m(0.01),
    modelTime: m(1_000),
    toolTime: m(300),
    totalTime: m(1_400),
    outputSpeed: m(100),
    cacheHitRate: m(0.16),
    ...overrides,
  };
}

function turn(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    ...totals(),
    index: 1,
    promptTokensLatest: m(450),
    ...overrides,
  };
}

function episode(overrides: Partial<DiagnosticEpisode> = {}): DiagnosticEpisode {
  return {
    id: "ses:ses:t1:read:a1:0",
    sessionID: "ses",
    turnID: "ses:t1",
    turnIndex: 1,
    tool: "read",
    attemptCount: 2,
    recovery: "no-recovery-evidence",
    similarity: "unknown",
    failureEventIDs: ["a1:0", "a1:1"],
    recoveryEventID: null,
    ...overrides,
  };
}

function attempt(
  eventID: string,
  input: unknown,
  durationMs: number | null,
  overrides: Partial<AttemptSummary> = {},
): AttemptSummary {
  return {
    eventID,
    tool: "read",
    status: "error",
    input,
    duration: m(durationMs),
    ...overrides,
  };
}

function side(overrides: Partial<EpisodeCompareInput> = {}): EpisodeCompareInput {
  return {
    episode: episode(),
    attempts: [
      attempt("a1:0", { path: "src/a.ts" }, 100),
      attempt("a1:1", { path: "src/a.ts" }, 200),
    ],
    recovery: null,
    totals: totals(),
    turn: turn(),
    redacted: false,
    ...overrides,
  };
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

test("aligns equal attempt counts ordinally with left − right latency", () => {
  const left = side({
    attempts: [
      attempt("a1:0", { path: "src/a.ts", limit: 10 }, 120),
      attempt("a1:1", { path: "src/a.ts" }, 220),
    ],
  });
  const right = side({
    attempts: [
      attempt("b1:0", { path: "src/a.ts", limit: 10 }, 100),
      attempt("b1:1", { path: "src/a.ts" }, 180),
    ],
  });

  const result = compareEpisodeData(left, right);

  assert.deepEqual(
    result.alignment.map((row) => row.presence),
    ["both", "both"],
  );
  assert.deepEqual(
    result.alignment.map((row) => row.index),
    [1, 2],
  );
  assert.deepEqual(
    result.alignment.map((row) => row.kind),
    ["attempt", "attempt"],
  );

  const [first, second] = result.alignment;
  assert.equal(first!.latencyDelta.value, 20);
  assert.equal(first!.latencyDelta.basis, "derived");
  assert.equal(first!.latencyDelta.note, "left − right");
  assert.deepEqual(first!.inputComparability, {
    left: "comparable",
    right: "comparable",
  });
  assert.equal(first!.inputSimilarity, "identical");
  assert.equal(first!.inputOverlap, 1);
  assert.equal(second!.inputSimilarity, "identical");
  assert.equal(second!.latencyDelta.value, 40);

  // Counts, tools, recovery and inputs all agree, so no note is warranted.
  assert.deepEqual(result.notes, []);
});

test("keeps a missing attempt visible as a trailing one-sided row", () => {
  const left = side({
    episode: episode({ attemptCount: 3 }),
    attempts: [
      attempt("a1:0", { path: "src/a.ts" }, 100),
      attempt("a1:1", { path: "src/a.ts" }, 110),
      attempt("a1:2", { path: "src/a.ts" }, 120),
    ],
  });
  const right = side({
    episode: episode({ attemptCount: 1, failureEventIDs: ["b1:0"] }),
    attempts: [attempt("b1:0", { path: "src/a.ts" }, 90)],
  });

  const result = compareEpisodeData(left, right);

  assert.deepEqual(
    result.alignment.map((row) => row.presence),
    ["both", "left-only", "left-only"],
  );
  const missing = result.alignment[1]!;
  assert.equal(missing.right, null);
  assert.equal(missing.left!.eventID, "a1:1");
  assert.equal(missing.latencyDelta.value, null);
  assert.equal(missing.latencyDelta.basis, "unavailable");
  assert.deepEqual(missing.inputComparability, {
    left: "comparable",
    right: "absent",
  });
  assert.equal(missing.inputSimilarity, "not-comparable");
  assert.equal(missing.inputOverlap, null);
  assert.deepEqual(result.notes, ["2 attempt(s) only in left"]);
});

test("names the side of a count mismatch without reordering attempts", () => {
  const left = side({
    episode: episode({ attemptCount: 1, failureEventIDs: ["a1:0"] }),
    attempts: [attempt("a1:0", { path: "src/a.ts" }, 100)],
  });
  const right = side({
    episode: episode({ attemptCount: 3 }),
    attempts: [
      attempt("b1:0", { path: "src/a.ts" }, 90),
      attempt("b1:1", { path: "src/a.ts" }, 95),
      attempt("b1:2", { path: "src/a.ts" }, 99),
    ],
  });

  const result = compareEpisodeData(left, right);

  assert.deepEqual(
    result.alignment.map((row) => [row.index, row.presence]),
    [
      [1, "both"],
      [2, "right-only"],
      [3, "right-only"],
    ],
  );
  assert.deepEqual(result.notes, ["2 attempt(s) only in right"]);
});

test("appends one aligned recovery row when both sides recovered", () => {
  const left = side({
    episode: episode({
      recovery: "recovered",
      similarity: "identical",
      recoveryEventID: "a1:2",
    }),
    recovery: attempt("a1:2", { path: "src/a.ts" }, 60, { status: "completed" }),
  });
  const right = side({
    episode: episode({
      recovery: "recovered",
      similarity: "identical",
      recoveryEventID: "b1:2",
    }),
    recovery: attempt("b1:2", { path: "src/a.ts" }, 50, { status: "completed" }),
  });

  const result = compareEpisodeData(left, right);
  const recovery = result.alignment.at(-1)!;

  assert.equal(result.alignment.length, 3);
  assert.equal(recovery.index, 3);
  assert.equal(recovery.kind, "recovery");
  assert.equal(recovery.presence, "both");
  assert.equal(recovery.left!.eventID, "a1:2");
  assert.equal(recovery.right!.eventID, "b1:2");
  assert.equal(recovery.latencyDelta.value, 10);
  assert.equal(recovery.inputSimilarity, "identical");
  assert.deepEqual(result.notes, []);
});

test("adds no recovery row when neither side recovered", () => {
  const result = compareEpisodeData(side(), side());

  assert.equal(result.alignment.length, 2);
  assert.ok(result.alignment.every((row) => row.kind === "attempt"));
});

test("adds a one-sided recovery row and says which side has it", () => {
  const left = side({
    episode: episode({
      recovery: "recovered",
      similarity: "identical",
      recoveryEventID: "a1:2",
    }),
    recovery: attempt("a1:2", { path: "src/a.ts" }, 60, { status: "completed" }),
  });

  const result = compareEpisodeData(left, side());
  const recovery = result.alignment.at(-1)!;

  assert.equal(result.alignment.length, 3);
  assert.equal(recovery.kind, "recovery");
  assert.equal(recovery.presence, "left-only");
  assert.equal(recovery.right, null);
  assert.equal(recovery.inputComparability.right, "absent");
  assert.equal(recovery.inputSimilarity, "not-comparable");
  assert.ok(result.notes.includes("recovery call only in left"));
});

test("flags a recorded recovery event whose attempt was not supplied", () => {
  const result = compareEpisodeData(
    side({
      episode: episode({
        recovery: "recovered",
        similarity: "identical",
        recoveryEventID: "a1:2",
      }),
      recovery: null,
    }),
    side(),
  );

  assert.ok(
    result.notes.includes(
      "left episode records a recovery event without a supplied recovery attempt",
    ),
  );
  assert.ok(result.alignment.every((row) => row.kind === "attempt"));
});

test("never guesses a similarity for absent, truncated or redacted inputs", () => {
  const cases: Array<{
    label: string;
    input: unknown;
    state: InputComparability;
  }> = [
    { label: "object sentinel", input: { path: "[REDACTED]" }, state: "redacted" },
    { label: "string sentinel", input: "[REDACTED:secret]", state: "redacted" },
    { label: "end marker", input: { path: "needle…" }, state: "truncated" },
    { label: "null", input: null, state: "absent" },
    { label: "undefined", input: undefined, state: "absent" },
    { label: "empty", input: "", state: "absent" },
  ];

  for (const item of cases) {
    const result = compareEpisodeData(
      side({
        episode: episode({ attemptCount: 1, failureEventIDs: ["a1:0"] }),
        attempts: [attempt("a1:0", item.input, 100)],
      }),
      side({
        episode: episode({ attemptCount: 1, failureEventIDs: ["b1:0"] }),
        attempts: [attempt("b1:0", { path: "src/a.ts" }, 100)],
      }),
    );
    const row = result.alignment[0]!;

    assert.equal(
      row.inputComparability.left,
      item.state,
      `${item.label} should classify as ${item.state}`,
    );
    assert.equal(row.inputComparability.right, "comparable");
    assert.equal(row.inputSimilarity, "not-comparable", item.label);
    assert.equal(row.inputOverlap, null, item.label);
    assert.match(result.notes.join("\n"), /inputs are not comparable/);
  }
});

test("compares input shape only when both inputs are comparable", () => {
  function similarityFor(leftInput: unknown, rightInput: unknown): {
    verdict: string;
    overlap: number | null;
  } {
    const result = compareEpisodeData(
      side({
        episode: episode({ attemptCount: 1, failureEventIDs: ["a1:0"] }),
        attempts: [attempt("a1:0", leftInput, 100)],
      }),
      side({
        episode: episode({ attemptCount: 1, failureEventIDs: ["b1:0"] }),
        attempts: [attempt("b1:0", rightInput, 100)],
      }),
    );
    const row = result.alignment[0]!;
    return { verdict: row.inputSimilarity, overlap: row.inputOverlap };
  }

  assert.deepEqual(similarityFor({ path: "src/a.ts" }, { path: "src/a.ts" }), {
    verdict: "identical",
    overlap: 1,
  });
  assert.deepEqual(
    similarityFor(
      { path: "src/a.ts", limit: 10, offset: 0 },
      { path: "src/a.ts", offset: 5 },
    ),
    { verdict: "related", overlap: 2 / 3 },
  );
  assert.deepEqual(similarityFor({ path: "src/a.ts" }, { command: "ls" }), {
    verdict: "different",
    overlap: 0,
  });
});

test("describes differing tools without ranking either side", () => {
  const result = compareEpisodeData(
    side({
      episode: episode({ tool: "read", attemptCount: 1, failureEventIDs: ["a1:0"] }),
      attempts: [attempt("a1:0", { path: "src/a.ts" }, 100)],
    }),
    side({
      episode: episode({ tool: "grep", attemptCount: 1, failureEventIDs: ["b1:0"] }),
      attempts: [
        attempt("b1:0", { path: "src/a.ts" }, 100, { tool: "grep" }),
      ],
    }),
  );
  const notes = result.notes.join("\n");

  assert.match(
    notes,
    /left episode tool is read and right episode tool is grep/,
  );
  assert.match(notes, /attempt 1 uses read on the left and grep on the right/);
  assert.doesNotMatch(
    notes,
    /better|worse|winner|optimal|recommend/i,
  );
  // Inputs are still compared descriptively on the aligned pair.
  assert.equal(result.alignment[0]!.inputSimilarity, "identical");
});

test("latency delta is unavailable without two durations and signed otherwise", () => {
  const result = compareEpisodeData(
    side({
      attempts: [
        attempt("a1:0", { path: "src/a.ts" }, 50),
        attempt("a1:1", { path: "src/a.ts" }, 100),
      ],
    }),
    side({
      attempts: [
        attempt("b1:0", { path: "src/a.ts" }, 200),
        attempt("b1:1", { path: "src/a.ts" }, null),
      ],
    }),
  );

  assert.equal(result.alignment[0]!.latencyDelta.value, -150);
  assert.equal(result.alignment[0]!.latencyDelta.basis, "derived");
  assert.equal(result.alignment[1]!.latencyDelta.value, null);
  assert.equal(result.alignment[1]!.latencyDelta.basis, "unavailable");
  assert.match(result.alignment[1]!.latencyDelta.note ?? "", /unavailable/);

  const oneSided = compareEpisodeData(
    side({ attempts: [attempt("a1:0", { path: "src/a.ts" }, 100)] }),
    side({
      episode: episode({ attemptCount: 0, failureEventIDs: [] }),
      attempts: [],
    }),
  );
  assert.equal(oneSided.alignment[0]!.latencyDelta.value, null);
  assert.equal(oneSided.alignment[0]!.latencyDelta.basis, "unavailable");
  assert.equal(oneSided.alignment[0]!.latencyDelta.note, "right attempt is missing");
});

test("latency delta is unavailable when a side's duration is estimated", () => {
  const measured = compareEpisodeData(
    side({ attempts: [attempt("a1:0", { path: "src/a.ts" }, 150)] }),
    side({ attempts: [attempt("b1:0", { path: "src/a.ts" }, 100)] }),
  );
  assert.equal(measured.alignment[0]!.latencyDelta.value, 50);
  assert.equal(measured.alignment[0]!.latencyDelta.basis, "derived");
  assert.equal(measured.alignment[0]!.latencyDelta.note, "left − right");

  const leftEstimated = compareEpisodeData(
    side({
      attempts: [
        attempt("a1:0", { path: "src/a.ts" }, 150, {
          duration: m(150, "estimated"),
        }),
      ],
    }),
    side({ attempts: [attempt("b1:0", { path: "src/a.ts" }, 100)] }),
  );
  assert.equal(leftEstimated.alignment[0]!.latencyDelta.value, null);
  assert.equal(leftEstimated.alignment[0]!.latencyDelta.basis, "unavailable");
  assert.match(
    leftEstimated.alignment[0]!.latencyDelta.note ?? "",
    /estimated/,
  );

  const rightEstimated = compareEpisodeData(
    side({ attempts: [attempt("a1:0", { path: "src/a.ts" }, 150)] }),
    side({
      attempts: [
        attempt("b1:0", { path: "src/a.ts" }, 100, {
          duration: m(100, "estimated"),
        }),
      ],
    }),
  );
  assert.equal(rightEstimated.alignment[0]!.latencyDelta.value, null);
  assert.equal(rightEstimated.alignment[0]!.latencyDelta.basis, "unavailable");
  assert.match(
    rightEstimated.alignment[0]!.latencyDelta.note ?? "",
    /estimated/,
  );
});

test("computes per-field token and turn deltas with neutral notes", () => {
  const leftTotals = totals({
    tokens: tokens(1_000, 100, 10, 200, 5),
    cost: m(0.02),
    modelTime: m(900),
    toolTime: m(300),
    totalTime: m(1_300),
    outputSpeed: m(120),
    cacheHitRate: m(0.2),
  });
  const rightTotals = totals({
    tokens: tokens(800, 80, 5, 100, 0),
    cost: m(0.01),
    modelTime: m(700),
    toolTime: m(200),
    totalTime: m(1_000),
    outputSpeed: m(80),
    cacheHitRate: m(0.1),
  });

  const result = compareEpisodeData(
    side({
      totals: leftTotals,
      turn: turn({ ...leftTotals, index: 2, promptTokensLatest: m(500) }),
    }),
    side({
      totals: rightTotals,
      turn: turn({ ...rightTotals, index: 3, promptTokensLatest: m(400) }),
    }),
  );

  assert.equal(result.totals.delta.tokens.input.value, 200);
  assert.equal(result.totals.delta.tokens.output.value, 20);
  assert.equal(result.totals.delta.tokens.reasoning.value, 5);
  assert.equal(result.totals.delta.tokens.cacheRead.value, 100);
  assert.equal(result.totals.delta.tokens.cacheWrite.value, 5);
  assert.equal(result.totals.delta.tokens.input.basis, "derived");
  assert.equal(
    result.totals.delta.tokens.input.note,
    "input tokens left − right",
  );
  assert.equal(result.totals.delta.cost.value, 0.01);
  assert.equal(result.totals.delta.modelTime.value, 200);
  assert.equal(result.totals.delta.toolTime.value, 100);
  assert.equal(result.totals.delta.totalTime.value, 300);
  assert.equal(result.totals.delta.outputSpeed.value, 40);
  assert.equal(result.totals.delta.cacheHitRate.value, 0.1);

  assert.equal(result.turn.delta.tokens.input.value, 200);
  assert.equal(result.turn.delta.promptTokensLatest.value, 100);
  assert.equal(result.turn.left.index, 2);
  assert.equal(result.turn.right.index, 3);
});

test("token and metric deltas become unavailable when a component is uncertain", () => {
  const estimated = compareEpisodeData(
    side({ totals: totals({ cost: m(0.02, "estimated") }) }),
    side(),
  );
  assert.equal(estimated.totals.delta.cost.value, null);
  assert.equal(estimated.totals.delta.cost.basis, "unavailable");
  assert.match(estimated.totals.delta.cost.note ?? "", /estimated/);

  const incomplete = compareEpisodeData(
    side({ totals: totals({ tokensComplete: false }) }),
    side(),
  );
  assert.equal(incomplete.totals.delta.tokens.input.value, null);
  assert.equal(incomplete.totals.delta.tokens.input.basis, "unavailable");
  assert.match(incomplete.totals.delta.tokens.input.note ?? "", /incomplete/);
});

test("carries the redacted flag and says which side is redacted", () => {
  const result = compareEpisodeData(side({ redacted: true }), side());

  assert.equal(result.redacted, true);
  assert.ok(result.notes.includes("left inputs are redacted"));
  assert.equal(compareEpisodeData(side(), side()).redacted, false);
});

test("has no ranking key anywhere in the DTO tree", () => {
  const left = side({
    redacted: true,
    episode: episode({
      tool: "read",
      attemptCount: 3,
      recovery: "recovered",
      similarity: "related",
      recoveryEventID: "a1:3",
    }),
    attempts: [
      attempt("a1:0", { path: "[REDACTED]" }, 100),
      attempt("a1:1", { path: "src/a.ts" }, 120),
      attempt("a1:2", { path: "src/a.ts" }, 140),
    ],
    recovery: attempt("a1:3", { path: "src/a.ts" }, 60, {
      status: "completed",
    }),
  });
  const right = side({
    episode: episode({ tool: "grep", attemptCount: 1, failureEventIDs: ["b1:0"] }),
    attempts: [attempt("b1:0", { command: "ls" }, 90, { tool: "grep" })],
  });

  const result: EpisodeComparison = compareEpisodeData(left, right);
  const keys = collectKeys(result);
  const banned = /winner|optimal|recommendation|verdict|better/i;

  assert.ok(keys.length > 20);
  for (const key of keys) {
    assert.doesNotMatch(key, banned, `ranking key in DTO: ${key}`);
  }
  assert.ok(result.notes.length > 0);
  assert.ok(result.notes.every((note) => !note.includes("!")));
});

test("is deterministic and never mutates or aliases the inputs", () => {
  const left = side({
    episode: episode({ attemptCount: 2 }),
    attempts: [
      attempt("a1:0", { path: "src/a.ts", limit: 10 }, 120),
      attempt("a1:1", { path: "src/a.ts" }, 220),
    ],
  });
  const right = side({
    attempts: [
      attempt("b1:0", { path: "src/a.ts", limit: 10 }, 100),
      attempt("b1:1", { path: "src/a.ts" }, 180),
    ],
  });
  const snapshot = structuredClone({ left, right });

  const first = compareEpisodeData(left, right);
  const second = compareEpisodeData(left, right);

  assert.deepEqual(first, second);
  assert.notEqual(first.alignment, second.alignment);
  assert.deepEqual({ left, right }, snapshot);

  first.alignment[0]!.left!.duration.value = 999;
  first.alignment[0]!.left!.eventID = "mutated";
  assert.equal(left.attempts[0]!.duration.value, 120);
  assert.equal(left.attempts[0]!.eventID, "a1:0");
});
