import test from "node:test";
import assert from "node:assert/strict";
import {
  EpisodeNotFoundError,
  ObservabilityService,
} from "../src/core/service.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  memorySource,
  session,
  toolBlock,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";
import type { RawMessage } from "../src/core/types.ts";

/**
 * Credential-shaped call input. `redactValue` rewrites the bearer token, so the
 * same episode classifies as `"comparable"` under reveal and `"redacted"` (a
 * redaction sentinel) without it. The literal never appears in redacted output.
 */
const SECRET_INPUT = {
  command:
    "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.test",
};

let callCounter = 0;

function toolCall(
  name: string,
  input: unknown,
  options: { at: number; status?: "completed" | "error" },
): unknown {
  callCounter += 1;
  return toolBlock({
    callID: `call_${callCounter}`,
    name,
    created: options.at,
    ran: options.at + 5,
    completed: options.at + 10,
    status: options.status ?? "completed",
    input,
    output: options.status === "error" ? "" : "ok",
  });
}

function assistantMessage(
  id: string,
  seq: number,
  created: number,
  content: unknown[],
): RawMessage {
  return assistant({
    id,
    seq,
    created,
    streamed: created + 400,
    completed: created + 500,
    content,
  });
}

/** Two sessions, each with a repeated-tool failure run; alpha also fails on a secret input. */
function episodesFixture(): Fixture {
  const alpha: RawMessage[] = [
    user("msg_u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      toolCall("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      toolCall("read", { path: "src/a.ts" }, { at: BASE + 300, status: "error" }),
      toolCall("read", { path: "src/a.ts" }, { at: BASE + 400 }),
    ]),
    idle("msg_i1", 3, BASE + 600, "succeeded"),
    user("msg_u2", 4, BASE + 700),
    assistantMessage("a2", 5, BASE + 800, [
      toolCall("shell", SECRET_INPUT, { at: BASE + 900, status: "error" }),
      toolCall("shell", SECRET_INPUT, { at: BASE + 1_000, status: "error" }),
      toolCall("shell", SECRET_INPUT, { at: BASE + 1_100 }),
    ]),
    idle("msg_i2", 6, BASE + 1_200, "succeeded"),
  ];
  const beta: RawMessage[] = [
    user("msg_u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      toolCall(
        "read",
        { path: "src/b.ts", depth: 1 },
        { at: BASE + 200, status: "error" },
      ),
      toolCall(
        "read",
        { path: "src/b.ts", depth: 1 },
        { at: BASE + 300, status: "error" },
      ),
      toolCall(
        "read",
        { path: "src/b.ts", depth: 1 },
        { at: BASE + 400, status: "error" },
      ),
      toolCall("read", { path: "src/b.ts", depth: 1 }, { at: BASE + 500 }),
    ]),
    idle("msg_i1", 3, BASE + 700, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_alpha", {
        time: {
          created: BASE,
          updated: BASE + 1_200,
          busy: BASE,
          idle: BASE + 1_200,
        },
      }),
      messages: alpha,
    },
    {
      meta: session("ses_beta", {
        time: {
          created: BASE,
          updated: BASE + 700,
          busy: BASE,
          idle: BASE + 700,
        },
      }),
      messages: beta,
    },
  ]);
}

function createService(): ObservabilityService {
  return new ObservabilityService(memorySource(episodesFixture()));
}

test("diagnostics returns incidents, episodes and an honest redacted flag", async () => {
  const service = createService();
  const result = await service.diagnostics("ses_alpha");

  assert.equal(result.redacted, true);
  assert.equal(result.diagnostics.summary.incidents, 2);
  assert.equal(result.episodes.length, 2);

  const [read, shell] = result.episodes;
  assert.equal(read!.id, "ses_alpha:ses_alpha:t1:read:a1:0");
  assert.equal(read!.sessionID, "ses_alpha");
  assert.equal(read!.turnID, "ses_alpha:t1");
  assert.equal(read!.turnIndex, 1);
  assert.equal(read!.tool, "read");
  assert.equal(read!.attemptCount, 2);
  assert.deepEqual(read!.failureEventIDs, ["a1:0", "a1:1"]);
  assert.equal(read!.recovery, "recovered");
  assert.equal(read!.recoveryEventID, "a1:2");
  assert.equal(read!.similarity, "identical");

  // The credential-shaped input is redacted first, so the rule reports
  // insufficient data instead of pretending the inputs are comparable.
  assert.equal(shell!.id, "ses_alpha:ses_alpha:t2:shell:a2:0");
  assert.equal(shell!.turnIndex, 2);
  assert.equal(shell!.attemptCount, 2);
  assert.deepEqual(shell!.failureEventIDs, ["a2:0", "a2:1"]);
  assert.equal(shell!.similarity, "unknown");
  assert.equal(shell!.recovery, "insufficient-data");
  assert.equal(shell!.recoveryEventID, null);

  const incident = result.diagnostics.incidents[1]!;
  assert.equal(incident.inputsComparable, false);
  assert.match(incident.why, /contains a redaction sentinel/);
});

