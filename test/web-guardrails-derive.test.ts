import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GUARDRAILS,
  GUARDRAIL_FIELDS as CORE_FIELDS,
  GUARDRAIL_MAX as CORE_MAX,
  type GuardrailThresholds,
} from "../src/core/guardrails.ts";
import * as settings from "../src/web/lib/settings.ts";

const STORAGE_KEY = "observability-guardrails";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

const storage = memoryStorage();
Object.assign(globalThis, {
  localStorage: storage,
  document: {
    documentElement: { dataset: {}, style: undefined },
    body: { dataset: {} },
  },
});

test.beforeEach(() => {
  settings.reset();
});

test("the UI derives the budget vocabulary from core, with no local mirror", () => {
  // Identity, not a deep-equal copy: the mirror is gone at the source.
  assert.equal(settings.GUARDRAIL_FIELDS, CORE_FIELDS);
  assert.equal(settings.GUARDRAIL_DEFAULTS, DEFAULT_GUARDRAILS);
  assert.equal(settings.GUARDRAIL_MAX, CORE_MAX);

  assert.ok(Object.isFrozen(CORE_FIELDS));
  assert.ok(Object.isFrozen(DEFAULT_GUARDRAILS));
  assert.ok(Object.isFrozen(CORE_MAX));
  for (const field of CORE_FIELDS) assert.ok(Object.isFrozen(field), field.key);
});

test("every field matches the core defaults and bounds field for field", () => {
  const keys = Object.keys(DEFAULT_GUARDRAILS) as Array<keyof GuardrailThresholds>;
  assert.deepEqual(
    CORE_FIELDS.map((field) => field.key),
    keys,
  );
  assert.equal(CORE_FIELDS.length, 6);

  const labels: Record<string, string> = {
    tokensTotal: "Total tokens",
    costTotal: "Total cost (USD)",
    contextRun: "Context growth run (turns)",
    retries: "Retry events",
    toolFailures: "Tool-failure incidents",
    elapsedMinutes: "Elapsed time (minutes)",
  };
  const steps: Record<string, number> = {
    tokensTotal: 1_000,
    costTotal: 0.5,
    contextRun: 1,
    retries: 1,
    toolFailures: 1,
    elapsedMinutes: 5,
  };
  const integer: Record<string, boolean> = {
    tokensTotal: true,
    costTotal: false,
    contextRun: true,
    retries: true,
    toolFailures: true,
    elapsedMinutes: false,
  };

  for (const field of CORE_FIELDS) {
    assert.equal(field.min, 0, field.key);
    assert.equal(field.max, CORE_MAX[field.key], field.key);
    assert.ok(
      DEFAULT_GUARDRAILS[field.key] >= field.min &&
        DEFAULT_GUARDRAILS[field.key] <= field.max,
      `${field.key} default sits inside its bounds`,
    );
    assert.equal(field.label, labels[field.key], field.key);
    assert.equal(field.step, steps[field.key], field.key);
    assert.equal(field.integer, integer[field.key], field.key);
    assert.ok(field.max > 0, field.key);
    assert.ok(field.step > 0, field.key);
  }
});

test("guardrail budgets round-trip through the per-browser store", () => {
  assert.deepEqual(settings.getGuardrails(), { ...DEFAULT_GUARDRAILS });

  const saved = settings.setGuardrail("costTotal", "12");
  assert.deepEqual(saved, { ok: true, value: 12 });
  assert.equal(settings.getGuardrails().costTotal, 12);
  // Persisted for later reloads, not only held in memory.
  assert.equal(
    JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}").costTotal,
    12,
  );

  const restored = settings.resetGuardrails();
  assert.deepEqual(restored, { ...DEFAULT_GUARDRAILS });
  assert.equal(settings.getGuardrails().costTotal, 5);
});

