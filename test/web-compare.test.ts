import test from "node:test";
import assert from "node:assert/strict";
import type {
  AlignedAttempt,
  EpisodeComparison,
  EpisodeTotals,
  TotalsDelta,
  TurnDelta,
  TurnSummary,
} from "../src/core/episodeCompare.ts";
import type { DiagnosticEpisode } from "../src/core/episodes.ts";
import type { Metric, SessionFamily, SessionSummary } from "../src/core/types.ts";
import {
  COMPARE_BANNER,
  COMPARE_CARD_WIDTH,
  COMPARE_KEYS_HINT,
  COMPARE_NO_ALIGNMENT,
  COMPARE_NO_EPISODES,
  COMPARE_TOKEN_INCOMPLETE,
  EPISODE_LOADING,
  EPISODE_NONE,
  EPISODE_PLACEHOLDER,
  EPISODE_SELECT_FIRST,
  EPISODE_UNAVAILABLE,
  alignmentRows,
  comparabilityLabel,
  compareApiPath,
  compareIdentityRows,
  compareKeyIntent,
  compareMetricRows,
  compareReady,
  compareSessionOptions,
  compareSessionTotalRows,
  compareStatusMessages,
  compareTokenRows,
  compareTurnRows,
  episodeLabel,
  episodeSelectState,
  isTypingTarget,
  metricCell,
  nextCompareSelection,
  tokenIncompleteNote,
  tokenLabel,
  turnCaption,
} from "../src/web/lib/compare.ts";

function metric(value: number | null, basis: Metric["basis"] = "derived", note?: string): Metric {
  return note ? { value, basis, note } : { value, basis };
}

function tokens() {
  return { input: 100, output: 50, reasoning: 5, cacheRead: 10, cacheWrite: 2 };
}

function totals(overrides: Partial<EpisodeTotals> = {}): EpisodeTotals {
  return {
    tokens: tokens(),
    tokensComplete: true,
    cost: metric(0.5),
    modelTime: metric(1_000),
    toolTime: metric(500),
    totalTime: metric(2_000),
    outputSpeed: metric(12.5),
    cacheHitRate: metric(0.25),
    ...overrides,
  };
}

function turn(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    ...totals(),
    index: 3,
    promptTokensLatest: metric(112),
    ...overrides,
  };
}

function delta(): TotalsDelta {
  return {
    tokens: {
      input: metric(10),
      output: metric(-5),
      reasoning: metric(0),
      cacheRead: metric(1),
      cacheWrite: metric(2),
    },
    cost: metric(0.1),
    modelTime: metric(100),
    toolTime: metric(50),
    totalTime: metric(200),
    outputSpeed: metric(1.5),
    cacheHitRate: metric(0.05),
  };
}

function turnDelta(): TurnDelta {
  return { ...delta(), promptTokensLatest: metric(7) };
}

function attempt(overrides: Partial<AlignedAttempt["left"]> = {}): NonNullable<AlignedAttempt["left"]> {
  return {
    eventID: "a1:0",
    tool: "grep",
    status: "error",
    input: { pattern: "foo" },
    duration: metric(120),
    ...overrides,
  };
}

function aligned(overrides: Partial<AlignedAttempt> = {}): AlignedAttempt {
  return {
    index: 1,
    kind: "attempt",
    presence: "both",
    left: attempt(),
    right: attempt({ eventID: "a2:0", status: "error" }),
    latencyDelta: metric(20),
    inputComparability: { left: "comparable", right: "comparable" },
    inputSimilarity: "identical",
    inputOverlap: 1,
    ...overrides,
  };
}

function comparison(overrides: Partial<EpisodeComparison> = {}): EpisodeComparison {
  return {
    schemaVersion: 1,
    redacted: true,
    left: {
      id: "e1",
      sessionID: "ses_1",
      turnID: "turn_1",
      turnIndex: 3,
      tool: "grep",
      attemptCount: 1,
      recovery: "recovered",
      similarity: "identical",
      recoveryEventID: null,
    },
    right: {
      id: "e2",
      sessionID: "ses_2",
      turnID: "turn_2",
      turnIndex: 4,
      tool: "grep",
      attemptCount: 2,
      recovery: "no-recovery-evidence",
      similarity: "related",
      recoveryEventID: null,
    },
    alignment: [aligned()],
    totals: { left: totals(), right: totals(), delta: delta() },
    turn: { left: turn(), right: turn({ index: 4 }), delta: turnDelta() },
    notes: ["Both sides recorded the same tool."],
    ...overrides,
  };
}

