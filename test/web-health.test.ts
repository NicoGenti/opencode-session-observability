import test from "node:test";
import assert from "node:assert/strict";
import type { HealthRuleResult, SessionHealth } from "../src/core/health.ts";
import {
  MAX_EVENT_LINKS,
  MAX_TURN_LINKS,
} from "../src/core/health.ts";
import type { Turn } from "../src/core/types.ts";
import {
  HEALTH_DISCLAIMER,
  buildHealthBadge,
  buildHealthBreakdown,
  capIDs,
  missingHealth,
} from "../src/web/lib/health.ts";

const DISCLAIMER =
  "Derived signal from recorded observability data — not a quality judgment.";

function rule(overrides: Partial<HealthRuleResult> = {}): HealthRuleResult {
  return {
    id: "error-rate",
    label: "Error rate",
    triggered: false,
    level: null,
    evaluable: true,
    note: "2 error(s) across 40 step(s); rate 0.05",
    eventIDs: [],
    turnIDs: [],
    ...overrides,
  };
}

function health(overrides: Partial<SessionHealth> = {}): SessionHealth {
  return {
    state: "healthy",
    insufficient: false,
    insufficientReasons: [],
    rules: [rule()],
    triggeredCount: 0,
    ...overrides,
  };
}

function turn(id: string, index: number, triggerEventID: string | null, eventIDs: string[]): Turn {
  return {
    id,
    index,
    trigger: { kind: "user", eventID: triggerEventID, label: "User message" },
    startTime: 1,
    endTime: 2,
    status: "completed",
    steps: [],
    eventIDs,
    nonStepEventIDs: [],
    firstStepStart: null,
    lastStepEnd: null,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    tokensComplete: true,
    promptTokensLatest: { value: null, basis: "unavailable" },
    promptTokensCumulative: { value: null, basis: "unavailable" },
    cacheHitRate: { value: null, basis: "unavailable" },
    contextDelta: { value: null, basis: "unavailable" },
    cost: { value: null, basis: "unavailable" },
    modelTime: { value: null, basis: "unavailable" },
    toolTime: { value: null, basis: "unavailable" },
    totalTime: { value: null, basis: "unavailable" },
    residualTime: { value: null, basis: "unavailable" },
    outputSpeed: { value: null, basis: "unavailable" },
    uncertainty: [],
  };
}

const TURNS = [
  turn("trn_1", 1, "evt_turn_1", ["evt_step_1"]),
  turn("trn_2", 2, null, ["evt_step_2"]),
  turn("trn_3", 3, null, []),
];

function linkIDs(model: ReturnType<typeof buildHealthBreakdown>): string[] {
  return model.rules.flatMap((entry) => entry.links.map((link) => link.eventID));
}

/* ---------------------------------------------------------------------- badge */

test("health: the three states render distinct sentence-case words", () => {
  assert.equal(buildHealthBadge(health({ state: "healthy" })).word, "Healthy");
  assert.equal(buildHealthBadge(health({ state: "watch" })).word, "Watch");
  assert.equal(buildHealthBadge(health({ state: "degraded" })).word, "Degraded");
});

test("health: the badge is a real button state and both label fields carry the disclaimer", () => {
  const badge = buildHealthBadge(health());
  assert.ok(badge.ariaLabel.includes(DISCLAIMER));
  assert.ok(badge.title.includes(DISCLAIMER));
  assert.match(badge.ariaLabel, /Session health: Healthy\./);
  assert.equal(badge.insufficient, false);
  assert.equal(badge.subLabel, null);
});

test("health: insufficient data reads as Watch with the sub-label, never Healthy", () => {
  const badge = buildHealthBadge(
    health({ state: "watch", insufficient: true, insufficientReasons: ["no turns were recorded"] }),
  );
  assert.equal(badge.state, "watch");
  assert.equal(badge.word, "Watch");
  assert.equal(badge.insufficient, true);
  assert.equal(badge.subLabel, "insufficient data");
  assert.match(badge.ariaLabel, /— insufficient data/);
  assert.doesNotMatch(badge.word, /Healthy/);
});

test("health: an insufficient healthy payload is still presented as Watch", () => {
  const badge = buildHealthBadge(health({ state: "healthy", insufficient: true }));
  assert.equal(badge.word, "Watch");
});

test("health: a missing DTO renders the watch/insufficient shape", () => {
  const fallback = missingHealth();
  assert.equal(fallback.state, "watch");
  assert.equal(fallback.insufficient, true);
  assert.ok(fallback.insufficientReasons.length > 0);
  assert.deepEqual(fallback.rules, []);
  assert.equal(fallback.triggeredCount, 0);

  const badge = buildHealthBadge(null);
  assert.equal(badge.word, "Watch");
  assert.equal(badge.subLabel, "insufficient data");
  const breakdown = buildHealthBreakdown(null, []);
  assert.match(breakdown.reasons[0] ?? "", /session health was not evaluated/);
  assert.deepEqual(breakdown.rules, []);
});