test("invalid budgets are rejected with a message and never stored", () => {
  const before = settings.getGuardrails();
  const rejected: Array<[string, unknown]> = [
    ["retries", -1],
    ["costTotal", "abc"],
    ["contextRun", Number.NaN],
    ["elapsedMinutes", CORE_MAX.elapsedMinutes + 1],
    ["tokensTotal", Number.POSITIVE_INFINITY],
    // An emptied field must never read as a budget of 0.
    ["costTotal", ""],
    ["retries", "  "],
    ["tokensTotal", null],
    ["toolFailures", []],
    ["toolFailures", true],
  ];
  for (const [key, value] of rejected) {
    const result = settings.setGuardrail(key, value);
    if (result.ok) assert.fail(`${key}=${String(value)} should be rejected`);
    assert.match(result.message, /must be a number between/);
  }
  const unknown = settings.setGuardrail("unknownBudget", 1);
  if (unknown.ok) assert.fail("an unknown budget must be rejected");
  assert.match(unknown.message, /Unknown guardrail budget/);

  assert.deepEqual(settings.getGuardrails(), before);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("an emptied settings field normalizes to reject, not to zero", () => {
  for (const key of ["costTotal", "retries", "tokensTotal", "elapsedMinutes"]) {
    assert.equal(settings.normalizeGuardrailValue(key, ""), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, "   "), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, null), null, key);
  }
  // Explicit zero is still a legitimate budget.
  assert.equal(settings.normalizeGuardrailValue("costTotal", 0), 0);
  assert.equal(settings.normalizeGuardrailValue("retries", "0"), 0);
});

test("count budgets are whole numbers, cost and minutes stay fractional", () => {
  for (const key of ["tokensTotal", "contextRun", "retries", "toolFailures"]) {
    assert.equal(settings.normalizeGuardrailValue(key, 1.5), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, "2.25"), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, 3), 3, key);
    assert.equal(settings.normalizeGuardrailValue(key, "3"), 3, key);
  }
  assert.equal(settings.normalizeGuardrailValue("costTotal", 12.75), 12.75);
  assert.equal(settings.normalizeGuardrailValue("elapsedMinutes", 2.5), 2.5);
});

test("a hand-edited stored value degrades to the default", () => {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ costTotal: -4, retries: "many", tokensTotal: 7 }),
  );
  const values = settings.getGuardrails();
  assert.equal(values.costTotal, DEFAULT_GUARDRAILS.costTotal);
  assert.equal(values.retries, DEFAULT_GUARDRAILS.retries);
  assert.equal(values.tokensTotal, 7);
});

test("the analysis params carry exactly the six budgets in a fixed order", () => {
  const params = settings.guardrailParams();
  assert.deepEqual(Object.keys(params), [
    "gr.tokensTotal",
    "gr.costTotal",
    "gr.contextRun",
    "gr.retries",
    "gr.toolFailures",
    "gr.elapsedMinutes",
  ]);
  assert.equal(params["gr.tokensTotal"], "2000000");
  assert.equal(params["gr.elapsedMinutes"], "60");

  settings.setGuardrail("costTotal", 12);
  assert.equal(settings.guardrailParams()["gr.costTotal"], "12");

  // A malformed value falls back instead of being dropped or forwarded.
  const fallback = settings.guardrailParams({
    ...DEFAULT_GUARDRAILS,
    retries: Number.NaN,
  });
  assert.equal(fallback["gr.retries"], "10");
  assert.equal(Object.keys(fallback).length, 6);
});

test("the documented bounds are inclusive", () => {
  assert.equal(
    settings.normalizeGuardrailValue("elapsedMinutes", CORE_MAX.elapsedMinutes),
    CORE_MAX.elapsedMinutes,
  );
  assert.equal(
    settings.normalizeGuardrailValue("elapsedMinutes", CORE_MAX.elapsedMinutes + 1),
    null,
  );
  assert.equal(settings.normalizeGuardrailValue("retries", 0), 0);
  assert.equal(settings.normalizeGuardrailValue("retries", -0.001), null);
});