function episode(overrides: Partial<DiagnosticEpisode> = {}): DiagnosticEpisode {
  return {
    id: "ep_1",
    sessionID: "ses_1",
    turnID: "turn_1",
    turnIndex: 3,
    tool: "grep",
    attemptCount: 1,
    recovery: "recovered",
    similarity: "identical",
    failureEventIDs: ["a1:0"],
    recoveryEventID: null,
    ...overrides,
  };
}

function summary(id: string, title?: string): SessionSummary {
  return { id, title, timeCreated: 1 };
}

/* ------------------------------------------------------------- pickers */

test("session options are the current session, its parent and its children", () => {
  const family: SessionFamily = {
    rootID: "ses_1",
    parent: null,
    children: [summary("ses_2", "Child"), summary("ses_3")],
  };
  const options = compareSessionOptions({
    session: summary("ses_1", "Current task"),
    family,
    currentSessionID: "ses_1",
  });
  assert.deepEqual(options.map((option) => option.id), ["ses_1", "ses_2", "ses_3"]);
  assert.equal(options[0]?.label, "Current task (current)");
  assert.equal(options[1]?.label, "Child");
  // A child with no title falls back to its id, never to "(current)".
  assert.equal(options[2]?.label, "ses_3");

  // De-duplication: the same session cannot appear twice.
  const duplicated = compareSessionOptions({
    session: summary("ses_1"),
    family: { rootID: "ses_1", parent: summary("ses_1", "x"), children: [summary("ses_1")] },
    currentSessionID: "ses_1",
  });
  assert.equal(duplicated.length, 1);

  // No record at all, but a route id: the id is the only option.
  const fallback = compareSessionOptions({
    session: null,
    family: null,
    currentSessionID: "ses_9",
  });
  assert.deepEqual(fallback, [{ id: "ses_9", label: "ses_9 (current)" }]);
  assert.deepEqual(
    compareSessionOptions({ session: null, family: null, currentSessionID: null }),
    [],
  );
});

test("an episode label names its turn, tool, attempts and recovery", () => {
  assert.equal(episodeLabel(episode()), "turn #3 · grep · 1 attempt · Recovered");
  assert.equal(
    episodeLabel(episode({ attemptCount: 4, recovery: "no-recovery-evidence" })),
    "turn #3 · grep · 4 attempts · No recovery evidence",
  );
});

test("the episode picker has four distinct disabled and enabled states", () => {
  const base = { sessionID: "ses_1", loading: false, error: null, episodes: [episode()] };
  assert.deepEqual(episodeSelectState({ ...base, sessionID: null }), {
    label: EPISODE_SELECT_FIRST,
    disabled: true,
  });
  assert.deepEqual(episodeSelectState({ ...base, loading: true }), {
    label: EPISODE_LOADING,
    disabled: true,
  });
  assert.deepEqual(episodeSelectState({ ...base, error: "boom" }), {
    label: EPISODE_UNAVAILABLE,
    disabled: true,
  });
  assert.deepEqual(episodeSelectState({ ...base, episodes: [] }), {
    label: EPISODE_NONE,
    disabled: true,
  });
  assert.deepEqual(episodeSelectState(base), {
    label: EPISODE_PLACEHOLDER,
    disabled: false,
  });
});

test("the side status lines report failures and empty sessions", () => {
  const empty = { sessionID: "ses_1", loading: false, error: null, episodes: [] };
  const ok = { sessionID: "ses_2", loading: false, error: null, episodes: [episode()] };
  assert.deepEqual(compareStatusMessages({ left: empty, right: ok }), {
    message: `Left session: ${COMPARE_NO_EPISODES}`,
    error: false,
  });
  assert.deepEqual(
    compareStatusMessages({
      left: { ...empty, error: "Diagnostics unavailable" },
      right: ok,
    }),
    { message: "Left session: Diagnostics unavailable", error: true },
  );
  assert.deepEqual(compareStatusMessages({ left: ok, right: ok }), {
    message: "",
    error: false,
  });
});

/* ------------------------------------------------------------ requests */

test("the comparison path carries the four required parameters", () => {
  assert.equal(
    compareApiPath({
      leftSession: "ses_1",
      leftEpisode: "ep_1",
      rightSession: "ses_2",
      rightEpisode: "ep_2",
    }),
    "/api/episodes/compare?leftSession=ses_1&leftEpisode=ep_1&rightSession=ses_2&rightEpisode=ep_2",
  );
  // Values are query-encoded exactly once.
  const path = compareApiPath({
    leftSession: "ses 1",
    leftEpisode: "ep&1",
    rightSession: "ses_2",
    rightEpisode: "ep_2",
  });
  const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  assert.equal(query.get("leftSession"), "ses 1");
  assert.equal(query.get("leftEpisode"), "ep&1");
});

