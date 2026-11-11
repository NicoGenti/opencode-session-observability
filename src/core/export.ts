// avoid-ai-design-ignore-file: SD2 (dark is earned by a monitoring tool; green is semantic status)
import {
  basisMark,
  escapeMarkdownCell,
  escapeMarkdownInline,
  formatCost,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTime,
  slugify,
  timestampForFilename,
} from "./format.ts";
import { escapeHtml, safeStringify } from "./util.ts";
import type {
  Analysis,
  EventIndexEntry,
  ExportResult,
  Metric,
  ModelRef,
  NormalizedEvent,
  SessionMeta,
  Step,
  Turn,
} from "./types.ts";

export interface ExportInput {
  session: SessionMeta;
  analysis: Analysis;
  events: NormalizedEvent[];
  format: "json" | "markdown" | "html";
  includeEvents: boolean;
  redacted: boolean;
  /** Generator string injected by the caller (core stays I/O-free). */
  generator: string;
}

export function exportSession(input: ExportInput): ExportResult {
  const stamp = timestampForFilename(input.analysis.generatedAt);
  const slug = slugify(
    input.session.title ?? input.session.slug ?? input.session.id,
  );
  const base = `${slug}-${stamp}`;
  if (input.format === "json") {
    return {
      filename: `${base}.json`,
      mime: "application/json; charset=utf-8",
      content: exportJson(input),
      redacted: input.redacted,
    };
  }
  if (input.format === "markdown") {
    return {
      filename: `${base}.md`,
      mime: "text/markdown; charset=utf-8",
      content: exportMarkdown(input),
      redacted: input.redacted,
    };
  }
  return {
    filename: `${base}.html`,
    mime: "text/html; charset=utf-8",
    content: exportHtml(input),
    redacted: input.redacted,
  };
}

