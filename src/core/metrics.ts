import { EMPTY_TOKENS, metric } from "./types.ts";
import type { Basis, Metric, TokenUsage } from "./types.ts";

export interface TokenTotals {
  tokens: TokenUsage;
  complete: boolean;
  count: number;
  missing: number;
}

export function addTokens(total: TokenUsage, tokens: TokenUsage | null): TokenUsage {
  if (!tokens) return total;
  return {
    input: total.input + tokens.input,
    output: total.output + tokens.output,
    reasoning: total.reasoning + tokens.reasoning,
    cacheRead: total.cacheRead + tokens.cacheRead,
    cacheWrite: total.cacheWrite + tokens.cacheWrite,
  };
}

export function sumTokens(
  values: ReadonlyArray<TokenUsage | null | undefined>,
): TokenTotals {
  let tokens: TokenUsage = { ...EMPTY_TOKENS };
  let present = 0;
  for (const value of values) {
    if (value) {
      tokens = addTokens(tokens, value);
      present++;
    }
  }
  return {
    tokens,
    complete: present === values.length,
    count: present,
    missing: values.length - present,
  };
}

/**
 * Prompt size for one model call.
 *
 * OpenCode 2 normalizes provider usage so `input` excludes cache tokens;
 * cached prompt tokens live in `cache.read` / `cache.write`. The prompt is
 * therefore their sum. This is a derived metric.
 */
export function promptTokensMetric(tokens: TokenUsage | null): Metric {
  if (!tokens) {
    return metric(null, "unavailable", "token usage was not recorded");
  }
  return metric(
    tokens.input + tokens.cacheRead + tokens.cacheWrite,
    "derived",
    "input + cache read + cache write",
  );
}

export function promptTokens(tokens: TokenUsage | null): number | null {
  return promptTokensMetric(tokens).value;
}

/** `cache read / prompt tokens`, as a ratio in [0, 1]. */
export function cacheHitRateMetric(tokens: TokenUsage | null): Metric {
  if (!tokens) {
    return metric(null, "unavailable", "token usage was not recorded");
  }
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (prompt <= 0) {
    return metric(null, "unavailable", "prompt size is zero");
  }
  return metric(tokens.cacheRead / prompt, "derived", "cache read / prompt tokens");
}

export function weightedCacheHitRate(
  values: ReadonlyArray<TokenUsage | null | undefined>,
): Metric {
  let cacheRead = 0;
  let prompt = 0;
  let present = 0;
  for (const value of values) {
    if (!value) continue;
    present++;
    cacheRead += value.cacheRead;
    prompt += value.input + value.cacheRead + value.cacheWrite;
  }
  if (present === 0) {
    return metric(null, "unavailable", "no token usage recorded");
  }
  if (prompt <= 0) {
    return metric(null, "unavailable", "prompt size is zero");
  }
  return metric(cacheRead / prompt, "derived", "token-weighted cache read / prompt");
}

export interface DurationOptions {
  startUnknown?: boolean;
  incomplete?: boolean;
  note?: string;
}

/** Difference between two recorded timestamps. */
export function durationMetric(
  start: number | null,
  end: number | null,
  options: DurationOptions = {},
): Metric {
  if (options.startUnknown) {
    return metric(null, "unavailable", "start is outside the loaded window");
  }
  if (start === null || end === null) {
    return metric(null, "unavailable", options.note ?? "start or end timestamp missing");
  }
  if (end < start) {
    return metric(null, "unavailable", "end timestamp precedes start timestamp");
  }
  return metric(
    end - start,
    "derived",
    options.incomplete ? "incomplete step; end is the last recorded timestamp" : undefined,
  );
}

/**
 * Provider generation window: `time.created` -> `time.streamed`.
 *
 * `time.streamed` is documented as "when the provider response body ended,
 * before tool settlement". If it is absent, the only safe fallback (no tool
 * calls) is `completed`, marked estimated.
 */
