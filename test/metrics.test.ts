import test from "node:test";
import assert from "node:assert/strict";
import {
  cacheHitRateMetric,
  contextDeltaMetric,
  differenceMetric,
  durationMetric,
  modelTimeMetric,
  outputSpeedMetric,
  promptTokensMetric,
  sumMetrics,
  toolDurationMetric,
  weightedCacheHitRate,
} from "../src/core/metrics.ts";
import { metric } from "../src/core/types.ts";
import type { TokenUsage } from "../src/core/types.ts";

const tokens = (partial: Partial<TokenUsage> = {}): TokenUsage => ({
  input: 100,
  output: 20,
  reasoning: 5,
  cacheRead: 50,
  cacheWrite: 10,
  ...partial,
});

test("prompt tokens are input + cache read + cache write", () => {
  const value = promptTokensMetric(tokens());
  assert.equal(value.value, 160);
  assert.equal(value.basis, "derived");
  assert.match(value.note ?? "", /input \+ cache/);
});

test("prompt tokens are unavailable when usage is missing", () => {
  const value = promptTokensMetric(null);
  assert.equal(value.value, null);
  assert.equal(value.basis, "unavailable");
});

test("cache hit rate is token-weighted", () => {
  const one = cacheHitRateMetric(tokens());
  assert.equal(one.value, 50 / 160);
  assert.equal(one.basis, "derived");

  const weighted = weightedCacheHitRate([
    tokens({ input: 100, cacheRead: 50, cacheWrite: 0 }),
    tokens({ input: 100, cacheRead: 150, cacheWrite: 0 }),
  ]);
  assert.equal(weighted.value, 200 / 400);
});

test("cache hit rate is unavailable for a zero prompt", () => {
  const value = cacheHitRateMetric(tokens({ input: 0, cacheRead: 0, cacheWrite: 0 }));
  assert.equal(value.value, null);
  assert.equal(value.basis, "unavailable");
});

test("durations are derived from two recorded timestamps", () => {
  const value = durationMetric(1_000, 1_500);
  assert.equal(value.value, 500);
  assert.equal(value.basis, "derived");
  assert.equal(durationMetric(1_500, 1_000).value, null);
  assert.equal(durationMetric(null, 1_000).value, null);
  assert.equal(durationMetric(1_000, 1_500, { startUnknown: true }).value, null);
});

test("model time uses created -> streamed and falls back only without tools", () => {
  const exact = modelTimeMetric({ created: 1_000, streamed: 1_400, completed: 1_600 }, 1);
  assert.equal(exact.value, 400);
  assert.equal(exact.basis, "derived");

  const estimated = modelTimeMetric({ created: 1_000, streamed: null, completed: 1_600 }, 0);
  assert.equal(estimated.value, 600);
  assert.equal(estimated.basis, "estimated");

  const unavailable = modelTimeMetric({ created: 1_000, streamed: null, completed: 1_600 }, 2);
  assert.equal(unavailable.value, null);
  assert.equal(unavailable.basis, "unavailable");
});

test("tool duration prefers ran -> completed and flags a running tool", () => {
  const exact = toolDurationMetric({ createdAt: 1_000, ranAt: 1_100, completedAt: 1_300, status: "completed" });
  assert.equal(exact.value, 200);
  assert.equal(exact.basis, "derived");

  const fallback = toolDurationMetric({ createdAt: 1_000, ranAt: null, completedAt: 1_300, status: "completed" });
  assert.equal(fallback.value, 300);
  assert.match(fallback.note ?? "", /ran timestamp/);

  const running = toolDurationMetric({ createdAt: 1_000, ranAt: 1_100, completedAt: null, status: "running" });
  assert.equal(running.value, null);
  assert.equal(running.basis, "unavailable");
});

test("sums of metrics preserve partial and estimated status", () => {
  const full = sumMetrics([metric(10, "derived"), metric(20, "derived")]);
  assert.equal(full.value, 30);
  assert.equal(full.basis, "derived");

  const partial = sumMetrics([metric(10, "derived"), metric(null, "unavailable")]);
  assert.equal(partial.value, 10);
  assert.match(partial.note ?? "", /1 component/);

  const estimated = sumMetrics([metric(10, "estimated"), metric(20, "derived")]);
  assert.equal(estimated.value, 30);
  assert.equal(estimated.basis, "estimated");
});

test("residual is unavailable when a component is missing and notes overlap", () => {
  const value = differenceMetric(metric(1_000, "derived"), metric(600, "derived"), metric(700, "derived"));
  assert.equal(value.value, -300);
  assert.match(value.note ?? "", /overlap/);

  const missing = differenceMetric(metric(1_000, "derived"), metric(null, "unavailable"));
  assert.equal(missing.value, null);
});

test("output speed is output tokens per model second", () => {
  const value = outputSpeedMetric(100, metric(400, "derived"));
  assert.equal(value.value, 250);
  assert.equal(value.basis, "derived");
  assert.equal(outputSpeedMetric(100, metric(null, "unavailable")).value, null);
  assert.equal(outputSpeedMetric(100, metric(0, "derived")).value, null);
});

test("context delta compares the current and previous context", () => {
  const value = contextDeltaMetric(metric(1_500, "derived"), metric(1_000, "derived"));
  assert.equal(value.value, 500);
  assert.equal(contextDeltaMetric(metric(1_500, "derived"), null).value, null);
  assert.equal(contextDeltaMetric(metric(null, "unavailable"), metric(1_000, "derived")).value, null);
});
