/**
 * The recovery-map and diagnostics-section builders, ported from
 * `src/ui/app.js:1565-1728` (`recoveryLabel` .. `diagnosticsSectionHtml`).
 *
 * The legacy module produced HTML strings. Here the builders produce a view
 * model of plain strings and the React component renders them as text nodes, so
 * hostile recorded fields can never become markup: there is no HTML sink and no
 * escaping step that could be forgotten. `test/web-diagnostics.test.ts` pins the
 * text verbatim, including the one "Not recorded" style fallback (`—`).
 *
 * Colour never carries a state on its own: every card carries the recovery label
 * as text (`Recovery observed`, `Possible recovery`, `No recovery evidence`,
 * `Insufficient data`, `Unknown`) next to its badge kind, and every stat cell
 * carries its label. The badge kind only picks a token treatment.
 */

import type { DiagnosticIncident, RecoveryState } from "../../core/diagnostics.ts";
import type { Basis, Metric } from "../../core/types.ts";
import { formatCost, formatDuration, formatNumber } from "./format.ts";

export type DiagnosticBadgeKind = "good" | "accent" | "uncertain";

export const RECOVERY_LABELS: Record<RecoveryState | "unknown", string> = Object.freeze({
  recovered: "Recovery observed",
  "possible-recovery": "Possible recovery",
  "no-recovery-evidence": "No recovery evidence",
  "insufficient-data": "Insufficient data",
  unknown: "Unknown",
});

/** DR-2: anything unrecognised reads "Unknown", never a real verdict. */
export function recoveryLabel(state: unknown): string {
  return typeof state === "string" &&
    Object.prototype.hasOwnProperty.call(RECOVERY_LABELS, state)
    ? RECOVERY_LABELS[state as RecoveryState]
    : RECOVERY_LABELS.unknown;
}

/** The badge treatment; the label above stays the only state signal. */
export function recoveryBadgeKind(state: unknown): DiagnosticBadgeKind {
  if (state === "recovered") return "good";
  if (state === "possible-recovery") return "accent";
  return "uncertain";
}

export function basisMark(basis: Basis): string {
  if (basis === "measured") return "M";
  if (basis === "derived") return "D";
  if (basis === "estimated") return "E";
  return "—";
}

export function basisLabel(basis: Basis): string {
  return basis === "unavailable" ? "unavailable" : basis;
}

export interface MetricText {
  text: string;
  basis: Basis;
  mark: string;
  title: string;
}

/** A metric rendered as text plus its provenance mark and tooltip. */
export function metricText(
  metric: Metric | undefined,
  formatter: (value: number) => string,
): MetricText {
  if (!metric || metric.value === null || metric.value === undefined) {
    return {
      text: "—",
      basis: "unavailable",
      mark: "—",
      title: metric?.note ?? "unavailable",
    };
  }
  const basis = metric.basis;
  return {
    text: formatter(metric.value),
    basis,
    mark: basisMark(basis),
    title:
      basis === "measured"
        ? "measured"
        : `${basisLabel(basis)}${metric.note ? `: ${metric.note}` : ""}`,
  };
}

export interface DiagnosticStatModel {
  label: string;
  value: MetricText;
}

export interface DiagnosticCardModel {
  /** Stable list key: the incident's first failing event id. */
  key: string;
  tool: string;
  /** The drill target the component writes to `data-event-id`. */
  eventID: string;
  badge: { label: string; kind: DiagnosticBadgeKind };
  turnText: string;
  triggerLabel: string;
  openLabel: string;
  stats: DiagnosticStatModel[];
  why: string;
  note: string;
}

export const CARD_NOTE =
  "Footprint values are contextual to this incident; they are not a recovery signal.";
export const NO_INCIDENTS_TEXT =
  "No diagnostic incidents recorded in this session.";
export const RECOVERY_MAP_TITLE = "Recovery map";
export const DIAGNOSTICS_SECTION_TITLE = "Diagnostics";

/**
 * A bounded card list keeps a hostile fixture from materialising thousands of
 * DOM nodes at once. The overflow count is stated as text, never dropped
 * silently; the ledger itself has no cap because it is virtualised.
 */
export const MAX_RECOVERY_CARDS = 100;

export interface RecoveryCards {
  cards: DiagnosticCardModel[];
  overflow: { count: number; text: string } | null;
  empty: boolean;
}

export interface RecoveryMapModel extends RecoveryCards {
  title: string;
  countLabel: string;
  note: string;
}

export interface DiagnosticsSectionModel extends RecoveryCards {
  title: string;
  countLabel: string;
  note: string;
}

