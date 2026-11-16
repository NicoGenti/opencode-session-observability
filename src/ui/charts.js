/**
 * DOM-free SVG string builders for the Statistics "Charts" sub-tab.
 *
 * Pure ESM: no DOM globals, no `src/core` or `src/server` imports, and the only
 * dependencies are the pure formatters in `./format.js`. Each chart function
 * consumes a series produced by `./charts-data.js` and returns a complete HTML
 * fragment (scroll container, SVG, legend, notes, and a `<details>` data list of
 * real buttons). `chartSectionHtml` wraps that fragment with its heading and
 * caption; the caller owns the analysis scope wording.
 *
 * Colour never carries meaning alone: every datum carries a `<title>` and an
 * `aria-label` with its value and M/D/E/— basis mark, the legends are text
 * rows, and the "Chart data" list is the keyboard path. Drill attributes
 * (`data-event-id`, `data-jump-step`) are emitted only when the datum has a real
 * anchor; otherwise the label says "no event to open".
 *
 * SVG paint uses inline `style="fill: var(--token)"` because `var()` is not
 * valid in SVG presentation attributes. The UI ships `style-src 'unsafe-inline'`
 * for exactly this kind of generated style, and no hex literal is emitted.
 */

import {
  basisMark,
  escapeAttr,
  escapeHtml,
  formatCompact,
  formatCost,
  formatDuration,
  formatNumber,
} from "./format.js";

export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 220;

const PAD = { left: 56, right: 16, top: 16, bottom: 30 };
const GRID_ROWS = 4;

const TOKEN_SEGMENTS = [
  { key: "input", label: "Input", token: "var(--accent)" },
  { key: "cacheRead", label: "Cache read", token: "var(--good)" },
  { key: "cacheWrite", label: "Cache write", token: "var(--warning)" },
  { key: "reasoning", label: "Reasoning", token: "var(--serious)" },
  { key: "output", label: "Output", token: "var(--muted)" },
];

const DURATION_SEGMENTS = [
  { key: "modelTime", label: "Model time", token: "var(--accent)" },
  { key: "toolTime", label: "Tool time", token: "var(--good)" },
  { key: "residualTime", label: "Residual time", token: "var(--muted)" },
];

