/**
 * The compaction transaction card model, a pure port of `compactionCardsHtml`
 * (`src/ui/app.js:2039-2089`).
 *
 * Compactions render in both Basic and Advanced Statistics, after Diagnostics,
 * so this builder is mode-independent. Every figure keeps its provenance: a
 * missing context or duration metric stays `—` and is never read as zero.
 */

import type { CompactionTransaction } from "../../core/types.ts";
import { formatCost, formatDateTime, formatDuration, formatNumber } from "./format.ts";
import { metricText, type MetricText } from "./diagnostics.ts";

/** The standing note; fixed copy, independent of the payload. */
export const COMPACTION_NOTE =
  "Compaction is a separate transaction, not a step. Its tokens are included in session totals but excluded from turn/step totals.";

export const NO_COMPACTIONS_TEXT = "No compactions recorded in this session.";

export interface CompactionCardModel {
  key: string;
  title: string;
  status: { label: string; kind: "error" | "compaction" };
  reason: string;
  time: string;
  eventID: string;
  stats: { label: string; value: MetricText }[];
  summaryPreview: string | null;
  note: string;
}

function measured(text: string): MetricText {
  return { text, basis: "measured", mark: "M", title: "measured" };
}

function plainCost(cost: number | null): MetricText {
  if (cost === null || cost === undefined) {
    return { text: "—", basis: "unavailable", mark: "—", title: "unavailable" };
  }
  return { text: formatCost(cost), basis: "measured", mark: "M", title: "measured" };
}

export function compactionStats(item: CompactionTransaction): {
  label: string;
  value: MetricText;
}[] {
  return [
    { label: "Context before", value: metricText(item.contextBefore, formatNumber) },
    { label: "Context after", value: metricText(item.contextAfter, formatNumber) },
    { label: "Removed", value: metricText(item.removedTokens, formatNumber) },
    { label: "Summary", value: measured(`${formatNumber(item.summaryChars)} chars`) },
    { label: "Output tokens", value: measured(formatNumber(item.tokens?.output)) },
    { label: "Cost", value: plainCost(item.cost) },
    { label: "Duration", value: metricText(item.duration, formatDuration) },
  ];
}

export interface CompactionCardsModel {
  cards: CompactionCardModel[];
  emptyNote: string;
}

export function buildCompactionCards(
  compactions: readonly CompactionTransaction[] | null | undefined,
): CompactionCardsModel {
  const items = Array.isArray(compactions) ? compactions : [];
  const cards = items.map((item, index) => ({
    key: item.eventID || `compaction:${index + 1}`,
    title: `Compaction ${index + 1}`,
    status: {
      label: item.status,
      kind: item.status === "failed" ? ("error" as const) : ("compaction" as const),
    },
    reason: item.reason || "unknown",
    time: formatDateTime(item.timestamp),
    eventID: item.eventID,
    stats: compactionStats(item),
    summaryPreview: item.summaryPreview ? item.summaryPreview : null,
    note: COMPACTION_NOTE,
  }));
  return { cards, emptyNote: NO_COMPACTIONS_TEXT };
}