test("a comparison needs a session and an episode on both sides", () => {
  assert.equal(
    compareReady({
      left: { sessionID: "a", episodeID: "e" },
      right: { sessionID: "b", episodeID: "f" },
    }),
    true,
  );
  assert.equal(
    compareReady({
      left: { sessionID: "a", episodeID: null },
      right: { sessionID: "b", episodeID: "f" },
    }),
    false,
  );
  assert.equal(
    compareReady({
      left: { sessionID: "a", episodeID: "e" },
      right: { sessionID: null, episodeID: "f" },
    }),
    false,
  );
});

/* ------------------------------------------------------------ alignment */

test("alignment rows keep every recorded field and never guess a similarity", () => {
  const rows = alignmentRows(
    comparison({
      alignment: [
        aligned(),
        aligned({
          index: 2,
          kind: "recovery",
          presence: "left-only",
          right: null,
          latencyDelta: metric(null, "unavailable", "one side only"),
          inputComparability: { left: "redacted", right: "absent" },
          inputSimilarity: "not-comparable",
          inputOverlap: null,
        }),
      ],
    }),
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.index, 1);
  assert.equal(rows[0]?.kind, "Attempt");
  assert.equal(rows[0]?.presence, "Both");
  assert.equal(rows[0]?.leftStatus, "error");
  assert.equal(rows[0]?.leftDuration, "120 ms");
  assert.equal(rows[0]?.leftFlag, null);
  assert.equal(rows[0]?.leftInput, JSON.stringify({ pattern: "foo" }, null, 2));
  assert.equal(rows[0]?.latencyDelta, "20 ms");
  assert.equal(rows[0]?.similarity, "Identical");
  assert.equal(rows[0]?.overlap, "overlap 100.0%");

  assert.equal(rows[1]?.kind, "Recovery");
  assert.equal(rows[1]?.presence, "Left only");
  assert.equal(rows[1]?.rightStatus, null);
  assert.equal(rows[1]?.rightDuration, "—");
  assert.equal(rows[1]?.rightInput, null);
  assert.equal(rows[1]?.leftFlag, "redacted input");
  // A missing side has no attempt row to flag, so its comparability is not
  // claimed (`app.js:3811-3840`).
  assert.equal(rows[1]?.rightFlag, null);
  assert.equal(rows[1]?.latencyDelta, "—");
  assert.equal(rows[1]?.similarity, "Not comparable");
  assert.equal(rows[1]?.overlap, null);

  assert.deepEqual(alignmentRows(null), []);
  assert.deepEqual(alignmentRows({ ...comparison(), alignment: undefined as never }), []);
  assert.equal(COMPARE_NO_ALIGNMENT, "No attempts were aligned for this pair.");
});

test("input text is verbatim for strings and pretty JSON otherwise", () => {
  assert.equal(comparabilityLabel("comparable"), null);
  assert.equal(comparabilityLabel("absent"), "absent input");
  assert.equal(comparabilityLabel("truncated"), "truncated input");
  assert.equal(comparabilityLabel("redacted"), "redacted input");
});

/* --------------------------------------------------------------- tables */

test("metric cells keep provenance marks and unavailable readings", () => {
  const derived = metricCell(metric(0.5, "derived", "sum"), (value) => `$${value.toFixed(2)}`);
  assert.deepEqual(derived, {
    text: "$0.50",
    title: "derived: sum",
    available: true,
    mark: "D",
  });

  const measured = metricCell(metric(12.5, "measured"), (value) => `${value} tok/s`);
  assert.equal(measured.text, "12.5 tok/s");
  assert.equal(measured.title, null);
  assert.equal(measured.mark, null);

  const missing = metricCell(metric(null, "unavailable", "one side only"), String);
  assert.equal(missing.text, "—");
  assert.equal(missing.title, "one side only");
  assert.equal(missing.available, false);
  assert.equal(missing.mark, null);

  assert.equal(metricCell(null, String).text, "—");
});

test("the metric and token tables are built from left, right and delta", () => {
  const rows = compareMetricRows(compareSessionTotalRows(), comparison().totals);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Cost", "Model time", "Tool time", "Active turn time", "Output speed", "Cache hit rate"],
  );
  assert.equal(rows[0]?.left.text, "$0.5000");
  assert.equal(rows[0]?.delta.text, "$0.1000");
  assert.equal(rows[3]?.left.text, "2.00 s");
  assert.equal(rows[5]?.left.text, "25.0%");

  const turnRows = compareMetricRows(compareTurnRows(), comparison().turn);
  assert.equal(turnRows.at(-1)?.label, "Prompt tokens (latest)");
  assert.equal(turnRows.at(-1)?.left.text, "112");

  const totalTokens = compareTokenRows(comparison().totals);
  assert.deepEqual(
    totalTokens.map((row) => row.label),
    ["Input", "Output", "Reasoning", "Cache read", "Cache write"],
  );
  assert.equal(totalTokens[0]?.left, "100");
  assert.equal(totalTokens[0]?.delta, "10");
  assert.equal(totalTokens[1]?.delta, "-5");
});

