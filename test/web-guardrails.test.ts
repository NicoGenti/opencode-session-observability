import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GUARDRAILS,
  type GuardrailWarning,
  type Guardrails,
} from "../src/core/guardrails.ts";
import { MAX_EVENT_LINKS, MAX_TURN_LINKS } from "../src/core/health.ts";
import type { Turn } from "../src/core/types.ts";
import {
  GUARDRAIL_ADVISORY_COPY,
  MAX_EVENT_LINKS as UI_MAX_EVENT_LINKS,
  MAX_TURN_LINKS as UI_MAX_TURN_LINKS,
  buildGuardrails,
  formatBudget,
} from "../src/web/lib/guardrails-ui.ts";
import * as settings from "../src/web/lib/settings.ts";

function warning(overrides: Partial<GuardrailWarning> = {}): GuardrailWarning {
  return {
    id: "tokens-total",
    label: "Token budget",
    observed: "2,400,000 tokens recorded",
    threshold: 2_000_000,
    basis: "derived",
    advisory: true,
    eventIDs: ["evt-1"],
    turnIDs: ["turn-1"],
    ...overrides,
  };
}

function guardrails(overrides: Partial<Guardrails> = {}): Guardrails {
  return { warnings: [warning()], skipped: [], ...overrides };
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
  turn("turn-1", 1, "evt-turn-1", ["evt-step-1"]),
  turn("turn-2", 2, null, ["evt-step-2"]),
  turn("turn-3", 3, null, []),
];

function linkIDs(model: ReturnType<typeof buildGuardrails>): string[] {
  return model.rows.flatMap((row) => row.links.map((link) => link.eventID));
}

test("guardrails: rows keep the label, the derived basis and the advisory framing", () => {
  const model = buildGuardrails(guardrails(), TURNS);
  assert.equal(model.empty, false);
  const row = model.rows[0]!;
  assert.equal(row.label, "Token budget");
  assert.equal(row.basisLabel, "derived");
  assert.equal(row.advisoryLabel, "advisory");
  assert.equal(row.observed, "2,400,000 tokens recorded");
  assert.match(row.note, /budget 2,000,000$/);
  assert.equal(model.advisoryCopy, GUARDRAIL_ADVISORY_COPY);
  assert.equal(GUARDRAIL_ADVISORY_COPY, "advisory — never blocks anything");
  assert.equal(model.countLabel, "1 advisory");
});

test("guardrails: a skipped budget is reported instead of guessed", () => {
  const model = buildGuardrails(
    guardrails({
      warnings: [],
      skipped: [
        { id: "elapsed-minutes", label: "Elapsed-time budget", note: "the analysis covers a window" },
        { id: "cost-total", label: "Cost budget", note: "cost was not recorded" },
      ],
    }),
    TURNS,
  );
  assert.equal(model.empty, false);
  assert.equal(model.rows.length, 0);
  assert.equal(model.count, 0);
  assert.equal(
    model.skippedNote,
    "Not evaluated — Elapsed-time budget: the analysis covers a window · Cost budget: cost was not recorded",
  );
});

test("guardrails: an absent, empty or malformed sibling renders nothing", () => {
  assert.equal(buildGuardrails(null, TURNS).empty, true);
  assert.equal(buildGuardrails({ warnings: [], skipped: [] }, TURNS).empty, true);
  assert.equal(buildGuardrails(undefined, TURNS).empty, true);
  const malformed = buildGuardrails(
    { warnings: [warning({ label: "", observed: "" })], skipped: [] },
    TURNS,
  );
  assert.equal(malformed.empty, true);
});

test("guardrails: event links keep the aria label and are capped at the health caps", () => {
  assert.equal(UI_MAX_EVENT_LINKS, MAX_EVENT_LINKS);
  assert.equal(UI_MAX_TURN_LINKS, MAX_TURN_LINKS);
  const eventIDs = Array.from({ length: 16 }, (_, index) => `evt-${index + 1}`);
  const model = buildGuardrails(guardrails({ warnings: [warning({ eventIDs, turnIDs: [] })] }), TURNS);
  assert.equal(model.rows[0]?.links.length, 10);
  assert.equal(model.rows[0]?.links[0]?.ariaLabel, "Open event 1 of Token budget in Trajectory");
});

test("guardrails: turn anchors follow the health order and skip unresolvable turns", () => {
  const model = buildGuardrails(
    guardrails({ warnings: [warning({ eventIDs: [], turnIDs: ["turn-1", "turn-2", "turn-3"] })] }),
    TURNS,
  );
  assert.deepEqual(linkIDs(model), ["evt-turn-1", "evt-step-2"]);
  assert.deepEqual(
    model.rows[0]?.links.map((link) => link.label),
    ["Turn 1", "Turn 2"],
  );
});

test("guardrails: a fractional budget keeps its decimals instead of rounding up", () => {
  assert.equal(formatBudget(12.75), "12.75");
  assert.equal(formatBudget(0.5), "0.5");
  const model = buildGuardrails(
    guardrails({ warnings: [warning({ id: "cost-total", label: "Cost budget", threshold: 12.75 })] }),
    TURNS,
  );
  assert.match(model.rows[0]?.note ?? "", /budget 12\.75$/);
});

test("guardrails: an unknown threshold is reported as unavailable, never as zero", () => {
  const model = buildGuardrails(
    guardrails({ warnings: [warning({ threshold: Number.NaN })] }),
    TURNS,
  );
  assert.match(model.rows[0]?.note ?? "", /budget —$/);
});

test("guardrails: the analysis params carry exactly the six budgets in fixed order", () => {
  const params = settings.guardrailParams();
  assert.deepEqual(Object.keys(params), [
    "gr.tokensTotal",
    "gr.costTotal",
    "gr.contextRun",
    "gr.retries",
    "gr.toolFailures",
    "gr.elapsedMinutes",
  ]);
  assert.equal(params["gr.tokensTotal"], String(DEFAULT_GUARDRAILS.tokensTotal));
  assert.equal(params["gr.elapsedMinutes"], String(DEFAULT_GUARDRAILS.elapsedMinutes));
  assert.equal(Object.keys(params).length, 6);
});

test("guardrails: a stored budget travels as its gr.* parameter in the same order", () => {
  const values = { ...DEFAULT_GUARDRAILS, costTotal: 12.75, retries: 3 };
  const params = settings.guardrailParams(values);
  assert.equal(params["gr.costTotal"], "12.75");
  assert.equal(params["gr.retries"], "3");
  assert.deepEqual(Object.keys(params), [
    "gr.tokensTotal",
    "gr.costTotal",
    "gr.contextRun",
    "gr.retries",
    "gr.toolFailures",
    "gr.elapsedMinutes",
  ]);
});

test("guardrails: identical input renders an identical model", () => {
  const first = buildGuardrails(guardrails(), TURNS);
  const second = buildGuardrails(guardrails(), TURNS);
  assert.deepEqual(first, second);
});
