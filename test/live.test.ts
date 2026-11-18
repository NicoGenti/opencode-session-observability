import test from "node:test";
import assert from "node:assert/strict";

import { ObservabilityService } from "../src/core/service.ts";
import {
  LIVE_WARNING_RULE_IDS,
  MAX_NEW_EVENTS,
  deriveLiveSnapshot,
} from "../src/core/live.ts";
import type { HealthRuleId, HealthRuleResult, SessionHealth } from "../src/core/health.ts";
import type { Analysis, SessionMeta } from "../src/core/types.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  incompleteFixture,
  longFixture,
  memorySource,
  secretsFixture,
  session,
  simpleFixture,
  textBlock,
  toolBlock,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

const TOKENS = {
  input: 10,
  output: 2,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

async function analysisOf(data: Fixture): Promise<Analysis> {
  const service = new ObservabilityService(memorySource(data));
  const dataset = await service.loadDataset(data.sessions[0]!.meta.id);
  return dataset.analysis;
}

/** A running session whose only turn has just its user message (no chunk yet). */
function stepLessOpenFixture(id: string): Fixture {
  return fixture([
    {
      meta: session(id, {
        outcome: undefined,
        time: { created: BASE, updated: BASE + 50, busy: BASE + 50, idle: BASE - 1 },
      }),
      messages: [user("msg_u1", 1, BASE)],
    },
  ]);
}

/** One complete turn without a recorded idle message. */
function pendingFixture(
  id: string,
  time: SessionMeta["time"],
): Fixture {
  return fixture([
    {
      meta: session(id, { outcome: undefined, time }),
      messages: [
        user("msg_u1", 1, BASE),
        assistant({
          id: "msg_a1",
          seq: 2,
          created: BASE + 100,
          streamed: BASE + 400,
          completed: BASE + 600,
          content: [textBlock("ok")],
          tokens: TOKENS,
          cost: 0.001,
        }),
      ],
    },
  ]);
}

function triggered(
  id: HealthRuleId,
  overrides: Partial<HealthRuleResult> = {},
): HealthRuleResult {
  return {
    id,
    label: `${id} label`,
    triggered: true,
    level: "watch",
    evaluable: true,
    note: `${id} observed`,
    eventIDs: [],
    turnIDs: [],
    ...overrides,
  };
}

function healthWith(rules: HealthRuleResult[]): SessionHealth {
  return {
    state: "degraded",
    insufficient: false,
    insufficientReasons: [],
    rules,
    triggeredCount: rules.filter((rule) => rule.triggered).length,
  };
}

test("state matrix distinguishes running, idle, ended and unknown", async () => {
  const running = await analysisOf(incompleteFixture());
  assert.equal(deriveLiveSnapshot(running).state, "running");
  assert.equal(
    deriveLiveSnapshot(running).openTurn?.id,
    running.turns[running.turns.length - 1]!.id,
  );

  const idleTurn = await analysisOf(
    pendingFixture("ses_live_idle", {
      created: BASE,
      updated: BASE + 600,
      busy: BASE,
      idle: BASE + 600,
    }),
  );
  assert.equal(deriveLiveSnapshot(idleTurn).state, "idle");
  assert.equal(deriveLiveSnapshot(idleTurn).openTurn, null);

  const unknown = await analysisOf(
    pendingFixture("ses_live_unknown", {
      created: BASE,
      updated: BASE + 600,
    }),
  );
  assert.equal(deriveLiveSnapshot(unknown).state, "unknown");

  const endedByOutcome = await analysisOf(simpleFixture());
  assert.equal(deriveLiveSnapshot(endedByOutcome).state, "ended");

  const endedByIdle = await analysisOf(
    fixture([
      {
        meta: session("ses_live_ended", {
          outcome: undefined,
          time: { created: BASE, updated: BASE + 700, busy: BASE, idle: BASE + 700 },
        }),
        messages: [
          user("msg_u1", 1, BASE),
          assistant({
            id: "msg_a1",
            seq: 2,
            created: BASE + 100,
            streamed: BASE + 400,
            completed: BASE + 600,
            content: [textBlock("ok")],
            tokens: TOKENS,
            cost: 0.001,
          }),
          idle("msg_i1", 3, BASE + 700, "succeeded"),
        ],
      },
    ]),
  );
  assert.equal(deriveLiveSnapshot(endedByIdle).state, "ended");
});

test("openTurn carries the existing turn metrics and the in-progress label", async () => {
  const analysis = await analysisOf(incompleteFixture());
  const snapshot = deriveLiveSnapshot(analysis);
  const turn = analysis.turns[analysis.turns.length - 1]!;

  assert.ok(snapshot.openTurn);
  assert.equal(snapshot.openTurn.index, turn.index);
  assert.equal(snapshot.openTurn.id, turn.id);
  assert.equal(snapshot.openTurn.startedAt, turn.startTime);
  assert.equal(snapshot.openTurn.steps, turn.steps.length);
  assert.deepEqual(snapshot.openTurn.tokens, turn.tokens);
  assert.deepEqual(snapshot.openTurn.cost, turn.cost);
  assert.deepEqual(snapshot.openTurn.uncertainty, ["session-in-progress"]);
  assert.equal(snapshot.basis, "derived");
  assert.equal(typeof snapshot.asOf, "number");
  assert.equal(snapshot.totalInSession, analysis.events.length);
});

test("a just-opened step-less turn is the open turn", async () => {
  const analysis = await analysisOf(stepLessOpenFixture("ses_live_open"));
  const turn = analysis.turns[analysis.turns.length - 1]!;
  assert.equal(turn.status, "unknown");
  assert.equal(turn.steps.length, 0);

  const snapshot = deriveLiveSnapshot(analysis);

  assert.equal(snapshot.state, "running");
  assert.ok(snapshot.openTurn);
  assert.equal(snapshot.openTurn.id, turn.id);
  assert.equal(snapshot.openTurn.steps, 0);
});

/**
 * Two turns: the first still looks in progress, the last one errored. The old
 * backwards scan reported the finished session as having an open turn.
 */
function settledAfterErroredTurnFixture(id: string): Fixture {
  return fixture([
    {
      meta: session(id, {
        outcome: undefined,
        time: { created: BASE, updated: BASE + 1_500, busy: BASE + 1_500, idle: BASE - 1 },
      }),
      messages: [
        user("msg_u1", 1, BASE),
        assistant({
          id: "msg_a1",
          seq: 2,
          created: BASE + 100,
          streamed: BASE + 500,
          completed: null,
          content: [
            toolBlock({
              name: "shell",
              created: BASE + 200,
              ran: BASE + 300,
              completed: null,
              status: "running",
              input: { command: "sleep 100" },
            }),
          ],
          tokens: TOKENS,
          cost: 0.001,
        }),
        user("msg_u2", 3, BASE + 800, "Next"),
        assistant({
          id: "msg_a2",
          seq: 4,
          created: BASE + 900,
          streamed: BASE + 1_000,
          completed: BASE + 1_400,
          content: [
            toolBlock({
              name: "shell",
              created: BASE + 950,
              ran: BASE + 1_000,
              completed: BASE + 1_400,
              status: "error",
              input: { command: "false" },
            }),
          ],
          tokens: TOKENS,
          cost: 0.001,
          error: { type: "UnknownError", message: "boom" },
        }),
      ],
    },
  ]);
}

test("an errored last turn is settled, so no open turn is reported", async () => {
  const analysis = await analysisOf(
    settledAfterErroredTurnFixture("ses_live_errored"),
  );
  const [first, last] = analysis.turns;
  assert.ok(first && last);
  assert.equal(first.status, "running");
  assert.equal(last.status, "error");

  const snapshot = deriveLiveSnapshot(analysis);

  assert.equal(snapshot.openTurn, null);
});

test("warnings are the five operational rules, never unfinished-outcome", async () => {
  const analysis = structuredClone(await analysisOf(simpleFixture()));
  analysis.health = healthWith([
    triggered("error-rate"),
    ...LIVE_WARNING_RULE_IDS.map((id) => triggered(id)),
    triggered("unfinished-outcome"),
  ]);

  const snapshot = deriveLiveSnapshot(analysis);

  assert.deepEqual(
    snapshot.warnings.map((warning) => warning.id),
    [...LIVE_WARNING_RULE_IDS],
  );
  for (const warning of snapshot.warnings) {
    assert.equal(warning.triggered, true);
    assert.equal(warning.basis, "derived");
    assert.deepEqual(warning.uncertainty, ["session-in-progress"]);
  }
  assert.equal(
    snapshot.warnings.some((warning) => warning.id === "unfinished-outcome"),
    false,
  );
});

test("warning evidence is capped at the health caps", async () => {
  const analysis = structuredClone(await analysisOf(simpleFixture()));
  analysis.health = healthWith([
    triggered("retry-count", {
      eventIDs: Array.from({ length: 15 }, (_, index) => `evt_${index}`),
      turnIDs: Array.from({ length: 9 }, (_, index) => `turn_${index}`),
    }),
  ]);

  const [warning] = deriveLiveSnapshot(analysis).warnings;
  assert.ok(warning);
  assert.equal(warning.eventIDs.length, 10);
  assert.equal(warning.turnIDs.length, 6);
});

test("lastTurns bounds openTurn and the warning evidence and labels the window", async () => {
  const analysis = structuredClone(await analysisOf(longFixture(3)));
  const [first, , last] = analysis.turns;
  assert.ok(first && last);
  const eventOfLast = analysis.events.find((event) => event.turnID === last.id);
  const eventOfFirst = analysis.events.find((event) => event.turnID === first.id);
  assert.ok(eventOfLast && eventOfFirst);
  analysis.health = healthWith([
    triggered("cost-per-turn", { turnIDs: [first.id, last.id] }),
    triggered("retry-count", { eventIDs: [eventOfFirst.id] }),
    triggered("low-cache-hit", { eventIDs: [eventOfLast.id] }),
  ]);

  const snapshot = deriveLiveSnapshot(analysis, { lastTurns: 1 });

  assert.deepEqual(snapshot.turnWindow, { last: 1, of: 3 });
  assert.deepEqual(
    snapshot.warnings.map((warning) => warning.id),
    ["cost-per-turn", "low-cache-hit"],
  );
  assert.deepEqual(snapshot.warnings[0]!.turnIDs, [last.id]);
  assert.deepEqual(snapshot.warnings[1]!.eventIDs, [eventOfLast.id]);
  // The rule's counts stay session-wide, so the note says so; only its
  // evidence is trimmed to the window.
  for (const warning of snapshot.warnings) {
    assert.match(
      warning.note,
      /\(session-wide counts; evidence limited to the last 1 turn\)$/,
    );
  }
  for (const warning of deriveLiveSnapshot(analysis).warnings) {
    assert.doesNotMatch(warning.note, /session-wide counts/);
  }
});

test("since trims the event tail by orderKey and caps the page", async () => {
  const analysis = await analysisOf(longFixture(20));

  assert.equal(deriveLiveSnapshot(analysis).newEvents, null);
  assert.equal(deriveLiveSnapshot(analysis, { since: "" }).newEvents, null);

  const cursor = analysis.events[5]!.orderKey;
  const snapshot = deriveLiveSnapshot(analysis, { since: cursor });
  assert.ok(snapshot.newEvents);
  assert.equal(snapshot.newEvents.length, MAX_NEW_EVENTS);
  for (const event of snapshot.newEvents) {
    assert.ok(event.orderKey > cursor, `${event.orderKey} is not after ${cursor}`);
  }

  const last = analysis.events[analysis.events.length - 1]!.orderKey;
  assert.deepEqual(deriveLiveSnapshot(analysis, { since: last }).newEvents, []);
});

test("snapshot derivation is deterministic", async () => {
  const analysis = await analysisOf(longFixture(5));
  const cursor = analysis.events[2]!.orderKey;

  const first = deriveLiveSnapshot(analysis, { lastTurns: 2, since: cursor });
  const second = deriveLiveSnapshot(analysis, { lastTurns: 2, since: cursor });

  assert.deepEqual(first, second);
});

test("liveSnapshot follows requestKey invalidation without clearing the cache", async () => {
  const data = simpleFixture();
  const entry = data.sessions[0]!;
  const service = new ObservabilityService(memorySource(data));

  let cleared = 0;
  const clear = service.clearCache.bind(service);
  service.clearCache = () => {
    cleared += 1;
    clear();
  };

  const first = await service.liveSnapshot(entry.meta.id);
  assert.equal(service.describe().cacheEntries, 1);

  // A mutating source: the session row moves and three messages are recorded.
  const at = BASE + 5_000;
  entry.meta.time.updated = at;
  entry.messages.push(
    user("msg_u2", 4, at, "Next"),
    assistant({
      id: "msg_a2",
      seq: 5,
      created: at + 100,
      streamed: at + 400,
      completed: at + 600,
      content: [textBlock("Next answer")],
      tokens: TOKENS,
      cost: 0.001,
    }),
    idle("msg_i2", 6, at + 700, "succeeded"),
  );

  const second = await service.liveSnapshot(entry.meta.id);

  assert.ok(second.totalInSession > first.totalInSession);
  assert.equal(cleared, 0);
  assert.equal(service.describe().cacheEntries, 1);
});

test("liveSnapshot redacts by default and reveals explicitly", async () => {
  const data = secretsFixture();
  const id = data.sessions[0]!.meta.id;
  const service = new ObservabilityService(memorySource(data));
  const since = "0";

  const redacted = JSON.stringify(await service.liveSnapshot(id, { since }));
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(redacted, /\[REDACTED/);

  const revealed = JSON.stringify(
    await service.liveSnapshot(id, { since, reveal: true }),
  );
  assert.match(revealed, /sk-abcdefghijklmnopqrstuvwxyz/);
});

test("the live DTO carries no payload text of the secret-bearing session", async () => {
  const data = secretsFixture();
  const service = new ObservabilityService(memorySource(data));
  const snapshot = await service.liveSnapshot(data.sessions[0]!.meta.id, {
    since: "0",
    lastTurns: 3,
  });
  // Recursive: JSON.stringify walks the whole DTO, so a payload string
  // anywhere (title, preview, evidence, note) would surface here.
  const text = JSON.stringify(snapshot);

  for (const secret of [
    "curl -H 'Authorization: Bearer abcdefghijklmnop'",
    "sk-supersecretvalue12345",
    "hunter2",
  ]) {
    assert.equal(text.includes(secret), false, `payload leaked: ${secret}`);
  }
  assert.ok(
    Array.isArray(snapshot.newEvents) && snapshot.newEvents.length > 0,
    "the cursor page must be present so the assertion is not vacuous",
  );
  assert.match(text, /\[REDACTED/);
});

test("snapshot derivation stays bounded on a 300-turn fixture", async () => {
  const analysis = await analysisOf(longFixture(300));
  const cursor = analysis.events[Math.floor(analysis.events.length / 2)]!.orderKey;

  const started = performance.now();
  for (let index = 0; index < 200; index += 1) {
    deriveLiveSnapshot(analysis, { lastTurns: 10, since: cursor });
  }
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 3_000, `snapshot derivation took ${elapsed.toFixed(1)} ms`);
});