test("incomplete token counts make the delta unavailable, never partial", () => {
  const complete = comparison().totals;
  assert.equal(tokenIncompleteNote(complete), "");
  assert.equal(
    tokenIncompleteNote({
      left: { ...complete.left, tokensComplete: false },
      right: complete.right,
    }),
    COMPARE_TOKEN_INCOMPLETE,
  );
  assert.equal(
    tokenIncompleteNote({
      left: complete.left,
      right: { ...complete.right, tokensComplete: false },
    }),
    COMPARE_TOKEN_INCOMPLETE,
  );
});

test("identity rows name the descriptor verbatim", () => {
  assert.deepEqual(compareIdentityRows(comparison().left), [
    { label: "Session", value: "ses_1" },
    { label: "Turn", value: "#3" },
    { label: "Tool", value: "grep" },
    { label: "Attempts", value: "1" },
    { label: "Recovery", value: "Recovered" },
    { label: "Similarity", value: "Identical" },
  ]);
  assert.deepEqual(compareIdentityRows(null), []);
});

test("the turn caption follows the payload's turn index", () => {
  assert.equal(turnCaption(comparison()), "Turn #3 metrics");
  const withoutTurn = comparison();
  const payload = {
    ...withoutTurn,
    turn: {
      ...withoutTurn.turn,
      left: { ...withoutTurn.turn.left, index: undefined as unknown as number },
    },
  };
  assert.equal(turnCaption(payload), "Turn #3 metrics");
  assert.equal(turnCaption(null), "Turn metrics");
});

test("verdict tokens become sentence-case words", () => {
  assert.equal(tokenLabel("no-recovery-evidence"), "No recovery evidence");
  assert.equal(tokenLabel("left-only"), "Left only");
  assert.equal(tokenLabel(undefined), "Unknown");
  assert.equal(COMPARE_CARD_WIDTH, 960);
  assert.match(COMPARE_BANNER, /No attempt is designated as better/);
});

/* -------------------------------------------------------------- keyboard */

test("arrow intents: rows move, typing keeps native behaviour", () => {
  assert.deepEqual(compareKeyIntent("Escape", { typing: false, hasRows: true }), {
    kind: "close",
  });
  assert.deepEqual(compareKeyIntent("Tab", { typing: false, hasRows: true }), {
    kind: "trap-focus",
  });
  assert.deepEqual(compareKeyIntent("ArrowDown", { typing: false, hasRows: true }), {
    kind: "move",
    delta: 1,
    preventDefault: true,
  });
  assert.deepEqual(compareKeyIntent("ArrowUp", { typing: false, hasRows: true }), {
    kind: "move",
    delta: -1,
    preventDefault: true,
  });
  assert.deepEqual(compareKeyIntent("ArrowLeft", { typing: false, hasRows: true }), {
    kind: "focus-input",
    side: "left",
    preventDefault: true,
  });
  assert.deepEqual(compareKeyIntent("ArrowRight", { typing: false, hasRows: true }), {
    kind: "focus-input",
    side: "right",
    preventDefault: true,
  });
  // A select or input keeps its own arrow behaviour.
  assert.deepEqual(compareKeyIntent("ArrowDown", { typing: true, hasRows: true }), {
    kind: "native",
  });
  // No rows: nothing to move, so the key is left alone.
  assert.deepEqual(compareKeyIntent("ArrowDown", { typing: false, hasRows: false }), {
    kind: "ignore",
  });
  assert.deepEqual(compareKeyIntent("a", { typing: false, hasRows: true }), {
    kind: "ignore",
  });
});

test("the alignment selection wraps at both ends", () => {
  assert.equal(nextCompareSelection(0, 3, 1), 1);
  assert.equal(nextCompareSelection(2, 3, 1), 0);
  assert.equal(nextCompareSelection(0, 3, -1), 2);
  assert.equal(nextCompareSelection(1, 1, 1), 0);
  assert.equal(nextCompareSelection(4, 0, -1), 0);
});

test("typing targets are the fields and contenteditable regions", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
  assert.match(COMPARE_KEYS_HINT, /Esc closes/);
});
