/**
 * The episode-comparison model and its keyboard navigation, a pure port of the
 * compare block in `src/ui/app.js` (`:3486-3562` copy and row definitions,
 * `:3711-3762` opening and request semantics, `:3801-4016` rendering model and
 * arrow-key movement, `:4480-4510` the key handler).
 *
 * The comparison payload is descriptive: every difference is `left − right`,
 * no attempt is designated as better, and a verdict is always a word. The
 * component only renders what this module derives.
 */

import type {
  EpisodeComparison,
  TotalsDelta,
  TurnDelta,
  TurnSummary,
} from "../../core/episodeCompare.ts";
import type { AlignedAttempt, EpisodeTotals } from "../../core/episodeCompare.ts";
import type { InputComparability, SimilarityVerdict } from "../../core/diagnostics.ts";
import type { DiagnosticEpisode } from "../../core/episodes.ts";
import type { SessionFamily, SessionSummary } from "../../core/types.ts";
import {
  formatCost,
  formatDuration,
  formatNumber,
  formatPercent,
} from "./format.ts";

/** The compare modal's deliberate width exception (`docs/UI.md:333`). */
export const COMPARE_CARD_WIDTH = 960;

export const COMPARE_TITLE = "Compare episodes";
export const COMPARE_BANNER =
  "Differences are reported descriptively. No attempt is designated as better.";
export const COMPARE_KEYS_HINT =
  "Esc closes · Tab moves · ↑/↓ select an alignment row · ←/→ move between left and right inputs";
export const COMPARE_NO_EPISODES = "No diagnostic episodes were recorded in this session.";
export const COMPARE_NO_ALIGNMENT = "No attempts were aligned for this pair.";
export const COMPARE_LOADING = "Loading comparison…";
export const COMPARE_TOKEN_INCOMPLETE =
  "Token counts are incomplete on at least one side; token differences are unavailable.";

/** The picker placeholders (`app.js:3586-3616`). */
export const EPISODE_SELECT_FIRST = "Select a session first";
export const EPISODE_LOADING = "Loading episodes…";
export const EPISODE_UNAVAILABLE = "Episodes unavailable";
export const EPISODE_NONE = "No episodes recorded";
export const EPISODE_PLACEHOLDER = "Select an episode…";

export type CompareSide = "left" | "right";

/** A formatting function for one metric cell. */
export type MetricFormatter = (value: number) => string;

export const COMPARE_FORMATTERS = Object.freeze({
  cost: formatCost,
  duration: formatDuration,
  number: formatNumber,
  percent: formatPercent,
  speed: (value: number) => `${value.toFixed(1)} tok/s`,
});

/** One metric row: label, key on the payload, formatter (`app.js:3493-3517`). */
export interface CompareMetricRow {
  label: string;
  key: string;
  formatter: MetricFormatter;
}

/** The session-totals rows; `totalTime` is the session's active turn time. */
export function compareSessionTotalRows(): CompareMetricRow[] {
  return [
    { label: "Cost", key: "cost", formatter: formatCost },
    { label: "Model time", key: "modelTime", formatter: formatDuration },
    { label: "Tool time", key: "toolTime", formatter: formatDuration },
    { label: "Active turn time", key: "totalTime", formatter: formatDuration },
    { label: "Output speed", key: "outputSpeed", formatter: COMPARE_FORMATTERS.speed },
    { label: "Cache hit rate", key: "cacheHitRate", formatter: formatPercent },
  ];
}

/** The turn rows: the same six plus the latest prompt size. */
export function compareTurnRows(): CompareMetricRow[] {
  return [
    { label: "Cost", key: "cost", formatter: formatCost },
    { label: "Model time", key: "modelTime", formatter: formatDuration },
    { label: "Tool time", key: "toolTime", formatter: formatDuration },
    { label: "Total time", key: "totalTime", formatter: formatDuration },
    { label: "Output speed", key: "outputSpeed", formatter: COMPARE_FORMATTERS.speed },
    { label: "Cache hit rate", key: "cacheHitRate", formatter: formatPercent },
    { label: "Prompt tokens (latest)", key: "promptTokensLatest", formatter: formatNumber },
  ];
}

export const COMPARE_TOKEN_ROWS: readonly { label: string; key: string }[] = Object.freeze([
  Object.freeze({ label: "Input", key: "input" }),
  Object.freeze({ label: "Output", key: "output" }),
  Object.freeze({ label: "Reasoning", key: "reasoning" }),
  Object.freeze({ label: "Cache read", key: "cacheRead" }),
  Object.freeze({ label: "Cache write", key: "cacheWrite" }),
]);