function exportJson(input: ExportInput): string {
  return JSON.stringify(
    {
      generator: input.generator,
      version: 1,
      exportedAt: new Date(input.analysis.generatedAt).toISOString(),
      redacted: input.redacted,
      session: input.session,
      analysis: input.analysis,
      ...(input.includeEvents ? { events: input.events } : {}),
      limitations: input.analysis.capabilities.notes,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function metricMd(metric: Metric, formatter: (value: number | null) => string): string {
  if (metric.value === null) return "—";
  const mark = metric.basis === "measured" ? "" : ` ${basisMark(metric.basis)}`;
  return `${formatter(metric.value)}${mark}`;
}

function modelLabel(model: ModelRef | null | undefined): string {
  if (!model) return "—";
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

function turnModel(turn: Turn): string {
  const step = [...turn.steps].reverse().find((item) => item.model);
  return modelLabel(step?.model ?? null);
}

function triggerLabel(turn: Turn): string {
  return turn.trigger.label;
}

function eventBadgeText(event: EventIndexEntry): string {
  const badges: string[] = [];
  if (event.flags.error) badges.push("error");
  if (event.flags.retry) badges.push("retry");
  if (event.flags.compaction) badges.push("compaction");
  if (event.flags.context) badges.push("context");
  if (event.flags.subagent) badges.push("subagent");
  if (event.uncertainty.length > 0) badges.push("uncertain");
  return badges.join(", ");
}

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(escapeMarkdownCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${row.map((cell) => escapeMarkdownCell(String(cell))).join(" | ")} |`,
  );
  return [head, sep, ...body].join("\n");
}

function exportMarkdown(input: ExportInput): string {
  const { session, analysis, redacted } = input;
  const lines: string[] = [];
  const title = session.title ?? session.slug ?? session.id;
  lines.push(`# ${escapeMarkdownInline(title)}`);
  lines.push("");
  if (redacted) {
    lines.push(
      "> **Redacted export.** Credential-shaped values were replaced with `[REDACTED]`. Re-export with `reveal` to include raw values.",
    );
    lines.push("");
  }
  lines.push(
    `- **Session**: \`${session.id}\``,
    `- **Directory**: \`${escapeMarkdownInline(session.directory ?? "—")}\``,
    `- **Agent**: \`${escapeMarkdownInline(session.agent ?? "—")}\``,
    `- **Model**: \`${modelLabel(session.model)}\``,
    `- **Created**: ${formatDateTime(session.time.created)}`,
    `- **Updated**: ${formatDateTime(session.time.updated ?? null)}`,
    `- **Outcome**: ${session.outcome ?? "—"}`,
    `- **Source**: ${analysis.capabilities.source} (${analysis.coverage.complete ? "full session" : "window"})`,
    `- **Generated**: ${formatDateTime(analysis.generatedAt)}`,
    "",
  );

  lines.push(`## Summary (${analysis.totals.scope === "session" ? "Session total" : "Window total"})`);
  lines.push("");
  lines.push(
    mdTable(
      ["Metric", "Value", "Basis"],
      [
        ["Turns", formatNumber(analysis.totals.turns), "measured"],
        ["Steps", formatNumber(analysis.totals.steps), "measured"],
        ["Tool calls", formatNumber(analysis.totals.toolCalls), "measured"],
        ["Subagent calls", formatNumber(analysis.totals.subagentCalls), "derived"],
        ["Input tokens", formatNumber(analysis.totals.tokens.input), "derived sum"],
        ["Output tokens", formatNumber(analysis.totals.tokens.output), "derived sum"],
        ["Reasoning tokens", formatNumber(analysis.totals.tokens.reasoning), "derived sum"],
        ["Cache read", formatNumber(analysis.totals.tokens.cacheRead), "derived sum"],
        ["Cache write", formatNumber(analysis.totals.tokens.cacheWrite), "derived sum"],
        ["Cache hit rate", metricMd(analysis.totals.cacheHitRate, formatPercent), "derived"],
        ["Cost", metricMd(analysis.totals.cost, formatCost), "derived"],
        ["Model time", metricMd(analysis.totals.modelTime, formatDuration), "derived"],
        ["Tool time", metricMd(analysis.totals.toolTime, formatDuration), "derived"],
        ["Active turn time", metricMd(analysis.totals.activeTurnTime, formatDuration), "derived"],
        ["Wall clock", metricMd(analysis.totals.wallClockTime, formatDuration), "derived"],
        ["Output speed", `${metricMd(analysis.totals.outputSpeed, (v) => `${v?.toFixed(1) ?? "—"} tok/s`)}`, "derived"],
        ["Errors", formatNumber(analysis.totals.errors.total), "measured counts"],
        ["Retries", formatNumber(analysis.totals.retries), "measured"],
        ["Compactions", formatNumber(analysis.totals.compactions), "measured"],
        ["Final context", metricMd(analysis.totals.finalContext, formatNumber), "derived"],
        ["Cumulative prompt", metricMd(analysis.totals.cumulativePrompt, formatNumber), "derived"],
      ],
    ),
  );
  lines.push("");
  if (analysis.totals.recorded) {
    lines.push("### Totals recorded by OpenCode");
    lines.push("");
    if (analysis.totals.recorded.tokens) {
      const t = analysis.totals.recorded.tokens;
      lines.push(
        `- Tokens: input ${formatNumber(t.input)}, output ${formatNumber(t.output)}, reasoning ${formatNumber(t.reasoning)}, cache read ${formatNumber(t.cacheRead)}, cache write ${formatNumber(t.cacheWrite)}`,
      );
    }
    if (analysis.totals.recorded.cost !== undefined) {
      lines.push(`- Cost: ${formatCost(analysis.totals.recorded.cost)}`);
    }
    lines.push(`- ${analysis.totals.recorded.note}`);
    lines.push("");
  }

  lines.push("## Turns");
  lines.push("");
  lines.push(
    mdTable(
      [
        "#",
        "Trigger",
        "Start",
        "Duration",
        "Model",
        "Steps",
        "In",
        "Out",
        "Reason",
        "Cache R/W",
        "Hit",
        "Context (latest)",
        "Context (cum.)",
        "Δ context",
        "Model time",
        "Tool time",
        "Residual",
        "Out/s",
        "Cost",
        "Status",
      ],
      analysis.turns.map((turn) => [
        String(turn.index),
        triggerLabel(turn),
        formatTime(turn.startTime),
        metricMd(turn.totalTime, formatDuration),
        turnModel(turn),
        String(turn.steps.length),
        formatNumber(turn.tokens.input),
        formatNumber(turn.tokens.output),
        formatNumber(turn.tokens.reasoning),
        `${formatNumber(turn.tokens.cacheRead)} / ${formatNumber(turn.tokens.cacheWrite)}`,
        metricMd(turn.cacheHitRate, formatPercent),
        metricMd(turn.promptTokensLatest, formatNumber),
        metricMd(turn.promptTokensCumulative, formatNumber),
        metricMd(turn.contextDelta, (v) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${formatNumber(v)}`)),
        metricMd(turn.modelTime, formatDuration),
        metricMd(turn.toolTime, formatDuration),
        metricMd(turn.residualTime, formatDuration),
        metricMd(turn.outputSpeed, (v) => `${v?.toFixed(1) ?? "—"} tok/s`),
        metricMd(turn.cost, formatCost),
        `${turn.status}${turn.uncertainty.length > 0 ? " !" : ""}`,
      ]),
    ),
  );
  lines.push("");

  lines.push("## Steps");
  lines.push("");
  const stepRows: string[][] = [];
  for (const turn of analysis.turns) {
    for (const step of turn.steps) {
      stepRows.push([
        `${turn.index}.${step.index}`,
        formatTime(step.startTime),
        step.agent ?? "—",
        modelLabel(step.model),
        step.finish ?? "—",
        metricMd(step.promptTokens, formatNumber),
        formatNumber(step.tokens?.input ?? 0),
        formatNumber(step.tokens?.output ?? 0),
        formatNumber(step.tokens?.reasoning ?? 0),
        `${formatNumber(step.tokens?.cacheRead ?? 0)} / ${formatNumber(step.tokens?.cacheWrite ?? 0)}`,
        metricMd(step.cacheHitRate, formatPercent),
        "—",
        metricMd(step.modelTime, formatDuration),
        metricMd(step.toolTime, formatDuration),
        metricMd(step.totalTime, formatDuration),
        metricMd(step.residualTime, formatDuration),
        metricMd(step.outputSpeed, (v) => `${v?.toFixed(1) ?? "—"} tok/s`),
        step.toolNames.join(", ") || "—",
        step.subagentSessionIDs.join(", ") || "—",
        `${step.status}${step.uncertainty.length > 0 ? " !" : ""}`,
      ]);
    }
  }
  lines.push(
    mdTable(
      [
        "Turn.Step",
        "Start",
        "Agent",
        "Model",
        "Finish",
        "Prompt",
        "In",
        "Out",
        "Reason",
        "Cache R/W",
        "Hit",
        "TTFT",
        "Model time",
        "Tool time",
        "Total",
        "Residual",
        "Out/s",
        "Tools",
        "Subagents",
        "Status",
      ],
      stepRows,
    ),
  );
  lines.push("");
  lines.push(
    "TTFT is shown as `—` because OpenCode 2 does not persist a first-token timestamp.",
  );
  lines.push("");

  if (analysis.compactions.length > 0) {
    lines.push("## Compactions");
    lines.push("");
    lines.push(
      mdTable(
        ["Time", "Status", "Reason", "Model", "Before", "After", "Δ", "Removed", "Summary chars", "Output tokens", "Cost", "Duration"],
        analysis.compactions.map((item) => [
          formatDateTime(item.timestamp),
          item.status,
          item.reason ?? "—",
          modelLabel(item.model),
          metricMd(item.contextBefore, formatNumber),
          metricMd(item.contextAfter, formatNumber),
          metricMd(item.contextDelta, (v) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${formatNumber(v)}`)),
          metricMd(item.removedTokens, formatNumber),
          formatNumber(item.summaryChars),
          formatNumber(item.tokens?.output ?? null),
          formatCost(item.cost),
          "— (only completion time persisted)",
        ]),
      ),
    );
    lines.push("");
  }

  lines.push("## Trajectory");
  lines.push("");
  const byTurn = new Map<string | null, EventIndexEntry[]>();
  for (const event of analysis.events) {
    const list = byTurn.get(event.turnID) ?? [];
    list.push(event);
    byTurn.set(event.turnID, list);
  }
  const turnIndex = new Map(analysis.turns.map((turn) => [turn.id, turn.index]));
  const groups = [...byTurn.entries()].sort((a, b) => {
    if (a[0] === null) return 1;
    if (b[0] === null) return -1;
    return (turnIndex.get(a[0]) ?? 0) - (turnIndex.get(b[0]) ?? 0);
  });
  for (const [turnID, events] of groups) {
    const label =
      turnID === null
        ? "Unattached events"
        : `Turn ${turnIndex.get(turnID) ?? "?"} — ${
            analysis.turns.find((turn) => turn.id === turnID)?.trigger.label ?? ""
          }`;
    lines.push(`### ${escapeMarkdownInline(label)}`);
    lines.push("");
    for (const event of events) {
      const badges = eventBadgeText(event);
      const model = event.model ? modelLabel(event.model) : "";
      const tool = event.toolName
        ? ` tool=${escapeMarkdownInline(event.toolName)}(${escapeMarkdownInline(event.toolStatus ?? "?")})`
        : "";
      const previewText =
        event.preview.length > 0
          ? ` — ${escapeMarkdownInline(event.preview.slice(0, 200))}`
          : "";
      lines.push(
        `- \`${formatTime(event.timestamp)}\` **${event.kind}** ${escapeMarkdownInline(
          event.title,
        )}${tool}${model ? `; ${escapeMarkdownInline(model)}` : ""}${
          event.status ? `; ${escapeMarkdownInline(event.status)}` : ""
        }${badges ? `; [${badges}]` : ""}${previewText}`,
      );
    }
    lines.push("");
  }

  lines.push("## Limitations and metric basis");
  lines.push("");
  lines.push(
    "- **M** = measured (recorded by OpenCode), **D** = derived (computed from recorded values), **E** = estimated (fallback with an explicit assumption), **—** = unavailable.",
  );
  lines.push(
    `- Prompt tokens = input + cache read + cache write. ${analysis.capabilities.promptTokenBreakdown}`,
  );
  lines.push(
    "- Model time is `time.created → time.streamed` (provider generation, before tool settlement). Step total is `created → completed`. Tool time is the sum of recorded tool durations; parallel calls can exceed wall-clock.",
  );
  lines.push(
    "- TTFT, permission/approval decisions, request headers, and tool-set changes are not persisted in OpenCode 2.2.x session data.",
  );
  for (const note of analysis.capabilities.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push(`Generated by ${input.generator}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function htmlBadge(label: string, kind = "neutral"): string {
  return `<span class="badge badge-${kind}">${escapeHtml(label)}</span>`;
}

function htmlMetric(metric: Metric, formatter: (value: number | null) => string): string {
  if (metric.value === null) {
    return `<span class="metric unavailable" title="${escapeHtml(metric.note ?? "unavailable")}">—</span>`;
  }
  const value = escapeHtml(formatter(metric.value));
  if (metric.basis === "measured") return `<span class="metric">${value}</span>`;
  return `<span class="metric metric-${metric.basis}" title="${escapeHtml(
    `${metric.basis}${metric.note ? `: ${metric.note}` : ""}`,
  )}">${value}<sup>${basisMark(metric.basis)}</sup></span>`;
}

function htmlEventBadges(event: EventIndexEntry): string {
  const badges: string[] = [];
  if (event.flags.error) badges.push(htmlBadge("error", "error"));
  if (event.flags.retry) badges.push(htmlBadge("retry", "retry"));
  if (event.flags.compaction) badges.push(htmlBadge("compaction", "compaction"));
  if (event.flags.context) badges.push(htmlBadge("context", "context"));
  if (event.flags.subagent) badges.push(htmlBadge("subagent", "subagent"));
  if (event.uncertainty.length > 0) {
    badges.push(
      `<span class="badge badge-uncertain" title="${escapeHtml(event.uncertainty.join(", "))}">uncertain</span>`,
    );
  }
  return badges.join(" ");
}

function stepRowsHtml(turn: Turn): string {
  return turn.steps
    .map(
      (step) => `<tr>
        <td class="mono">${turn.index}.${step.index}</td>
        <td class="mono">${escapeHtml(formatTime(step.startTime))}</td>
        <td>${escapeHtml(step.agent ?? "—")}</td>
        <td class="mono">${escapeHtml(modelLabel(step.model))}</td>
        <td>${htmlMetric(step.promptTokens, formatNumber)}</td>
        <td class="mono">${formatNumber(step.tokens?.input ?? null)}</td>
        <td class="mono">${formatNumber(step.tokens?.output ?? null)}</td>
        <td class="mono">${formatNumber(step.tokens?.reasoning ?? null)}</td>
        <td class="mono">${formatNumber(step.tokens?.cacheRead ?? null)} / ${formatNumber(step.tokens?.cacheWrite ?? null)}</td>
        <td>${htmlMetric(step.cacheHitRate, formatPercent)}</td>
        <td>${htmlMetric(step.modelTime, formatDuration)}</td>
        <td>${htmlMetric(step.toolTime, formatDuration)}</td>
        <td>${htmlMetric(step.totalTime, formatDuration)}</td>
        <td>${htmlMetric(step.outputSpeed, (value) => `${value?.toFixed(1) ?? "—"} tok/s`)}</td>
        <td>${escapeHtml(step.toolNames.join(", ") || "—")}</td>
        <td>${escapeHtml(step.status)}</td>
      </tr>`,
    )
    .join("");
}

function eventPayloadHtml(event: NormalizedEvent | undefined): string {
  if (!event || event.payload === null || event.payload === undefined) return "";
  const json = safeStringify(event.payload, 2);
  const clipped = json.length > 60_000 ? `${json.slice(0, 60_000)}\n… (truncated in HTML export)` : json;
  return `<details class="payload"><summary>Payload</summary><div class="payload-actions"><button type="button" data-copy>Copy JSON</button></div><pre>${escapeHtml(clipped)}</pre></details>`;
}

function exportHtml(input: ExportInput): string {
  const { session, analysis, redacted } = input;
  const title = session.title ?? session.slug ?? session.id;
  const eventById = input.includeEvents
    ? new Map(input.events.map((event) => [event.id, event]))
    : new Map<string, NormalizedEvent>();
  const totals = analysis.totals;
  const stat = (label: string, value: string, sub = ""): string =>
    `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}</div>`;

  const turnRows = analysis.turns
    .map(
      (turn) => `<tr>
        <td class="mono">${turn.index}</td>
        <td>${escapeHtml(turn.trigger.label)}</td>
        <td class="mono">${escapeHtml(formatTime(turn.startTime))}</td>
        <td>${htmlMetric(turn.totalTime, formatDuration)}</td>
        <td class="mono">${escapeHtml(turnModel(turn))}</td>
        <td class="mono">${turn.steps.length}</td>
        <td class="mono">${formatNumber(turn.tokens.input)}</td>
        <td class="mono">${formatNumber(turn.tokens.output)}</td>
        <td class="mono">${formatNumber(turn.tokens.cacheRead)} / ${formatNumber(turn.tokens.cacheWrite)}</td>
        <td>${htmlMetric(turn.cacheHitRate, formatPercent)}</td>
        <td>${htmlMetric(turn.promptTokensLatest, formatNumber)}</td>
        <td>${htmlMetric(turn.promptTokensCumulative, formatNumber)}</td>
        <td>${htmlMetric(turn.contextDelta, (value) => (value === null ? "—" : `${value >= 0 ? "+" : ""}${formatNumber(value)}`))}</td>
        <td>${htmlMetric(turn.modelTime, formatDuration)}</td>
        <td>${htmlMetric(turn.toolTime, formatDuration)}</td>
        <td>${htmlMetric(turn.residualTime, formatDuration)}</td>
        <td>${htmlMetric(turn.outputSpeed, (value) => `${value?.toFixed(1) ?? "—"} tok/s`)}</td>
        <td>${htmlMetric(turn.cost, formatCost)}</td>
        <td><span class="status status-${escapeHtml(turn.status)}">${escapeHtml(turn.status)}</span>${turn.uncertainty.length ? ` ${htmlBadge("uncertain", "uncertain")}` : ""}</td>
      </tr>`,
    )
    .join("");

  const turnSections = analysis.turns
    .map(
      (turn) => `<details class="turn">
        <summary><span class="mono">Turn ${turn.index}</span> · ${escapeHtml(turn.trigger.label)} · ${turn.steps.length} step(s) · ${htmlMetric(turn.totalTime, formatDuration)} · <span class="status status-${escapeHtml(turn.status)}">${escapeHtml(turn.status)}</span></summary>
        <table class="steps"><thead><tr>
          <th>Step</th><th>Start</th><th>Agent</th><th>Model</th><th>Prompt</th><th>In</th><th>Out</th><th>Reason</th><th>Cache R/W</th><th>Hit</th><th>Model time</th><th>Tool time</th><th>Total</th><th>Out/s</th><th>Tools</th><th>Status</th>
        </tr></thead><tbody>${stepRowsHtml(turn)}</tbody></table>
        ${turn.steps
          .filter((step) => step.responseText.length > 0 || step.reasoningText.length > 0)
          .map(
            (step) => `<details class="response"><summary>Turn ${turn.index}.${step.index} response</summary>${
              step.reasoningText
                ? `<h4>Reasoning</h4><pre class="text">${escapeHtml(step.reasoningText.slice(0, 30_000))}</pre>`
                : ""
            }${
              step.responseText
                ? `<h4>Response</h4><pre class="text">${escapeHtml(step.responseText.slice(0, 30_000))}</pre>`
                : ""
            }</details>`,
          )
          .join("")}
      </details>`,
    )
    .join("");

  const compactionRows = analysis.compactions
    .map(
      (item) => `<tr>
        <td class="mono">${escapeHtml(formatDateTime(item.timestamp))}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.reason ?? "—")}</td>
        <td class="mono">${escapeHtml(modelLabel(item.model))}</td>
        <td>${htmlMetric(item.contextBefore, formatNumber)}</td>
        <td>${htmlMetric(item.contextAfter, formatNumber)}</td>
        <td>${htmlMetric(item.contextDelta, (value) => (value === null ? "—" : `${value >= 0 ? "+" : ""}${formatNumber(value)}`))}</td>
        <td>${htmlMetric(item.removedTokens, formatNumber)}</td>
        <td class="mono">${formatNumber(item.summaryChars)}</td>
        <td class="mono">${formatNumber(item.tokens?.output ?? null)}</td>
        <td>${formatCost(item.cost)}</td>
        <td class="muted">— only completion time persisted</td>
      </tr>`,
    )
    .join("");

  const byTurn = new Map<string | null, EventIndexEntry[]>();
  for (const event of analysis.events) {
    const list = byTurn.get(event.turnID) ?? [];
    list.push(event);
    byTurn.set(event.turnID, list);
  }
  const turnIndex = new Map(analysis.turns.map((turn) => [turn.id, turn.index]));
  const groups = [...byTurn.entries()].sort((a, b) => {
    if (a[0] === null) return 1;
    if (b[0] === null) return -1;
    return (turnIndex.get(a[0]) ?? 0) - (turnIndex.get(b[0]) ?? 0);
  });
  const trajectory = groups
    .map(([turnID, events]) => {
      const label =
        turnID === null
          ? "Unattached events"
          : `Turn ${turnIndex.get(turnID) ?? "?"} — ${
              analysis.turns.find((turn) => turn.id === turnID)?.trigger.label ?? ""
            }`;
      const rows = events
        .map((event) => {
          const full = eventById.get(event.id);
          return `<div class="event">
            <div class="event-meta">
              <span class="mono">${escapeHtml(formatTime(event.timestamp))}</span>
              ${htmlBadge(event.kind, event.kind === "error" ? "error" : event.kind === "tool" ? "tool" : "neutral")}
              ${htmlEventBadges(event)}
            </div>
            <div class="event-title">${escapeHtml(event.title)}</div>
            <div class="event-sub">
              ${event.agent ? `agent=${escapeHtml(event.agent)} ` : ""}
              ${event.model ? `model=${escapeHtml(modelLabel(event.model))} ` : ""}
              ${event.toolName ? `tool=${escapeHtml(event.toolName)}(${escapeHtml(event.toolStatus ?? "?")}) ` : ""}
              ${event.status ? `status=${escapeHtml(event.status)}` : ""}
            </div>
            ${event.preview ? `<div class="event-preview">${escapeHtml(event.preview)}</div>` : ""}
            ${eventPayloadHtml(full)}
          </div>`;
        })
        .join("");
      return `<section class="trajectory-group"><h3>${escapeHtml(label)}</h3>${rows}</section>`;
    })
    .join("");

  const limitations = [
    "M = measured, D = derived, E = estimated, — = unavailable.",
    "TTFT, permission/approval decisions, request headers and tool-set changes are not persisted in OpenCode 2.2.x session data.",
    "Prompt tokens = input + cache read + cache write.",
    "Model time is created → streamed (provider generation, before tool settlement). Step total is created → completed.",
    "Tool time is the sum of recorded tool durations; parallel calls can exceed wall-clock.",
    ...analysis.capabilities.notes,
  ];

  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — OpenCode session report</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --surface-2: #f3f3f0;
  --text: #0b0b0b;
  --text-2: #52514e;
  --muted: #6b6a66;
  --border: rgba(11,11,11,0.10);
  --grid: #e1e0d9;
  --accent: #1f6ac2;
  --good: #0a7f0a;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #c23535;
  --radius: 10px;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --surface-2: #232322;
    --text: #f0efec;
    --text-2: #c3c2b7;
    --muted: #898781;
    --border: rgba(255,255,255,0.10);
    --grid: #2c2c2a;
    --accent: #3987e5;
    --good: #0ca30c;
    --critical: #ef6a6a;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --surface-2: #232322;
  --text: #f0efec;
  --text-2: #c3c2b7;
  --muted: #898781;
  --border: rgba(255,255,255,0.10);
  --grid: #2c2c2a;
  --accent: #3987e5;
  --good: #0ca30c;
  --critical: #ef6a6a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text); font: 14px/1.5 var(--sans); }
a { color: var(--accent); }
header { padding: 24px clamp(16px, 4vw, 48px) 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
h1 { margin: 0 0 6px; font-size: clamp(20px, 3vw, 28px); line-height: 1.2; }
h2 { margin: 32px 0 12px; font-size: 18px; }
h3 { margin: 20px 0 8px; font-size: 15px; color: var(--text-2); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--text-2); font-size: 13px; }
.meta code { color: var(--text); }
main { padding: 20px clamp(16px, 4vw, 48px) 64px; max-width: 1500px; margin: 0 auto; }
.warning { border: 1px solid var(--warning); background: color-mix(in srgb, var(--warning) 12%, var(--surface)); border-radius: var(--radius); padding: 10px 14px; margin: 16px 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0 8px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.stat-label { color: var(--muted); font-size: 11px; }
.stat-value { font-size: 22px; font-weight: 650; margin-top: 4px; }
.stat-sub { color: var(--text-2); font-size: 12px; margin-top: 2px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 0; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { position: sticky; top: 0; background: var(--surface-2); color: var(--text-2); font-weight: 600; font-size: 11px; }
tr:last-child td { border-bottom: 0; }
.mono, .metric { font-variant-numeric: tabular-nums; }
.metric sup { font-size: 10px; color: var(--muted); margin-left: 1px; }
.metric-estimated { color: var(--text-2); }
.unavailable { color: var(--muted); }
.muted { color: var(--muted); }
.badge { display: inline-block; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); font-size: 11px; line-height: 1.5; color: var(--text-2); background: var(--surface-2); }
.badge-error { border-color: color-mix(in srgb, var(--critical) 55%, transparent); color: var(--critical); background: color-mix(in srgb, var(--critical) 9%, var(--surface)); }
.badge-retry, .badge-compaction, .badge-context { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
.badge-subagent { border-color: color-mix(in srgb, var(--good) 45%, transparent); color: var(--good); background: color-mix(in srgb, var(--good) 8%, var(--surface)); }
.badge-uncertain { border-style: dashed; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.status-completed { color: var(--good); }
.status-error, .status-interrupted { color: var(--critical); }
.status-incomplete, .status-unknown, .status-running { color: var(--text-2); }
details.turn { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 8px 0; padding: 8px 12px; }
details.turn > summary { cursor: pointer; color: var(--text-2); font-size: 13px; }
details.turn > summary .mono { color: var(--text); }
details.response { margin: 8px 0 4px; }
details.response > summary, details.payload > summary { cursor: pointer; color: var(--text-2); font-size: 12px; }
pre.text, pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; max-height: 480px; overflow: auto; font: 12px/1.5 var(--mono); }
.trajectory-group { margin: 18px 0; }
.event { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin: 6px 0; }
.event-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); font-size: 11px; }
.event-title { margin-top: 2px; font-weight: 600; }
.event-sub { color: var(--text-2); font-size: 11.5px; }
.event-preview { color: var(--text-2); font-size: 12px; margin-top: 4px; }
.payload-actions { margin: 6px 0; }
button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
button:hover { border-color: var(--accent); }
footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); margin-top: 40px; padding-top: 12px; }
@media (max-width: 640px) {
  .stats { grid-template-columns: repeat(2, 1fr); }
  th, td { padding: 6px 8px; }
}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    <span>Session <code>${escapeHtml(session.id)}</code></span>
    <span>Directory <code>${escapeHtml(session.directory ?? "—")}</code></span>
    <span>Agent <code>${escapeHtml(session.agent ?? "—")}</code></span>
    <span>Model <code>${escapeHtml(modelLabel(session.model))}</code></span>
    <span>Outcome <code>${escapeHtml(session.outcome ?? "—")}</code></span>
    <span>Source <code>${escapeHtml(analysis.capabilities.source)}</code></span>
    <span>Scope <code>${analysis.coverage.complete ? "session" : "window"}</code></span>
    <span>Generated ${escapeHtml(formatDateTime(analysis.generatedAt))}</span>
  </div>
</header>
<main>
${redacted ? `<div class="warning"><strong>Redacted export.</strong> Credential-shaped values were replaced with <code>[REDACTED]</code>. Re-export with <code>reveal</code> to include raw values.</div>` : ""}
<h2>${totals.scope === "session" ? "Session total" : "Window total"}</h2>
<div class="stats">
  ${stat("Turns", formatNumber(totals.turns), `${formatNumber(totals.steps)} steps`)}
  ${stat("Input tokens", formatNumber(totals.tokens.input), `output ${formatNumber(totals.tokens.output)}`)}
  ${stat("Reasoning tokens", formatNumber(totals.tokens.reasoning), `cache R ${formatNumber(totals.tokens.cacheRead)}`)}
  ${stat("Cache hit rate", htmlMetric(totals.cacheHitRate, formatPercent), `write ${formatNumber(totals.tokens.cacheWrite)}`)}
  ${stat("Cost", htmlMetric(totals.cost, formatCost), "steps + compactions")}
  ${stat("Model time", htmlMetric(totals.modelTime, formatDuration), "created → streamed")}
  ${stat("Tool time", htmlMetric(totals.toolTime, formatDuration), "sum; may overlap")}
  ${stat("Active turn time", htmlMetric(totals.activeTurnTime, formatDuration), `wall ${formatMetricText(totals.wallClockTime, formatDuration)}`)}
  ${stat("Output speed", htmlMetric(totals.outputSpeed, (value) => `${value?.toFixed(1) ?? "—"} tok/s`), "output / model time")}
  ${stat("Errors", formatNumber(totals.errors.total), `${formatNumber(totals.retries)} retries · ${formatNumber(totals.compactions)} compactions`)}
  ${stat("Final context", htmlMetric(totals.finalContext, formatNumber), `cumulative ${formatMetricText(totals.cumulativePrompt, formatNumber)}`)}
  ${stat("Tool calls", formatNumber(totals.toolCalls), `${formatNumber(totals.subagentCalls)} subagent`)}
</div>

<h2>Turns</h2>
<div class="card">
<table>
<thead><tr><th>#</th><th>Trigger</th><th>Start</th><th>Duration</th><th>Model</th><th>Steps</th><th>In</th><th>Out</th><th>Cache R/W</th><th>Hit</th><th>Context latest</th><th>Context cum.</th><th>Δ context</th><th>Model time</th><th>Tool time</th><th>Residual</th><th>Out/s</th><th>Cost</th><th>Status</th></tr></thead>
<tbody>${turnRows}</tbody>
</table>
</div>

<h2>Turns and steps</h2>
${turnSections || `<p class="muted">No turns recorded.</p>`}

${analysis.compactions.length > 0 ? `<h2>Compactions</h2><div class="card"><table><thead><tr><th>Time</th><th>Status</th><th>Reason</th><th>Model</th><th>Before</th><th>After</th><th>Δ</th><th>Removed</th><th>Summary chars</th><th>Output tokens</th><th>Cost</th><th>Duration</th></tr></thead><tbody>${compactionRows}</tbody></table></div>` : ""}

<h2>Trajectory</h2>
${trajectory || `<p class="muted">No events recorded.</p>`}

<h2>Limitations and metric basis</h2>
<ul>${limitations.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
<footer>Generated by ${escapeHtml(input.generator)} · ${escapeHtml(formatDateTime(analysis.generatedAt))}</footer>
</main>
<script>
(() => {
  const theme = document.documentElement;
  const stored = (() => { try { return localStorage.getItem("observability-theme"); } catch { return null; } })();
  if (stored === "light" || stored === "dark") theme.dataset.theme = stored;
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const pre = button.closest("details")?.querySelector("pre");
      if (!pre) return;
      const text = pre.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand("copy"); button.textContent = "Copied"; } catch {}
        area.remove();
      }
      setTimeout(() => { button.textContent = "Copy JSON"; }, 1200);
    });
  }
})();
</script>
</body>
</html>`;
}

function formatMetricText(
  metric: Metric,
  formatter: (value: number | null) => string,
): string {
  return metric.value === null ? "—" : formatter(metric.value);
}
