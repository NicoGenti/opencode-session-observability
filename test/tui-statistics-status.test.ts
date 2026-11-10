import test from "node:test";
import assert from "node:assert/strict";

import type { StepStatus, TurnStatus } from "../src/core/types.ts";
import {
  statusLabel,
  statusMark,
  statusPaletteKey,
  statusSymbol,
  type StatusMark,
} from "../src/plugin/tui/statistics/status.ts";

const TURN_STATUSES: readonly TurnStatus[] = [
  "completed",
  "error",
  "interrupted",
  "running",
  "incomplete",
  "unknown",
];

test("every TurnStatus pins its symbol, label and palette key", () => {
  const expected: Record<TurnStatus, StatusMark> = {
    completed: { symbol: "OK", label: "Completed", paletteKey: "good" },
    error: { symbol: "ERR", label: "Error", paletteKey: "critical" },
    interrupted: { symbol: "INT", label: "Interrupted", paletteKey: "warning" },
    running: { symbol: "RUN", label: "Running", paletteKey: "accent" },
    incomplete: { symbol: "INC", label: "Incomplete", paletteKey: "warning" },
    unknown: { symbol: "?", label: "Unknown", paletteKey: "muted" },
  };
  for (const status of TURN_STATUSES) {
    assert.deepEqual(statusMark(status), expected[status], status);
    assert.equal(statusSymbol(status), expected[status].symbol, status);
    assert.equal(statusLabel(status), expected[status].label, status);
    assert.equal(statusPaletteKey(status), expected[status].paletteKey, status);
  }
});

test("StepStatus shares the exact same truth table", () => {
  const stepStatuses: readonly StepStatus[] = [
    "completed",
    "error",
    "interrupted",
    "running",
    "incomplete",
    "unknown",
  ];
  assert.deepEqual(stepStatuses, TURN_STATUSES);
  for (const status of stepStatuses) {
    assert.deepEqual(statusMark(status), statusMark(status as TurnStatus));
  }
});

test("status labels are passed through verbatim", () => {
  assert.equal(statusLabel("completed"), "Completed");
  assert.equal(statusLabel("error"), "Error");
  assert.equal(statusLabel("interrupted"), "Interrupted");
  assert.equal(statusLabel("running"), "Running");
  assert.equal(statusLabel("incomplete"), "Incomplete");
  assert.equal(statusLabel("unknown"), "Unknown");
});

test("an unknown value falls back to the muted question mark", () => {
  const bogus = "exploded" as unknown as TurnStatus;
  assert.deepEqual(statusMark(bogus), statusMark("unknown"));
  assert.equal(statusSymbol(bogus), "?");
  assert.equal(statusLabel(bogus), "Unknown");
  assert.equal(statusPaletteKey(bogus), "muted");
});

test("status palette keys stay inside the themePalette vocabulary", () => {
  const allowed = new Set(["good", "warning", "critical", "accent", "muted"]);
  for (const status of TURN_STATUSES) {
    assert.equal(allowed.has(statusPaletteKey(status)), true, status);
  }
});
