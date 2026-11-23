/**
 * The recommendations model, a pure port of `src/ui/recommendations.js`.
 *
 * Nothing is re-derived: every row arrives with its kind, label, note and
 * evidence ids. Fact and hypothesis stay structurally distinct, rows keep the
 * DTO's fixed rule order, and the row/evidence caps come from core so the UI
 * cannot print a row the evaluator could not have produced.
 */

import {
  MAX_RECOMMENDATION_ROWS,
  type Recommendation,
  type Recommendations,
} from "../../core/recommendations.ts";
import { MAX_EVENT_LINKS } from "../../core/health.ts";
import { formatNumber } from "./format.ts";

export { MAX_RECOMMENDATION_ROWS, MAX_EVENT_LINKS };

/** The standing hypothesis copy. Fixed, independent of the payload. */
export const HYPOTHESIS_DISCLAIMER = "hypothesis — not a diagnosis";

export const RECOMMENDATIONS_STANDING_NOTE =
  "Local and deterministic — derived from recorded data, never ranked.";

export const RECOMMENDATIONS_TITLE = "Recommendations";

/** The analysis layer each rule reads (`recommendations.js:35-42`). */
export const SOURCE_BY_RULE: Readonly<Record<string, string>> = Object.freeze({
  "reduce-context": "health",
  "retry-failed-tool": "diagnostics",
  "split-task": "turns",
  "reuse-subagent": "totals",
  "avoid-unnecessary-compaction": "compactions",
  "concentrated-file-cost": "attribution",
});

export interface RecommendationLinkModel {
  key: string;
  label: string;
  eventID: string;
  ariaLabel: string;
}

export interface RecommendationRowModel {
  key: string;
  ruleID: string;
  kind: "fact" | "hypothesis";
  kindLabel: "Fact" | "Hypothesis";
  label: string;
  note: string;
  source: string;
  disclaimer: string | null;
  links: RecommendationLinkModel[];
}

export interface RecommendationsModel {
  title: string;
  facts: number;
  hypotheses: number;
  counts: string;
  rail: string;
  standingNote: string;
  rows: RecommendationRowModel[];
  notes: string[];
  empty: boolean;
}

function sourceOf(ruleID: string): string {
  return SOURCE_BY_RULE[ruleID] ?? "analysis";
}

function cappedIDs(ids: readonly string[] | undefined, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function links(ids: readonly string[] | undefined, label: string, keyPrefix: string): RecommendationLinkModel[] {
  return cappedIDs(ids, MAX_EVENT_LINKS).map((eventID, position) => ({
    key: `${keyPrefix}:event:${position}`,
    label: `Event ${position + 1}`,
    eventID,
    ariaLabel: `Open event ${position + 1} of ${label} in Trajectory`,
  }));
}

function countLabel(count: number, noun: "fact" | "hypothesis"): string {
  const plural = noun === "hypothesis" ? "hypotheses" : "facts";
  return `${formatNumber(count)} ${count === 1 ? noun : plural}`;
}

function rowModel(row: Recommendation, position: number): RecommendationRowModel | null {
  const label = typeof row?.label === "string" ? row.label : "";
  const note = typeof row?.note === "string" ? row.note : "";
  if (label.length === 0 || note.length === 0) return null;
  const kind = row.kind === "hypothesis" ? "hypothesis" : "fact";
  const ruleID = typeof row.ruleID === "string" ? row.ruleID : "";
  const source = sourceOf(ruleID);
  return {
    key: `${ruleID}:${kind}:${position}`,
    ruleID,
    kind,
    kindLabel: kind === "fact" ? "Fact" : "Hypothesis",
    label,
    note,
    source,
    disclaimer: kind === "hypothesis" ? HYPOTHESIS_DISCLAIMER : null,
    links: links(row.eventIDs, `recommendation ${position}`, `${ruleID}:${kind}:${position}`),
  };
}

/**
 * An absent, empty or malformed rider renders nothing. Rows that cannot render
 * are skipped before the counts and the rail are built, so the header never
 * claims a row the section does not show.
 */
export function buildRecommendations(
  recommendations: Recommendations | null | undefined,
): RecommendationsModel {
  const sourceRows = (Array.isArray(recommendations?.rows)
    ? recommendations.rows
    : []
  ).slice(0, MAX_RECOMMENDATION_ROWS);
  const rows: RecommendationRowModel[] = [];
  const sources: string[] = [];
  let facts = 0;
  let hypotheses = 0;
  for (const row of sourceRows) {
    const model = rowModel(row, rows.length + 1);
    if (!model) continue;
    rows.push(model);
    if (model.kind === "hypothesis") hypotheses += 1;
    else facts += 1;
    if (!sources.includes(model.source)) sources.push(model.source);
  }
  const notes = (
    Array.isArray(recommendations?.basisNotes) ? recommendations.basisNotes : []
  ).filter((note): note is string => typeof note === "string" && note.length > 0);
  return {
    title: RECOMMENDATIONS_TITLE,
    facts,
    hypotheses,
    counts: `${countLabel(facts, "fact")} · ${countLabel(hypotheses, "hypothesis")}`,
    rail: sources.length > 0 ? `Sources — ${sources.join(" · ")}` : "Sources — analysis",
    standingNote: RECOMMENDATIONS_STANDING_NOTE,
    rows,
    notes,
    empty: rows.length === 0,
  };
}