/* ------------------------------------------------------------------ breakdown */

test("health: every rule keeps its label, level word, status and observed note", () => {
  const model = buildHealthBreakdown(
    health({
      state: "degraded",
      rules: [
        rule({ id: "error-rate", label: "Error rate", triggered: true, level: "strong", note: "7 error(s) across 20 step(s); rate 0.35" }),
        rule({ id: "retry-count", label: "Retry count", triggered: true, level: "watch", note: "8 retry event(s) recorded" }),
        rule({ id: "context-growth", label: "Context growth", note: "longest growth run 2 turn(s)" }),
        rule({ id: "cost-per-turn", label: "Cost per turn", evaluable: false, note: "cost was not recorded" }),
      ],
      triggeredCount: 2,
    }),
    TURNS,
  );
  assert.deepEqual(
    model.rules.map((entry) => entry.statusLabel),
    ["Triggered", "Triggered", "Not triggered", "Not evaluable"],
  );
  assert.deepEqual(
    model.rules.map((entry) => entry.levelLabel),
    ["Strong", "Watch", null, null],
  );
  assert.match(model.rules[0]?.note ?? "", /rate 0\.35/);
});

test("health: turn links use the trigger event, then the first turn event, and skip no-anchor turns", () => {
  const model = buildHealthBreakdown(
    health({
      rules: [rule({ id: "context-growth", label: "Context growth", triggered: true, level: "watch", turnIDs: ["trn_1", "trn_2", "trn_3"] })],
    }),
    TURNS,
  );
  assert.equal(MAX_TURN_LINKS, 6);
  assert.deepEqual(linkIDs(model), ["evt_turn_1", "evt_step_2"]);
  assert.deepEqual(
    model.rules[0]?.links.map((link) => link.label),
    ["Turn 1", "Turn 2"],
  );
});

test("health: event links keep the aria label and their recorded order", () => {
  const model = buildHealthBreakdown(
    health({ rules: [rule({ triggered: true, level: "watch", eventIDs: ["evt_1", "evt_2"] })] }),
    TURNS,
  );
  assert.deepEqual(linkIDs(model), ["evt_1", "evt_2"]);
  assert.equal(model.rules[0]?.links[0]?.ariaLabel, "Open event evt_1 in Trajectory");
});

test("health: event and turn links are capped at the core caps", () => {
  assert.equal(MAX_EVENT_LINKS, 10);
  const eventIDs = Array.from({ length: 15 }, (_, index) => `evt_${index + 1}`);
  const manyTurns = Array.from({ length: 8 }, (_, index) =>
    turn(`trn_${index + 1}`, index + 1, `evt_turn_${index + 1}`, []),
  );
  const model = buildHealthBreakdown(
    health({ rules: [rule({ eventIDs, turnIDs: manyTurns.map((entry) => entry.id) })] }),
    manyTurns,
  );
  const ids = linkIDs(model);
  assert.equal(ids.filter((id) => /^evt_\d+$/.test(id)).length, 10);
  assert.equal(ids.filter((id) => id.startsWith("evt_turn_")).length, 6);
  assert.equal(model.rules[0]?.links.length, 16);
});

test("health: capIDs de-duplicates and drops empty or foreign ids", () => {
  assert.deepEqual(capIDs(["a", "", "a", 3, null, "b"], 5), ["a", "b"]);
  assert.deepEqual(capIDs(["a", "b", "c"], 2), ["a", "b"]);
  assert.deepEqual(capIDs(undefined, 3), []);
});

test("health: insufficient reasons are listed before the rules", () => {
  const model = buildHealthBreakdown(
    health({
      state: "watch",
      insufficient: true,
      insufficientReasons: [
        "no turns were recorded",
        "the analysis covers a window, not the full session",
      ],
      rules: [rule()],
    }),
    TURNS,
  );
  assert.equal(model.insufficient, true);
  assert.deepEqual(model.reasons, [
    "no turns were recorded",
    "the analysis covers a window, not the full session",
  ]);
  assert.equal(model.disclaimer, HEALTH_DISCLAIMER);
});

test("health: the standing disclaimer is present and the word score never appears", () => {
  const model = buildHealthBreakdown(health({ state: "watch" }), TURNS);
  assert.equal(model.disclaimer, DISCLAIMER);
  assert.doesNotMatch(JSON.stringify(model), /score/i);
  assert.doesNotMatch(JSON.stringify(buildHealthBadge(health())), /score/i);
});

test("health: unknown states degrade to Watch instead of guessing a healthier one", () => {
  const badge = buildHealthBadge({ ...health(), state: "something-else" as SessionHealth["state"] });
  assert.equal(badge.state, "watch");
});