function incidentCountLabel(count: number): string {
  return `${formatNumber(count)} incident(s) from the deterministic diagnostics engine`;
}

/** `diagnosticCardHtml` (`app.js:1588-1626`) as data. */
export function diagnosticCard(incident: DiagnosticIncident): DiagnosticCardModel {
  const tool = incident.tool || "—";
  const triggerLabel = incident.trigger?.label ?? "—";
  return {
    key: incident.firstFailureEventID,
    tool,
    eventID: incident.firstFailureEventID,
    badge: {
      label: recoveryLabel(incident.recovery),
      kind: recoveryBadgeKind(incident.recovery),
    },
    turnText: `Turn ${formatNumber(incident.turn)}`,
    triggerLabel,
    openLabel: `Open ${tool} incident in Trajectory`,
    stats: [
      {
        label: "Attempts",
        value: metricText(
          { value: incident.attempts, basis: "measured" },
          formatNumber,
        ),
      },
      {
        label: "Elapsed (context)",
        value: metricText(incident.elapsed, formatDuration),
      },
      {
        label: "Step cost sum (context)",
        value: metricText(incident.stepCostSum, formatCost),
      },
    ],
    why: incident.why,
    note: CARD_NOTE,
  };
}

function recoveryCards(incidents: readonly DiagnosticIncident[]): RecoveryCards {
  const shown = incidents.slice(0, MAX_RECOVERY_CARDS);
  const hidden = incidents.length - shown.length;
  return {
    cards: shown.map((incident) => diagnosticCard(incident)),
    overflow:
      hidden > 0
        ? {
            count: hidden,
            text: `${formatNumber(hidden)} further incident(s) are not shown.`,
          }
        : null,
    empty: incidents.length === 0,
  };
}

export function buildRecoveryMap(
  incidents: readonly DiagnosticIncident[],
): RecoveryMapModel {
  return {
    title: RECOVERY_MAP_TITLE,
    countLabel: incidentCountLabel(incidents.length),
    ...recoveryCards(incidents),
    note: NO_INCIDENTS_TEXT,
  };
}

export function buildDiagnosticsSection(
  incidents: readonly DiagnosticIncident[],
): DiagnosticsSectionModel {
  return {
    title: DIAGNOSTICS_SECTION_TITLE,
    countLabel: incidentCountLabel(incidents.length),
    ...recoveryCards(incidents),
    note: NO_INCIDENTS_TEXT,
  };
}

/**
 * The plain-text projection of a section. Used by the contract tests to prove
 * that hostile recorded strings stay literal text (no entity round-trip, no
 * markup) and by nothing in the UI.
 */
export function diagnosticsSectionText(
  section: RecoveryMapModel | DiagnosticsSectionModel,
): string {
  const lines = [section.title, section.countLabel];
  if (section.empty) lines.push(section.note);
  for (const card of section.cards) {
    lines.push(
      `${card.tool} · ${card.badge.label} · ${card.turnText} · ${card.triggerLabel}`,
    );
    for (const stat of card.stats) {
      lines.push(`${stat.label}: ${stat.value.text}${stat.value.mark === "—" ? "" : ` (${stat.value.mark})`}`);
    }
    lines.push(card.why, card.note);
  }
  if (section.overflow) lines.push(section.overflow.text);
  return lines.join("\n");
}

/**
 * The incident anchored at `eventID`, matched only on recorded DTO fields. The
 * UI never derives an incident (`incidentForFirstEvent`, `app.js:1670-1676`).
 */
export function incidentForFirstEvent(
  incidents: readonly DiagnosticIncident[],
  eventID: string | null,
): DiagnosticIncident | null {
  if (!eventID) return null;
  return incidents.find((incident) => incident.firstFailureEventID === eventID) ?? null;
}

/**
 * The highlight set for an opened event: the incident's failure sequence, with
 * unknown ids dropped against the session's event index (`setDiagnosticHighlight`,
 * `app.js:1683-1692`). An id is kept when the index is empty (analysis not yet
 * loaded) and validated once it is.
 */
export function failureHighlight(
  incidents: readonly DiagnosticIncident[],
  eventID: string | null,
  knownEventIDs: ReadonlySet<string>,
): string[] {
  const incident = incidentForFirstEvent(incidents, eventID);
  if (!incident) return [];
  return incident.failureEventIDs.filter(
    (id) => typeof id === "string" && id.length > 0 && (knownEventIDs.size === 0 || knownEventIDs.has(id)),
  );
}
