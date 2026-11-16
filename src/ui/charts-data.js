/**
 * Chart data preparation for the web Statistics "Charts" sub-tab.
 *
 * Pure ESM with no DOM access and no dependency outside `./format.js`, so the
 * builders run both in the browser (static modules, no build step) and under
 * `node:test`. Every builder projects an already-loaded `Analysis`; nothing is
 * fetched, paged, or invented. A missing metric keeps `value: null` with
 * `available: false`, and drill anchors are only the event IDs the analysis
 * actually records.
 *
 * Points carry `turnIndex` (`Turn.index`, the 1-based Statistics row number)
 * so the series and the compaction markers share one x axis.
 */

import { turnModelParts } from "./format.js";

const EMPTY_TURNS_REASON = "no turns in this analysis";
const EMPTY_STEPS_REASON = "no steps recorded in this analysis";

/** A finite number, or null for anything else (never zero-filled). */
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize a `Metric` into the chart datum shape.
 * `available` is false for every non-finite value, so callers never zero-fill.
 */
export function metricPoint(metric) {
  const value = finiteOrNull(metric?.value);
  return {
    value,
    basis: value === null ? "unavailable" : (metric?.basis ?? "unavailable"),
    available: value !== null,
  };
}

/** Turn drill anchor: the trigger event, then any turn event, else null. */
export function turnAnchor(turn) {
  return turn?.trigger?.eventID ?? turn?.eventIDs?.[0] ?? null;
}

/** Step drill anchor: the step's first event, else null. */
export function stepAnchor(step) {
  return step?.eventIDs?.[0] ?? null;
}

/**
 * Index of the turn a compaction belongs to, or null when it cannot be placed.
 *
 * A recorded `turnID` is authoritative: an id that does not resolve (for
 * example a turn outside the loaded window) is unplaceable, never re-derived
 * from timestamps. Only a compaction without a turn id falls back to the last
 * turn starting at or before its timestamp. Anything else is unplaceable.
 */
function compactionTurnIndex(turns, compaction) {
  if (compaction.turnID !== null && compaction.turnID !== undefined) {
    const match = turns.find((turn) => turn.id === compaction.turnID);
    return match ? match.index : null;
  }
  const timestamp = finiteOrNull(compaction.timestamp);
  if (timestamp === null) return null;
  let placed = null;
  for (const turn of turns) {
    const startTime = finiteOrNull(turn.startTime);
    if (startTime !== null && startTime <= timestamp) placed = turn.index;
  }
  return placed;
}

/**
 * Context growth per turn, with compaction markers.
 *
 * `basis` follows the `contextCell` semantics: anything other than
 * `"cumulative"` reads `promptTokensLatest`. A null metric (including the
 * first turn's context delta) becomes an unavailable point so the renderer can
 * gap the polyline instead of dipping to zero.
 *
 * Markers are placed compactions only: `{eventID, turnIndex, removedTokens,
 * label}` where `removedTokens` is a metric point. Compactions with no
 * resolvable position are counted in `unplaced` and never synthesized onto a
 * turn.
 */
export function buildContextGrowthSeries(analysis, basis) {
  const resolvedBasis = basis === "cumulative" ? "cumulative" : "latest";
  const turns = analysis?.turns ?? [];
  const markers = [];
  let unplaced = 0;
  let unavailableCount = 0;

  const points = turns.map((turn) => {
    const metric =
      resolvedBasis === "cumulative" ? turn.promptTokensCumulative : turn.promptTokensLatest;
    const point = metricPoint(metric);
    if (!point.available) unavailableCount += 1;
    return {
      turnIndex: turn.index,
      anchor: turnAnchor(turn),
      ...point,
    };
  });

  (analysis?.compactions ?? []).forEach((compaction, index) => {
    const turnIndex = compactionTurnIndex(turns, compaction);
    if (turnIndex === null) {
      unplaced += 1;
      return;
    }
    markers.push({
      eventID: compaction.eventID,
      turnIndex,
      removedTokens: metricPoint(compaction.removedTokens),
      label: `Compaction ${index + 1}`,
    });
  });

  if (turns.length === 0) {
    return {
      basis: resolvedBasis,
      empty: true,
      reason: EMPTY_TURNS_REASON,
      points,
      markers,
      unplaced,
      unavailableCount,
    };
  }
  return {
    basis: resolvedBasis,
    empty: false,
    points,
    markers,
    unplaced,
    unavailableCount,
  };
}

/**
 * Five-segment token stack per turn.
 *
 * Segment values are the recorded subset from `Turn.tokens`, never padded.
 * A point is `"measured"` only when every step recorded usage
 * (`tokensComplete === true` and at least one step carries `tokens`);
 * otherwise its `basis` is `"unavailable"`, so the renderer never dresses an
 * empty or incomplete record as measured. `partial` marks an incomplete but
 * partly recorded stack; a turn that recorded no step usage at all is
 * unavailable rather than partial.
 */