/** Categorical fills for the cost chart's per-model grouping (tokens only). */
const MODEL_COLORS = [
  "var(--accent)",
  "var(--good)",
  "var(--serious)",
  "var(--warning)",
  "var(--critical)",
  "var(--muted)",
];

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function sentence(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "No chart data.";
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function noteHtml(sentences) {
  if (sentences.length === 0) return "";
  return `<p class="chart-note">${sentences.map(sentence).map(escapeHtml).join(" ")}</p>`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function plotHeight(height) {
  return height - PAD.top - PAD.bottom;
}

function baselineY(height) {
  return height - PAD.bottom;
}

function slotX(index, count, width) {
  const plotWidth = width - PAD.left - PAD.right;
  const step = count > 0 ? plotWidth / count : plotWidth;
  return { x: PAD.left + step * index + step / 2, step };
}

function barWidth(step) {
  return Math.max(4, Math.min(34, step * 0.55));
}

function barHeight(value, max, height) {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.max(2, (value / max) * plotHeight(height));
}

function valueY(value, max, height) {
  const scaleMax = max > 0 ? max : 1;
  return baselineY(height) - (value / scaleMax) * plotHeight(height);
}

function labelEvery(count, maxLabels = 24) {
  return Math.max(1, Math.ceil(count / maxLabels));
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

/** Open an SVG chart with `role="img"` and a chart-level `aria-label`. */
export function svgOpen({ label, width = CHART_WIDTH, height = CHART_HEIGHT }) {
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(
    label,
  )}" focusable="false" xmlns="http://www.w3.org/2000/svg">`;
}

export function svgClose() {
  return "</svg>";
}

/** Horizontal gridlines plus the plot frame edge, drawn in `var(--grid)`. */
export function gridLines({
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
  top = PAD.top,
  bottom = PAD.bottom,
  left = PAD.left,
  right = PAD.right,
  rows = GRID_ROWS,
} = {}) {
  const plot = height - top - bottom;
  const x1 = left;
  const x2 = width - right;
  const lines = [];
  for (let row = 0; row <= rows; row += 1) {
    const y = top + (plot * row) / rows;
    lines.push(
      `<line class="chart-grid" x1="${x1}" y1="${y.toFixed(2)}" x2="${x2}" y2="${y.toFixed(
        2,
      )}" stroke-width="1" style="stroke: var(--grid)" />`,
    );
  }
  return lines.join("");
}

/** Y-axis value labels aligned to the gridlines; a null max labels the baseline only. */
export function axisLabels({
  max,
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
  top = PAD.top,
  bottom = PAD.bottom,
  left = PAD.left,
  rows = GRID_ROWS,
  format = formatCompact,
} = {}) {
  const plot = height - top - bottom;
  const baseline = height - bottom;
  if (!(max > 0)) {
    return axisLabel(format(0), left - 8, baseline + 3);
  }
  const labels = [];
  for (let row = 0; row <= rows; row += 1) {
    const value = (max * (rows - row)) / rows;
    const y = top + (plot * row) / rows;
    labels.push(axisLabel(format(value), left - 8, y + 3));
  }
  return labels.join("");
}

function axisLabel(text, x, y) {
  return `<text class="chart-axis-label" x="${x}" y="${y.toFixed(
    2,
  )}" text-anchor="end" style="fill: var(--muted)">${escapeHtml(text)}</text>`;
}

/**
 * Draw a polyline for each contiguous run of available points, never one line
 * across a gap. A lone available point between gaps is left to its own datum
 * marker, so single-point runs emit nothing.
 */
export function polylineRuns(points, options = {}) {
  const {
    width = CHART_WIDTH,
    height = CHART_HEIGHT,
    max = 0,
  } = options;
  const runs = [];
  let current = [];
  points.forEach((point, index) => {
    if (!point?.available) {
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    const { x } = slotX(index, points.length, width);
    current.push(`${x.toFixed(2)},${valueY(point.value, max, height).toFixed(2)}`);
  });
  if (current.length > 0) runs.push(current);
  return runs
    .filter((run) => run.length >= 2)
    .map(
      (run) =>
        `<polyline class="chart-line" points="${run.join(
          " ",
        )}" fill="none" stroke-width="2" stroke-linejoin="round" style="fill: none; stroke: var(--accent)" />`,
    )
    .join("");
}

/**
 * One SVG datum: `<title>` + `aria-label` always, drill attribute only with a
 * real anchor, and a pointer-cursor class only when it can be opened.
 */
function datum(
  tag,
  { className = "chart-datum", aria, anchor = null, kind = "event", attrs = "", style = "", children = "" },
) {
  const dataAttr = anchor
    ? kind === "step"
      ? ` data-jump-step="${escapeAttr(anchor)}"`
      : ` data-event-id="${escapeAttr(anchor)}"`
    : "";
  const label = anchor ? aria : `${aria}, no event to open`;
  const classes = anchor ? `${className} chart-datum-link` : className;
  const styleAttr = style ? ` style="${style}"` : "";
  return `<${tag} class="${classes}" aria-label="${escapeAttr(label)}"${dataAttr}${attrs}${styleAttr}><title>${escapeHtml(
    label,
  )}</title>${children}</${tag}>`;
}

/** Dashed `--border-strong` slot with sentence-case text for an unrecorded datum. */
function notRecordedSlot({ x, width, height, aria, anchor = null, kind = "event" }) {
  const top = PAD.top;
  const bottom = baselineY(height);
  const centre = (top + bottom) / 2;
  const label = "Not recorded";
  return datum("g", {
    className: "chart-unavailable",
    aria,
    anchor,
    kind,
    children: `<rect x="${(x - width / 2).toFixed(2)}" y="${top}" width="${width.toFixed(
      2,
    )}" height="${(bottom - top).toFixed(
      2,
    )}" rx="3" fill="none" stroke-dasharray="3 3" style="fill: none; stroke: var(--border-strong)" /><text x="${x.toFixed(
      2,
    )}" y="${centre.toFixed(2)}" text-anchor="middle" transform="rotate(-90 ${x.toFixed(
      2,
    )} ${centre.toFixed(2)})" class="chart-unavailable-label" style="fill: var(--muted)">${label}</text>`,
  });
}

function legendItem(label, swatchStyle) {
  return `<span class="chart-legend-item"><span class="chart-swatch" style="${swatchStyle}"></span>${escapeHtml(
    label,
  )}</span>`;
}

function legendHtml(items) {
  return `<div class="chart-legend">${items.join("")}</div>`;
}

function dataListRows(rows, kind = "event") {
  return chartDataListHtml(rows.map((row) => ({ ...row, kind: row.kind ?? kind })));
}

// ---------------------------------------------------------------------------
// Section wrappers
// ---------------------------------------------------------------------------

/** Wrap chart markup in a titled section with its window-scope caption. */
export function chartSectionHtml({ id, title, caption, inner }) {
  const headingID = `chart-${id}-title`;
  const captionHtml = caption
    ? `<span class="chart-caption">${escapeHtml(caption)}</span>`
    : "";
  return `<section class="chart-section" id="chart-${escapeAttr(
    id,
  )}" aria-labelledby="${escapeAttr(headingID)}">
    <div class="chart-section-head"><h3 class="chart-title" id="${escapeAttr(
      headingID,
    )}">${escapeHtml(title)}</h3>${captionHtml}</div>
    ${inner}
  </section>`;
}

/** Sentence-case "nothing to draw" copy, never an empty chart frame. */
export function chartEmptyStateHtml(reason) {
  return `<p class="chart-empty">${escapeHtml(sentence(reason))}</p>`;
}

/**
 * Keyboard-accessible alternative to the SVG datums.
 *
 * Rows become real buttons carrying `data-event-id` or `data-jump-step`, which
 * the existing Statistics binding loops already route through `jumpToEvent`.
 */
export function chartDataListHtml(rows) {
  if (rows.length === 0) return "";
  const items = rows.map((row) => {
    const dataAttr = row.anchor
      ? row.kind === "step"
        ? ` data-jump-step="${escapeAttr(row.anchor)}"`
        : ` data-event-id="${escapeAttr(row.anchor)}"`
      : "";
    const label = row.anchor ? `${row.label}, ${row.value}` : `${row.label}, ${row.value}, no event to open`;
    return `<li><button type="button" class="chart-data-row"${dataAttr} aria-label="${escapeAttr(
      label,
    )}"><span class="chart-data-label">${escapeHtml(row.label)}</span><span class="chart-data-value">${escapeHtml(
      row.value,
    )}</span></button></li>`;
  });
  return `<details class="chart-data"><summary>Chart data</summary><ul>${items.join(
    "",
  )}</ul></details>`;
}

// ---------------------------------------------------------------------------
// Context growth chart
// ---------------------------------------------------------------------------

/** Polyline with gaps at unavailable turns, point datums, and compaction markers. */
export function contextGrowthChartHtml(series) {
  if (!series || series.empty) return chartEmptyStateHtml(series?.reason);
  const points = series.points ?? [];
  const markers = series.markers ?? [];
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const baseline = baselineY(height);
  const max = points.reduce((best, point) => (point.available && point.value > best ? point.value : best), 0);
  const ordinalByTurn = new Map(points.map((point, index) => [point.turnIndex, index]));
  const label = `Context growth per turn, ${series.basis} basis`;
  const svg = [svgOpen({ label }), gridLines({ width, height }), axisLabels({ max, width, height })];

  svg.push(polylineRuns(points, { width, height, max }));

  const every = labelEvery(points.length);
  points.forEach((point, index) => {
    const { x } = slotX(index, points.length, width);
    if (point.available) {
      const value = formatNumber(point.value);
      svg.push(
        datum("circle", {
          className: "chart-point",
          aria: `Turn ${point.turnIndex}, context ${value} (${basisMark(point.basis)})`,
          anchor: point.anchor,
          attrs: ` cx="${x.toFixed(2)}" cy="${valueY(point.value, max, height).toFixed(2)}" r="4"`,
          style: "fill: var(--accent)",
        }),
      );
    } else {
      // The legend's dashed "Unavailable gap" swatch matches this cue, so the
      // gap is drawn rather than promised by an unlabelled blank slot.
      svg.push(
        datum("g", {
          className: "chart-unavailable",
          aria: `Turn ${point.turnIndex}, context not recorded (—)`,
          anchor: point.anchor,
          children: `<rect x="${(x - 5).toFixed(2)}" y="${(baseline - 12).toFixed(
            2,
          )}" width="10" height="10" rx="2" fill="none" stroke-dasharray="3 3" style="fill: none; stroke: var(--border-strong)" />`,
        }),
      );
    }
    if (index % every === 0) {
      svg.push(
        `<text class="chart-axis-label" x="${x.toFixed(2)}" y="${
          height - 10
        }" text-anchor="middle" style="fill: var(--muted)">${escapeHtml(
          String(point.turnIndex),
        )}</text>`,
      );
    }
  });

  for (const marker of markers) {
    const ordinal = ordinalByTurn.get(marker.turnIndex);
    if (ordinal === undefined) continue;
    const { x } = slotX(ordinal, points.length, width);
    const removed = marker.removedTokens?.available
      ? `removed ${formatNumber(marker.removedTokens.value)} tokens (${basisMark(
          marker.removedTokens.basis,
        )})`
      : "removed tokens not recorded (—)";
    svg.push(
      datum("g", {
        className: "chart-marker",
        aria: `${marker.label} at turn ${marker.turnIndex}, ${removed}`,
        anchor: marker.eventID,
        children: `<line x1="${x.toFixed(2)}" y1="${PAD.top}" x2="${x.toFixed(2)}" y2="${baseline}" stroke-width="1.5" stroke-dasharray="4 4" style="stroke: var(--accent)" /><text class="chart-marker-label" x="${x.toFixed(
          2,
        )}" y="${PAD.top - 4}" text-anchor="middle" style="fill: var(--muted)">${escapeHtml(
          marker.label,
        )}</text>`,
      }),
    );
  }

  svg.push(svgClose());

  const notes = [];
  if (series.unavailableCount > 0) {
    notes.push(
      `${plural(series.unavailableCount, "turn")} ${
        series.unavailableCount === 1 ? "has" : "have"
      } no context recorded`,
    );
  }
  if (series.unplaced > 0) {
    notes.push(`${plural(series.unplaced, "compaction")} could not be placed on a turn`);
  }

  const rows = points.map((point) => ({
    label: `Turn ${point.turnIndex}`,
    value: point.available
      ? `context ${formatNumber(point.value)} (${basisMark(point.basis)})`
      : "context not recorded (—)",
    anchor: point.anchor,
  }));
  for (const marker of markers) {
    rows.push({
      label: marker.label,
      value: marker.removedTokens?.available
        ? `turn ${marker.turnIndex}, removed ${formatNumber(marker.removedTokens.value)} tokens (${basisMark(
            marker.removedTokens.basis,
          )})`
        : `turn ${marker.turnIndex}, removed tokens not recorded (—)`,
      anchor: marker.eventID,
    });
  }

  return `<div class="chart-scroll">${svg.join("")}</div>${legendHtml([
    legendItem(`Context (${series.basis})`, "background: var(--accent)"),
    legendItem("Unavailable gap", "border: 1px dashed var(--border-strong)"),
    legendItem("Compaction marker", "border-left: 2px dashed var(--accent); background: transparent"),
  ])}${noteHtml(notes)}${dataListRows(rows)}`;
}

// ---------------------------------------------------------------------------
// Token chart
// ---------------------------------------------------------------------------

function tokenTotal(point) {
  return TOKEN_SEGMENTS.reduce((sum, segment) => sum + (point[segment.key] ?? 0), 0);
}

/** Five-segment stacked bars per turn, dashed outline on partial turns. */
export function tokenChartHtml(series) {
  if (!series || series.empty) return chartEmptyStateHtml(series?.reason);
  const points = series.points ?? [];
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const baseline = baselineY(height);
  const max = points.reduce((best, point) => Math.max(best, tokenTotal(point)), 0);
  const label = "Token usage per turn, five segments";
  const svg = [svgOpen({ label }), gridLines({ width, height }), axisLabels({ max, width, height })];
  const every = labelEvery(points.length);

  points.forEach((point, index) => {
    const { x, step } = slotX(index, points.length, width);
    const barW = barWidth(step);
    const total = tokenTotal(point);
    const basis = basisMark(point.basis);
    const partialNote = point.partial ? ", partial: recorded subset only" : "";

    if (total === 0 && point.basis === "unavailable") {
      svg.push(
        notRecordedSlot({
          x,
          width: Math.max(barW, 12),
          height,
          aria: `Turn ${point.turnIndex}, tokens not recorded (—)`,
          anchor: point.anchor,
        }),
      );
    } else if (total === 0) {
      svg.push(
        datum("rect", {
          className: "chart-bar",
          aria: `Turn ${point.turnIndex}, 0 tokens (${basis})`,
          anchor: point.anchor,
          attrs: ` x="${(x - barW / 2).toFixed(2)}" y="${(baseline - 2).toFixed(2)}" width="${barW.toFixed(
            2,
          )}" height="2"`,
          style: "fill: var(--muted)",
        }),
      );
    } else {
      let cursor = baseline;
      for (const segment of TOKEN_SEGMENTS) {
        const value = point[segment.key] ?? 0;
        const segmentHeight = barHeight(value, max, height);
        if (segmentHeight <= 0) continue;
        const y = cursor - segmentHeight;
        svg.push(
          datum("rect", {
            className: "chart-bar",
            aria: `Turn ${point.turnIndex}, ${segment.label.toLowerCase()} ${formatNumber(
              value,
            )} tokens (${basis})${partialNote}`,
            anchor: point.anchor,
            attrs: ` x="${(x - barW / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(
              2,
            )}" height="${segmentHeight.toFixed(2)}"`,
            style: `fill: ${segment.token}`,
          }),
        );
        cursor = y;
      }
      if (point.partial) {
        const stackTop = cursor;
        svg.push(
          `<rect class="chart-partial" x="${(x - barW / 2 - 1).toFixed(2)}" y="${(
            stackTop - 1
          ).toFixed(2)}" width="${(barW + 2).toFixed(2)}" height="${(
            baseline - stackTop + 2
          ).toFixed(
            2,
          )}" rx="2" fill="none" stroke-dasharray="3 3" style="fill: none; stroke: var(--border-strong)"><title>${escapeHtml(
            `Turn ${point.turnIndex}, partial: recorded subset only`,
          )}</title></rect>`,
        );
      }
    }

    if (index % every === 0) {
      svg.push(
        `<text class="chart-axis-label" x="${x.toFixed(2)}" y="${
          height - 10
        }" text-anchor="middle" style="fill: var(--muted)">${escapeHtml(
          String(point.turnIndex),
        )}</text>`,
      );
    }
  });

  svg.push(svgClose());

  const unrecordedCount = points.filter(
    (point) => point.basis === "unavailable" && tokenTotal(point) === 0,
  ).length;

  const rows = points.map((point) => ({
    label: `Turn ${point.turnIndex}`,
    value:
      tokenTotal(point) === 0 && point.basis === "unavailable"
        ? "tokens not recorded (—)"
        : `${TOKEN_SEGMENTS.map(
            (segment) =>
              `${segment.label.toLowerCase()} ${formatNumber(point[segment.key] ?? 0)}`,
          ).join(", ")} tokens (${basisMark(point.basis)})${
            point.partial ? ", partial: recorded subset only" : ""
          }`,
    anchor: point.anchor,
  }));

  const legend = TOKEN_SEGMENTS.map((segment) =>
    legendItem(segment.label, `background: ${segment.token}`),
  );
  if (series.partialCount > 0) {
    legend.push(legendItem("Partial turn", "border: 1px dashed var(--border-strong)"));
  }
  if (unrecordedCount > 0) {
    legend.push(legendItem("Not recorded", "border: 1px dashed var(--border-strong)"));
  }

  const notes = [];
  if (series.partialCount > 0) {
    notes.push(`${plural(series.partialCount, "turn")} recorded only part of its tokens`);
  }
  if (unrecordedCount > 0) {
    notes.push(`${plural(unrecordedCount, "turn")} recorded no step tokens`);
  }

  return `<div class="chart-scroll">${svg.join("")}</div>${legendHtml(legend)}${noteHtml(
    notes,
  )}${dataListRows(rows)}`;
}

// ---------------------------------------------------------------------------
// Cost chart
// ---------------------------------------------------------------------------

function modelColor(models, key) {
  if (key === "—") return "var(--muted)";
  const index = models.findIndex((model) => model.key === key);
  return MODEL_COLORS[(index >= 0 ? index : 0) % MODEL_COLORS.length];
}

/** Cost bars grouped and coloured by model, with an explicit highest-cost mark. */
export function costChartHtml(series) {
  if (!series || series.empty) return chartEmptyStateHtml(series?.reason);
  const points = series.points ?? [];
  const models = series.models ?? [];
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const baseline = baselineY(height);
  const max = series.max?.value ?? null;
  const maxTurns = new Set(series.max?.turnIndices ?? []);
  const label = "Cost per turn by model, USD";
  const svg = [
    svgOpen({ label }),
    gridLines({ width, height }),
    axisLabels({ max, width, height, format: formatCost }),
  ];
  const every = labelEvery(points.length);

  points.forEach((point, index) => {
    const { x, step } = slotX(index, points.length, width);
    const barW = barWidth(step);
    const isHighest = maxTurns.has(point.turnIndex);

    if (!point.cost.available) {
      svg.push(
        notRecordedSlot({
          x,
          width: Math.max(barW, 12),
          height,
          aria: `Turn ${point.turnIndex}, cost not recorded (—), ${point.modelLabel}`,
          anchor: point.anchor,
        }),
      );
    } else {
      const barH = Math.max(2, barHeight(point.cost.value, max ?? 0, height));
      const y = baseline - barH;
      const provider = point.providerLabel ? `, provider ${point.providerLabel}` : "";
      svg.push(
        datum("rect", {
          className: "chart-bar",
          aria: `Turn ${point.turnIndex}, cost ${formatCost(point.cost.value)} (${basisMark(
            point.cost.basis,
          )}), ${point.modelLabel}${provider}${isHighest ? ", highest cost" : ""}`,
          anchor: point.anchor,
          attrs: ` x="${(x - barW / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(
            2,
          )}" height="${barH.toFixed(2)}"`,
          style: `fill: ${modelColor(models, point.modelKey)}`,
        }),
      );
      if (isHighest) {
        svg.push(
          `<text class="chart-highest" x="${x.toFixed(2)}" y="${Math.max(
            PAD.top + 10,
            y - 6,
          ).toFixed(2)}" text-anchor="middle" style="fill: var(--text-2)">Highest cost</text>`,
        );
      }
    }

    if (index % every === 0) {
      svg.push(
        `<text class="chart-axis-label" x="${x.toFixed(2)}" y="${
          height - 10
        }" text-anchor="middle" style="fill: var(--muted)">${escapeHtml(
          String(point.turnIndex),
        )}</text>`,
      );
    }
  });

  svg.push(svgClose());

  const rows = points.map((point) => ({
    label: `Turn ${point.turnIndex}`,
    value: point.cost.available
      ? `${formatCost(point.cost.value)} (${basisMark(point.cost.basis)}), ${point.modelLabel}${
          point.providerLabel ? `, provider ${point.providerLabel}` : ""
        }${maxTurns.has(point.turnIndex) ? ", highest cost" : ""}`
      : `cost not recorded (—), ${point.modelLabel}`,
    anchor: point.anchor,
  }));

  const legend = models.map((model) =>
    legendItem(model.label, `background: ${modelColor(models, model.key)}`),
  );
  if (series.unavailableCount > 0) {
    legend.push(legendItem("Not recorded", "border: 1px dashed var(--border-strong)"));
  }

  return `<div class="chart-scroll">${svg.join("")}</div>${legendHtml(legend)}${
    series.unavailableCount > 0
      ? noteHtml([`${plural(series.unavailableCount, "turn")} recorded no cost`])
      : ""
  }${dataListRows(rows)}`;
}

// ---------------------------------------------------------------------------
// Duration chart
// ---------------------------------------------------------------------------

/** Per-step model/tool/residual stacks; missing segments are omitted. */
export function durationChartHtml(series) {
  if (!series || series.empty) return chartEmptyStateHtml(series?.reason);
  const points = series.points ?? [];
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const baseline = baselineY(height);
  const totals = points.map((point) =>
    DURATION_SEGMENTS.reduce((sum, segment) => sum + (point[segment.key]?.value ?? 0), 0),
  );
  const max = totals.reduce((best, total) => Math.max(best, total), 0);
  const label = "Step duration breakdown";
  const svg = [
    svgOpen({ label }),
    gridLines({ width, height }),
    // formatDuration keeps the unit on every tick ("300 ms", "1.50 s") because
    // the scale can cross the second boundary.
    axisLabels({ max, width, height, format: formatDuration }),
  ];
  const every = labelEvery(points.length);

  points.forEach((point, index) => {
    const { x, step } = slotX(index, points.length, width);
    const barW = barWidth(step);
    const present = DURATION_SEGMENTS.filter((segment) => point[segment.key]);

    if (present.length === 0) {
      svg.push(
        notRecordedSlot({
          x,
          width: Math.max(barW, 12),
          height,
          aria: `Step ${point.label}, durations not recorded (—)`,
          anchor: point.anchor,
          kind: "step",
        }),
      );
    } else {
      let cursor = baseline;
      for (const segment of present) {
        const metric = point[segment.key];
        const segmentHeight = barHeight(metric.value, max, height);
        if (segmentHeight <= 0) {
          if (metric.value === 0) {
            // A recorded 0 ms segment stays a visible tick at its own stack
            // position, not a gap and not only when it happens to be first.
            svg.push(
              datum("rect", {
                className: "chart-bar",
                aria: `Step ${point.label}, ${segment.label.toLowerCase()} 0 ms (${basisMark(
                  metric.basis,
                )})`,
                anchor: point.anchor,
                kind: "step",
                attrs: ` x="${(x - barW / 2).toFixed(2)}" y="${(cursor - 2).toFixed(
                  2,
                )}" width="${barW.toFixed(2)}" height="2"`,
                style: `fill: ${segment.token}`,
              }),
            );
          }
          continue;
        }
        const y = cursor - segmentHeight;
        svg.push(
          datum("rect", {
            className: "chart-bar",
            aria: `Step ${point.label}, ${segment.label.toLowerCase()} ${formatDuration(
              metric.value,
            )} (${basisMark(metric.basis)})`,
            anchor: point.anchor,
            kind: "step",
            attrs: ` x="${(x - barW / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(
              2,
            )}" height="${segmentHeight.toFixed(2)}"`,
            style: `fill: ${segment.token}`,
          }),
        );
        cursor = y;
      }
    }

    if (index % every === 0) {
      svg.push(
        `<text class="chart-axis-label" x="${x.toFixed(2)}" y="${
          height - 10
        }" text-anchor="middle" style="fill: var(--muted)">${escapeHtml(
          String(point.label),
        )}</text>`,
      );
    }
  });

  svg.push(svgClose());

  const rows = points.map((point) => {
    const present = DURATION_SEGMENTS.filter((segment) => point[segment.key]);
    return {
      label: `Step ${point.label}`,
      value:
        present.length === 0
          ? "durations not recorded (—)"
          : present
              .map(
                (segment) =>
                  `${segment.label.toLowerCase()} ${formatDuration(
                    point[segment.key].value,
                  )} (${basisMark(point[segment.key].basis)})`,
              )
              .join(", "),
      anchor: point.anchor,
      kind: "step",
    };
  });

  const legend = DURATION_SEGMENTS.map((segment) =>
    legendItem(segment.label, `background: ${segment.token}`),
  );
  if (series.unavailableCount > 0) {
    legend.push(legendItem("Not recorded", "border: 1px dashed var(--border-strong)"));
  }

  return `<div class="chart-scroll">${svg.join("")}</div>${legendHtml(legend)}${
    series.unavailableCount > 0
      ? noteHtml([`${plural(series.unavailableCount, "step")} recorded no durations`])
      : ""
  }${dataListRows(rows, "step")}`;
}