export function modelTimeMetric(
  time: { created?: number | null; streamed?: number | null; completed?: number | null },
  toolCount: number,
  startUnknown = false,
): Metric {
  if (startUnknown) {
    return metric(null, "unavailable", "start is outside the loaded window");
  }
  const created = time.created ?? null;
  const streamed = time.streamed ?? null;
  if (created !== null && streamed !== null && streamed >= created) {
    return metric(streamed - created, "derived", "created -> streamed (model generation)");
  }
  if (created !== null && streamed === null && toolCount === 0 && time.completed != null) {
    return metric(
      time.completed - created,
      "estimated",
      "streamed timestamp missing; completed - created, no tool settlement",
    );
  }
  return metric(
    null,
    "unavailable",
    streamed === null
      ? "OpenCode did not record time.streamed for this step"
      : "inconsistent timestamps",
  );
}

export function toolDurationMetric(tool: {
  createdAt?: number | null;
  ranAt?: number | null;
  completedAt?: number | null;
  status?: string;
}): Metric {
  const end = tool.completedAt ?? null;
  if (end === null) {
    return metric(
      null,
      "unavailable",
      tool.status === "running" || tool.status === "streaming"
        ? "tool had not completed when the step was recorded"
        : "tool completion timestamp missing",
    );
  }
  const start = tool.ranAt ?? tool.createdAt ?? null;
  if (start === null) {
    return metric(null, "unavailable", "tool start timestamp missing");
  }
  return metric(
    Math.max(0, end - start),
    "derived",
    tool.ranAt == null ? "ran timestamp missing; created -> completed" : "ran -> completed",
  );
}

export function sumMetrics(
  values: ReadonlyArray<Metric>,
  note?: string,
): Metric {
  const available = values.filter((value) => value.value !== null);
  if (available.length === 0) {
    return metric(null, "unavailable", note ?? "no component was available");
  }
  const total = available.reduce((sum, value) => sum + (value.value ?? 0), 0);
  const estimated = available.some((value) => value.basis === "estimated");
  const partial = available.length !== values.length;
  const merged = [note, partial ? `${values.length - available.length} component(s) unavailable` : null]
    .filter(Boolean)
    .join("; ");
  return metric(
    total,
    estimated ? "estimated" : "derived",
    merged.length > 0 ? merged : undefined,
  );
}

export function differenceMetric(
  total: Metric,
  ...parts: Metric[]
): Metric {
  if (total.value === null) {
    return metric(null, "unavailable", "total duration is unavailable");
  }
  if (parts.some((part) => part.value === null)) {
    return metric(null, "unavailable", "a component duration is unavailable");
  }
  const value = total.value - parts.reduce((sum, part) => sum + (part.value ?? 0), 0);
  const estimated = total.basis === "estimated" || parts.some((part) => part.basis === "estimated");
  return metric(
    value,
    estimated ? "estimated" : "derived",
    value < 0 ? "negative residual: model and tool windows overlap" : "total - model - tool",
  );
}

export function outputSpeedMetric(outputTokens: number | null, modelTime: Metric): Metric {
  if (outputTokens === null) {
    return metric(null, "unavailable", "output token count missing");
  }
  if (modelTime.value === null || modelTime.value <= 0) {
    return metric(null, "unavailable", "model generation time is unavailable or zero");
  }
  return metric(
    outputTokens / (modelTime.value / 1000),
    modelTime.basis === "estimated" ? "estimated" : "derived",
    "output tokens / model generation seconds",
  );
}

export function contextDeltaMetric(current: Metric, previous: Metric | null): Metric {
  if (current.value === null) {
    return metric(null, "unavailable", "current context size is unavailable");
  }
  if (!previous) {
    return metric(null, "unavailable", "no previous turn");
  }
  if (previous.value === null) {
    return metric(null, "unavailable", "previous context size is unavailable");
  }
  return metric(
    current.value - previous.value,
    "derived",
    "final prompt size minus previous turn's final prompt size",
  );
}

export function basisOf(metricValue: Metric): Basis {
  return metricValue.basis;
}