/** Kebab verdict tokens become sentence-case display labels (`app.js:3520-3523`). */
export function tokenLabel(value: unknown): string {
  const text = String(value ?? "unknown").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The comparability flags a row can carry (`app.js:3813-3823`). */
export function comparabilityLabel(
  comparability: InputComparability | null | undefined,
): string | null {
  if (!comparability || comparability === "comparable") return null;
  if (comparability === "absent") return "absent input";
  if (comparability === "truncated") return "truncated input";
  if (comparability === "redacted") return "redacted input";
  return `${comparability} input`;
}

/** The input pre's text: strings verbatim, everything else pretty JSON. */
export function compareInputText(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export interface CompareSessionOption {
  id: string;
  label: string;
}

/** The session fields the pickers read; both `SessionMeta` and `SessionSummary` fit. */
export type CompareSessionRecord = Pick<SessionSummary, "id" | "title" | "slug">;

/**
 * The session pickers' options (`app.js:3534-3553`): the current session, its
 * parent, then its children, de-duplicated; the current one is marked.
 */
export function compareSessionOptions(input: {
  session: CompareSessionRecord | null | undefined;
  family: SessionFamily | null | undefined;
  currentSessionID: string | null | undefined;
}): CompareSessionOption[] {
  const options: CompareSessionOption[] = [];
  const seen = new Set<string>();
  const add = (session: CompareSessionRecord | null | undefined): void => {
    if (!session?.id || seen.has(session.id)) return;
    seen.add(session.id);
    const title = session.title || session.slug || session.id;
    options.push({
      id: session.id,
      label: session.id === input.currentSessionID ? `${title} (current)` : title,
    });
  };
  add(input.session);
  add(input.family?.parent ?? null);
  for (const child of input.family?.children ?? []) add(child);
  if (options.length === 0 && input.currentSessionID) {
    options.push({
      id: input.currentSessionID,
      label: `${input.currentSessionID} (current)`,
    });
  }
  return options;
}

/** One episode's picker label (`app.js:3555-3562`). */
export function episodeLabel(episode: DiagnosticEpisode): string {
  const attempts = `${formatNumber(episode.attemptCount)} ${
    episode.attemptCount === 1 ? "attempt" : "attempts"
  }`;
  return `turn #${formatNumber(episode.turnIndex)} · ${episode.tool} · ${attempts} · ${tokenLabel(
    episode.recovery,
  )}`;
}

export interface EpisodeSelectState {
  label: string;
  disabled: boolean;
}

/** The episode picker's four states, in precedence order (`app.js:3582-3617`). */
export function episodeSelectState(side: {
  sessionID: string | null;
  loading: boolean;
  error: string | null;
  episodes: readonly DiagnosticEpisode[];
}): EpisodeSelectState {
  if (!side.sessionID) return { label: EPISODE_SELECT_FIRST, disabled: true };
  if (side.loading) return { label: EPISODE_LOADING, disabled: true };
  if (side.error) return { label: EPISODE_UNAVAILABLE, disabled: true };
  if (side.episodes.length === 0) return { label: EPISODE_NONE, disabled: true };
  return { label: EPISODE_PLACEHOLDER, disabled: false };
}

/** The side's status line, if any (`app.js:3619-3636`). */
export function compareStatusMessages(sides: {
  left: { sessionID: string | null; loading: boolean; error: string | null; episodes: readonly unknown[] };
  right: { sessionID: string | null; loading: boolean; error: string | null; episodes: readonly unknown[] };
}): { message: string; error: boolean } {
  const messages: string[] = [];
  let error = false;
  for (const name of ["left", "right"] as const) {
    const side = sides[name];
    if (!side.sessionID) continue;
    if (side.error) {
      messages.push(`${tokenLabel(name)} session: ${side.error}`);
      error = true;
    } else if (!side.loading && side.episodes.length === 0) {
      messages.push(`${tokenLabel(name)} session: ${COMPARE_NO_EPISODES}`);
    }
  }
  return { message: messages.join(" "), error };
}

/** The comparison request path (`app.js:3764-3779`). */
export function compareApiPath(input: {
  leftSession: string;
  leftEpisode: string;
  rightSession: string;
  rightEpisode: string;
}): string {
  const params = new URLSearchParams({
    leftSession: input.leftSession,
    leftEpisode: input.leftEpisode,
    rightSession: input.rightSession,
    rightEpisode: input.rightEpisode,
  });
  return `/api/episodes/compare?${params.toString()}`;
}

/** True when both sides carry a session and an episode. */
export function compareReady(sides: {
  left: { sessionID: string | null; episodeID: string | null };
  right: { sessionID: string | null; episodeID: string | null };
}): boolean {
  return Boolean(
    sides.left.sessionID &&
      sides.left.episodeID &&
      sides.right.sessionID &&
      sides.right.episodeID,
  );
}

export interface CompareIdentityRow {
  label: string;
  value: string;
}

/** The identity block of one side (`app.js:3867-3880`). */
export function compareIdentityRows(
  descriptor: EpisodeComparison["left"] | null | undefined,
): CompareIdentityRow[] {
  if (!descriptor) return [];
  return [
    { label: "Session", value: descriptor.sessionID },
    { label: "Turn", value: `#${formatNumber(descriptor.turnIndex)}` },
    { label: "Tool", value: descriptor.tool },
    { label: "Attempts", value: formatNumber(descriptor.attemptCount) },
    { label: "Recovery", value: tokenLabel(descriptor.recovery) },
    { label: "Similarity", value: tokenLabel(descriptor.similarity) },
  ];
}

/** One alignment row as the table renders it. */
export interface AlignmentRowModel {
  index: number;
  kind: string;
  presence: string;
  leftStatus: string | null;
  leftDuration: string;
  leftFlag: string | null;
  leftInput: string | null;
  rightStatus: string | null;
  rightDuration: string;
  rightFlag: string | null;
  rightInput: string | null;
  latencyDelta: string;
  similarity: string;
  overlap: string | null;
}

function attemptModel(
  attempt: AlignedAttempt["left"],
  comparability: InputComparability | null | undefined,
): {
  status: string | null;
  duration: string;
  flag: string | null;
  input: string | null;
} {
  if (!attempt) {
    return { status: null, duration: "—", flag: null, input: null };
  }
  return {
    status: attempt.status,
    duration: attempt.duration.value === null ? "—" : formatDuration(attempt.duration.value),
    flag: comparabilityLabel(comparability),
    input: compareInputText(attempt.input),
  };
}

/** Builds the alignment table's row models (`app.js:3811-3864`). */
export function alignmentRows(
  comparison: EpisodeComparison | null | undefined,
): AlignmentRowModel[] {
  const alignment = Array.isArray(comparison?.alignment) ? comparison.alignment : [];
  return alignment.map((row) => {
    const left = attemptModel(row.left, row.inputComparability?.left);
    const right = attemptModel(row.right, row.inputComparability?.right);
    return {
      index: row.index,
      kind: tokenLabel(row.kind),
      presence: tokenLabel(row.presence),
      leftStatus: left.status,
      leftDuration: left.duration,
      leftFlag: left.flag,
      leftInput: left.input,
      rightStatus: right.status,
      rightDuration: right.duration,
      rightFlag: right.flag,
      rightInput: right.input,
      latencyDelta: row.latencyDelta.value === null ? "—" : formatDuration(row.latencyDelta.value),
      similarity: tokenLabel(row.inputSimilarity),
      overlap:
        typeof row.inputOverlap === "number" ? `overlap ${formatPercent(row.inputOverlap)}` : null,
    };
  });
}

/** A metric cell: the formatted value and its provenance note, or `null`. */
export function metricCell(
  metric: { value: number | null; basis?: string; note?: string } | null | undefined,
  formatter: MetricFormatter,
): { text: string; title: string | null; available: boolean; mark: string | null } {
  if (!metric || metric.value === null || metric.value === undefined) {
    return { text: "—", title: metric?.note ?? "unavailable", available: false, mark: null };
  }
  const basis = metric.basis && metric.basis !== "measured" ? metric.basis : "";
  // A measured value with no note carries no tooltip, matching `metricHtml`.
  const title = basis || metric.note ? `${basis || "measured"}${metric.note ? `: ${metric.note}` : ""}` : null;
  const mark = basis === "derived" ? "D" : basis === "estimated" ? "E" : basis === "unavailable" ? "—" : null;
  return { text: formatter(metric.value), title, available: true, mark };
}

/** One metric cell, as `metricCell` builds it. */
export type MetricCellModel = ReturnType<typeof metricCell>;

/** One metric table row across left, right and delta. */
export interface CompareMetricCellRow {
  label: string;
  left: MetricCellModel;
  right: MetricCellModel;
  delta: MetricCellModel;
}

/** Builds a metric table body (`app.js:3882-3896`). */
export function compareMetricRows(
  rows: readonly CompareMetricRow[],
  section:
    | { left: EpisodeTotals; right: EpisodeTotals; delta: TotalsDelta | TurnDelta }
    | null
    | undefined,
): CompareMetricCellRow[] {
  const left = (section?.left ?? {}) as unknown as Record<string, { value: number | null } | undefined>;
  const right = (section?.right ?? {}) as unknown as Record<string, { value: number | null } | undefined>;
  const delta = (section?.delta ?? {}) as unknown as Record<string, { value: number | null } | undefined>;
  return rows.map((row) => ({
    label: row.label,
    left: metricCell(left[row.key], row.formatter),
    right: metricCell(right[row.key], row.formatter),
    delta: metricCell(delta[row.key], row.formatter),
  }));
}

/** One token table row across left, right and delta. */
export interface CompareTokenCellRow {
  label: string;
  left: string;
  right: string;
  delta: string;
}

/** Builds a token table body (`app.js:3898-3910`). */
export function compareTokenRows(
  section:
    | { left: EpisodeTotals; right: EpisodeTotals; delta: TotalsDelta | TurnDelta }
    | null
    | undefined,
): CompareTokenCellRow[] {
  const left = section?.left?.tokens;
  const right = section?.right?.tokens;
  const delta = section?.delta?.tokens;
  return COMPARE_TOKEN_ROWS.map((row) => {
    const key = row.key as keyof NonNullable<typeof left>;
    return {
      label: row.label,
      left: formatNumber(left?.[key] ?? null),
      right: formatNumber(right?.[key] ?? null),
      delta: formatNumber(delta?.[key]?.value ?? null),
    };
  });
}

/** The incomplete-token note for one section (`app.js:3912-3917`). */
export function tokenIncompleteNote(
  section: { left: EpisodeTotals; right: EpisodeTotals } | null | undefined,
): string {
  if (section?.left?.tokensComplete !== false && section?.right?.tokensComplete !== false) {
    return "";
  }
  return COMPARE_TOKEN_INCOMPLETE;
}

/** The turn-table caption (`app.js:3940-3942`). */
export function turnCaption(comparison: EpisodeComparison | null | undefined): string {
  const index: number | null =
    (comparison?.turn?.left as TurnSummary | undefined)?.index ??
    comparison?.left?.turnIndex ??
    null;
  return index === null ? "Turn metrics" : `Turn #${formatNumber(index)} metrics`;
}

/** The two identity headings, in reading order. */
export const COMPARE_SIDES: readonly { side: CompareSide; label: string }[] = Object.freeze([
  Object.freeze({ side: "left", label: "Left" }),
  Object.freeze({ side: "right", label: "Right" }),
]);

/** What one key press asks the modal to do. */
export type CompareKeyIntent =
  | { kind: "close" }
  | { kind: "trap-focus" }
  | { kind: "move"; delta: 1 | -1; preventDefault: true }
  | { kind: "focus-input"; side: CompareSide; preventDefault: true }
  | { kind: "native" }
  | { kind: "ignore" };

const TYPING_TAGS: ReadonlySet<string> = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/**
 * The compare modal's key handler (`app.js:4480-4510`). Escape closes, Tab is
 * left to the focus trap, arrow keys keep their native behaviour while a
 * select, input or textarea has focus, and otherwise ↑/↓ move the alignment
 * selection while ←/→ move between the selected row's input blocks. Every arrow
 * that the modal handles sets `preventDefault` so the page never scrolls.
 */
export function compareKeyIntent(
  key: string,
  context: { typing: boolean; hasRows: boolean },
): CompareKeyIntent {
  if (key === "Escape") return { kind: "close" };
  if (key === "Tab") return { kind: "trap-focus" };
  if (context.typing) return { kind: "native" };
  if (key === "ArrowDown") {
    return context.hasRows
      ? { kind: "move", delta: 1, preventDefault: true }
      : { kind: "ignore" };
  }
  if (key === "ArrowUp") {
    return context.hasRows
      ? { kind: "move", delta: -1, preventDefault: true }
      : { kind: "ignore" };
  }
  if (key === "ArrowLeft") return { kind: "focus-input", side: "left", preventDefault: true };
  if (key === "ArrowRight") return { kind: "focus-input", side: "right", preventDefault: true };
  return { kind: "ignore" };
}

/** True when the event target is a text field or a select (`app.js:4491-4497`). */
export function isTypingTarget(target: {
  tagName?: string;
  isContentEditable?: boolean;
} | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  return TYPING_TAGS.has(target.tagName ?? "");
}

/**
 * Moves the alignment selection with wraparound (`app.js:3993-4016`). A row
 * count of zero keeps the selection at 0.
 */
export function nextCompareSelection(index: number, rowCount: number, delta: number): number {
  if (rowCount <= 0) return 0;
  return ((index + delta) % rowCount + rowCount) % rowCount;
}