test("diagnostics re-evaluates classification when reveal is enabled", async () => {
  const service = createService();
  const hidden = await service.diagnostics("ses_alpha");
  service.clearCache();
  const revealed = await service.diagnostics("ses_alpha", { reveal: true });

  assert.equal(hidden.redacted, true);
  assert.equal(revealed.redacted, false);
  assert.equal(hidden.diagnostics.incidents[1]!.similarity, "unknown");
  assert.equal(revealed.diagnostics.incidents[1]!.similarity, "identical");
  assert.equal(revealed.diagnostics.incidents[1]!.inputsComparable, true);

  const shell = revealed.episodes[1]!;
  assert.equal(shell.recovery, "recovered");
  assert.equal(shell.recoveryEventID, "a2:2");
  // Episode ids are event-id based, so they survive redaction unchanged.
  assert.deepEqual(
    revealed.episodes.map((episode) => episode.id),
    hidden.episodes.map((episode) => episode.id),
  );
});

test("compareEpisodes aligns two sessions by recorded ordinal", async () => {
  const service = createService();
  const alpha = await service.diagnostics("ses_alpha", { reveal: true });
  const beta = await service.diagnostics("ses_beta", { reveal: true });

  const comparison = await service.compareEpisodes({
    leftSessionID: "ses_alpha",
    leftEpisodeID: alpha.episodes[0]!.id,
    rightSessionID: "ses_beta",
    rightEpisodeID: beta.episodes[0]!.id,
    reveal: true,
  });

  assert.equal(comparison.schemaVersion, 1);
  assert.equal(comparison.redacted, false);
  assert.equal(comparison.left.sessionID, "ses_alpha");
  assert.equal(comparison.right.sessionID, "ses_beta");
  assert.equal(comparison.left.tool, "read");
  assert.equal(comparison.alignment.length, 4);
  assert.deepEqual(
    comparison.alignment.map((row) => [row.index, row.presence, row.kind]),
    [
      [1, "both", "attempt"],
      [2, "both", "attempt"],
      [3, "right-only", "attempt"],
      [4, "both", "recovery"],
    ],
  );

  const [first, , third, recovery] = comparison.alignment;
  assert.deepEqual(first!.left!.input, { path: "src/a.ts" });
  assert.deepEqual(first!.right!.input, { path: "src/b.ts", depth: 1 });
  assert.equal(first!.left!.eventID, "a1:0");
  assert.equal(first!.left!.duration.value, 5);
  // Both calls were recorded as ran -> completed, so the delta is derived.
  assert.equal(first!.latencyDelta.value, 0);
  assert.equal(first!.latencyDelta.basis, "derived");
  assert.deepEqual(first!.inputComparability, {
    left: "comparable",
    right: "comparable",
  });
  assert.equal(first!.inputSimilarity, "related");
  assert.equal(first!.inputOverlap, 0.5);

  assert.equal(third!.left, null);
  assert.equal(third!.right!.eventID, "a1:2");
  assert.equal(recovery!.left!.eventID, "a1:2");
  assert.equal(recovery!.right!.eventID, "a1:3");
  assert.ok(comparison.notes.includes("1 attempt(s) only in right"));
});

test("compareEpisodes carries the structural totals and turn subsets", async () => {
  const service = createService();
  const alpha = await service.diagnostics("ses_alpha", { reveal: true });
  const beta = await service.diagnostics("ses_beta", { reveal: true });
  const analysis = (await service.analyze("ses_alpha", { reveal: true })).analysis;

  const comparison = await service.compareEpisodes({
    leftSessionID: "ses_alpha",
    leftEpisodeID: alpha.episodes[0]!.id,
    rightSessionID: "ses_beta",
    rightEpisodeID: beta.episodes[0]!.id,
    reveal: true,
  });

  assert.equal(comparison.turn.left.index, 1);
  assert.equal(comparison.turn.right.index, 1);
  assert.deepEqual(comparison.totals.left.tokens, analysis.totals.tokens);
  assert.equal(
    comparison.totals.left.tokensComplete,
    analysis.totals.tokensComplete,
  );
  assert.deepEqual(
    comparison.turn.left.totalTime,
    analysis.turns[0]!.totalTime,
  );
  assert.deepEqual(
    comparison.turn.left.promptTokensLatest,
    analysis.turns[0]!.promptTokensLatest,
  );
});

test("compareEpisodes resolves two episodes of one session from one dataset", async () => {
  const service = createService();
  const diagnostics = await service.diagnostics("ses_alpha", { reveal: true });
  const [read, shell] = diagnostics.episodes;

  const comparison = await service.compareEpisodes({
    leftSessionID: "ses_alpha",
    leftEpisodeID: read!.id,
    rightSessionID: "ses_alpha",
    rightEpisodeID: shell!.id,
    reveal: true,
  });

  assert.equal(comparison.left.sessionID, "ses_alpha");
  assert.equal(comparison.right.sessionID, "ses_alpha");
  assert.equal(comparison.alignment.length, 3);
  assert.equal(comparison.turn.left.index, 1);
  assert.equal(comparison.turn.right.index, 2);
  assert.ok(
    comparison.notes.includes(
      "left episode tool is read and right episode tool is shell",
    ),
  );
  assert.equal(service.describe().cacheEntries, 1);
});