export function buildTokenSeries(analysis) {
  const turns = analysis?.turns ?? [];
  let partialCount = 0;

  const points = turns.map((turn) => {
    const tokens = turn.tokens;
    const recorded = (turn.steps ?? []).some(
      (step) => step.tokens !== null && step.tokens !== undefined,
    );
    const partial = turn.tokensComplete === false && recorded;
    if (partial) partialCount += 1;
    return {
      turnIndex: turn.index,
      anchor: turnAnchor(turn),
      input: finiteOrNull(tokens?.input) ?? 0,
      cacheRead: finiteOrNull(tokens?.cacheRead) ?? 0,
      cacheWrite: finiteOrNull(tokens?.cacheWrite) ?? 0,
      reasoning: finiteOrNull(tokens?.reasoning) ?? 0,
      output: finiteOrNull(tokens?.output) ?? 0,
      partial,
      basis: turn.tokensComplete === true && recorded ? "measured" : "unavailable",
    };
  });

  if (turns.length === 0) {
    return { empty: true, reason: EMPTY_TURNS_REASON, points, partialCount };
  }
  return { empty: false, points, partialCount };
}

/** The last step that recorded a model, i.e. the step attribution comes from. */
function lastModelStep(turn) {
  for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
    const step = turn.steps[index];
    if (step.model) return step;
  }
  return null;
}

/**
 * Cost per turn, grouped by model.
 *
 * The model comes from `turnModelParts` semantics (the last step with a model),
 * so `modelKey` and `modelLabel` are that same canonical `provider/id#variant`
 * label of the derived model ("—" when no step recorded one). The provider is
 * only reported when the attributing step recorded it — there is no
 * model-to-provider inference.
 *
 * `max` is the highest available cost with every tied turn index, so the
 * renderer can mark ties. Ties are reported only above zero: an all-zero cost
 * session marks nothing, because every turn tying at 0 would be noise. `value`
 * is null when no turn recorded a cost.
 */
export function buildCostSeries(analysis) {
  const turns = analysis?.turns ?? [];
  const models = [];
  const seenModels = new Set();
  let unavailableCount = 0;

  const points = turns.map((turn) => {
    const parts = turnModelParts(turn);
    const modelStep = lastModelStep(turn);
    const cost = metricPoint(turn.cost);
    if (!cost.available) unavailableCount += 1;
    if (!seenModels.has(parts.label)) {
      seenModels.add(parts.label);
      models.push({ key: parts.label, label: parts.label });
    }
    return {
      turnIndex: turn.index,
      anchor: turnAnchor(turn),
      cost,
      modelKey: parts.label,
      modelLabel: parts.label,
      providerLabel: modelStep?.provider ?? null,
    };
  });

  let maxValue = null;
  for (const point of points) {
    if (!point.cost.available) continue;
    if (maxValue === null || point.cost.value > maxValue) maxValue = point.cost.value;
  }
  const max = {
    value: maxValue,
    turnIndices: !(maxValue > 0)
      ? []
      : points
          .filter((point) => point.cost.available && point.cost.value === maxValue)
          .map((point) => point.turnIndex),
  };

  if (turns.length === 0) {
    return {
      empty: true,
      reason: EMPTY_TURNS_REASON,
      points,
      models,
      max,
      unavailableCount,
    };
  }
  return { empty: false, points, models, max, unavailableCount };
}

const DURATION_SEGMENTS = ["modelTime", "toolTime", "residualTime"];

/**
 * Per-step duration breakdown across turns.
 *
 * Each segment key is present only when that metric is available, so a partial
 * step draws a shorter stack rather than a zero-length one. A step with all
 * three segments unavailable keeps `available: false` and no segment keys.
 */
export function buildDurationSeries(analysis) {
  const turns = analysis?.turns ?? [];
  const points = [];
  let unavailableCount = 0;

  for (const turn of turns) {
    for (const step of turn.steps ?? []) {
      const point = {
        label: `${turn.index}.${step.index}`,
        turnIndex: turn.index,
        stepIndex: step.index,
        anchor: stepAnchor(step),
        available: false,
      };
      for (const key of DURATION_SEGMENTS) {
        const segment = metricPoint(step[key]);
        if (!segment.available) continue;
        point[key] = segment;
        point.available = true;
      }
      if (!point.available) unavailableCount += 1;
      points.push(point);
    }
  }

  if (points.length === 0) {
    return {
      empty: true,
      reason: turns.length === 0 ? EMPTY_TURNS_REASON : EMPTY_STEPS_REASON,
      points,
      unavailableCount,
    };
  }
  return { empty: false, points, unavailableCount };
}

/**
 * Caption naming the analysis scope and its sequence window, e.g.
 * "Session total — seq 1–42" or, for a partial window,
 * "Window total — seq 50–60 of 1–100".
 */
export function chartWindowCaption(analysis) {
  const scope = analysis?.totals?.scope === "window" ? "Window total" : "Session total";
  const coverage = analysis?.coverage;
  if (!coverage) return scope;
  const fromSeq = finiteOrNull(coverage.fromSeq);
  const toSeq = finiteOrNull(coverage.toSeq);
  if (fromSeq === null || toSeq === null) return scope;
  const range = fromSeq === toSeq ? `seq ${fromSeq}` : `seq ${fromSeq}–${toSeq}`;
  const minSeq = finiteOrNull(coverage.minSeq);
  const maxSeq = finiteOrNull(coverage.maxSeq);
  if (coverage.complete === false && minSeq !== null && maxSeq !== null) {
    return `${scope} — ${range} of ${minSeq}–${maxSeq}`;
  }
  return `${scope} — ${range}`;
}