test("compareEpisodes rejects an episode id it cannot resolve", async () => {
  const service = createService();
  const alpha = await service.diagnostics("ses_alpha", { reveal: true });
  const beta = await service.diagnostics("ses_beta", { reveal: true });
  const unknownID = "ses_alpha:ses_alpha:t1:read:a9:9";

  await assert.rejects(
    service.compareEpisodes({
      leftSessionID: "ses_alpha",
      leftEpisodeID: unknownID,
      rightSessionID: "ses_beta",
      rightEpisodeID: beta.episodes[0]!.id,
      reveal: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof EpisodeNotFoundError);
      assert.equal(error.name, "EpisodeNotFoundError");
      assert.equal(error.message, `Episode not found: ${unknownID}`);
      return true;
    },
  );

  // An id from another session is not resolvable either.
  await assert.rejects(
    service.compareEpisodes({
      leftSessionID: "ses_alpha",
      leftEpisodeID: alpha.episodes[0]!.id,
      rightSessionID: "ses_beta",
      rightEpisodeID: alpha.episodes[1]!.id,
      reveal: true,
    }),
    EpisodeNotFoundError,
  );
});

test("compareEpisodes reveals raw inputs only under reveal and redacts otherwise", async () => {
  const service = createService();
  const diagnostics = await service.diagnostics("ses_alpha", { reveal: true });
  const [read, shell] = diagnostics.episodes;

  const revealed = await service.compareEpisodes({
    leftSessionID: "ses_alpha",
    leftEpisodeID: read!.id,
    rightSessionID: "ses_alpha",
    rightEpisodeID: shell!.id,
    reveal: true,
  });

  assert.equal(revealed.redacted, false);
  assert.equal(revealed.alignment.length, 3);
  assert.deepEqual(revealed.alignment[0]!.right!.input, SECRET_INPUT);
  assert.deepEqual(revealed.alignment[0]!.inputComparability, {
    left: "comparable",
    right: "comparable",
  });

  service.clearCache();
  const hidden = await service.compareEpisodes({
    leftSessionID: "ses_alpha",
    leftEpisodeID: read!.id,
    rightSessionID: "ses_alpha",
    rightEpisodeID: shell!.id,
  });

  assert.equal(hidden.redacted, true);
  // Without reveal the secret-bearing run has no comparable recovery evidence,
  // so only the visible side contributes a recovery row.
  assert.equal(hidden.right.recovery, "insufficient-data");
  assert.equal(hidden.right.recoveryEventID, null);
  assert.equal(hidden.alignment.length, 3);
  assert.equal(hidden.alignment[2]!.kind, "recovery");
  assert.equal(hidden.alignment[2]!.presence, "left-only");
  assert.equal(hidden.alignment[2]!.right, null);
  assert.ok(hidden.notes.includes("recovery call only in left"));
  const rightInput = hidden.alignment[0]!.right!.input;
  assert.match(JSON.stringify(rightInput), /\[REDACTED/);
  assert.deepEqual(hidden.alignment[0]!.inputComparability, {
    left: "comparable",
    right: "redacted",
  });
  assert.equal(hidden.alignment[0]!.inputSimilarity, "not-comparable");
  assert.equal(hidden.alignment[0]!.inputOverlap, null);
  assert.ok(hidden.notes.includes("right inputs are redacted"));

  const serialized = JSON.stringify(hidden);
  assert.equal(serialized.includes("abcdefghijklmnop"), false);
  assert.equal(serialized.includes("Bearer"), false);
});

test("dataset cache is reused without leaking reveal state", async () => {
  const service = createService();
  assert.equal(service.describe().cacheEntries, 0);

  const alpha = await service.diagnostics("ses_alpha");
  assert.equal(alpha.redacted, true);
  assert.equal(service.describe().cacheEntries, 1);

  // The cached dataset is raw: reveal is applied per call, so flipping it on a
  // warm cache is still correct.
  const warmRevealed = await service.diagnostics("ses_alpha", { reveal: true });
  assert.equal(warmRevealed.redacted, false);
  assert.equal(service.describe().cacheEntries, 1);

  const beta = await service.diagnostics("ses_beta", { reveal: true });
  assert.equal(service.describe().cacheEntries, 2);

  const crossSession = await service.compareEpisodes({
    leftSessionID: "ses_alpha",
    leftEpisodeID: alpha.episodes[0]!.id,
    rightSessionID: "ses_beta",
    rightEpisodeID: beta.episodes[0]!.id,
    reveal: true,
  });
  assert.equal(crossSession.alignment.length, 4);
  assert.equal(service.describe().cacheEntries, 2);

  service.clearCache();
  assert.equal(service.describe().cacheEntries, 0);
  const sameSession = await service.compareEpisodes({
    leftSessionID: "ses_alpha",
    leftEpisodeID: alpha.episodes[0]!.id,
    rightSessionID: "ses_alpha",
    rightEpisodeID: alpha.episodes[1]!.id,
    reveal: true,
  });
  assert.equal(sameSession.alignment.length, 3);
  assert.equal(service.describe().cacheEntries, 1);
});
