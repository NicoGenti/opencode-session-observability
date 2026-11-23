/**
 * The advisory guardrail block model, a pure port of `src/ui/guardrails.js`.
 *
 * Guardrails are app-wide, never behind the Advanced gate, and never a verdict:
 * every row keeps its text label, the `derived` basis chip, the `advisory` word
 * and the standing "never blocks anything" line. A budget that could not be
 * evaluated is reported as skipped instead of guessed. The evidence caps come
 * from core.
 */

import type {
  GuardrailSkip,
  GuardrailWarning,
  Guardrails,
} from "../../core/guardrails.ts";
import { MAX_EVENT_LINKS, MAX_TURN_LINKS } from "../../core/health.ts";
import type { Turn } from "../../core/types.ts";
import { formatNumber } from "./format.ts";

export { MAX_EVENT_LINKS, MAX_TURN_LINKS };

/** The standing advisory copy. Fixed, independent of the payload. */
export const GUARDRAIL_ADVISORY_COPY = "advisory — never blocks anything";
export const GUARDRAILS_TITLE = "Guardrails";

/**
 * Budgets may be fractional (cost in dollars, elapsed minutes), so the
 * threshold keeps up to two decimals instead of rounding `$12.75` to `13`.
 */
const BUDGET_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

export function formatBudget(value: number): string {
  return BUDGET_FORMAT.format(value);
}

export interface GuardrailLinkModel {
  key: string;
  label: string;
  eventID: string;
  ariaLabel: string;
}

export interface GuardrailRowModel {
  key: string;
  id: string;
  label: string;
  observed: string;
  threshold: string;
  note: string;
  basisLabel: string;
  advisoryLabel: string;
  links: GuardrailLinkModel[];
}

export interface GuardrailsModel {
  title: string;
  count: number;
  countLabel: string;
  basisLabel: string;
  advisoryCopy: string;
  rows: GuardrailRowModel[];
  skipped: string[];
  skippedNote: string | null;
  empty: boolean;
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

/** `turn.trigger?.eventID ?? turn.eventIDs?.[0]`, the health-breakdown rule. */
function anchorOf(turn: Turn | undefined): string | null {
  const anchor = turn?.trigger?.eventID ?? turn?.eventIDs?.[0] ?? null;
  return typeof anchor === "string" && anchor.length > 0 ? anchor : null;
}

function evidenceLinks(
  warning: GuardrailWarning,
  label: string,
  turnByID: Map<string, Turn>,
  keyPrefix: string,
): GuardrailLinkModel[] {
  const links: GuardrailLinkModel[] = [];
  for (const [position, eventID] of cappedIDs(warning.eventIDs, MAX_EVENT_LINKS).entries()) {
    links.push({
      key: `${keyPrefix}:event:${position}`,
      label: `Event ${position + 1}`,
      eventID,
      ariaLabel: `Open event ${position + 1} of ${label} in Trajectory`,
    });
  }
  for (const turnID of cappedIDs(warning.turnIDs, MAX_TURN_LINKS)) {
    const turn = turnByID.get(turnID);
    const anchor = anchorOf(turn);
    // An id that cannot be opened is never rendered.
    if (!anchor) continue;
    const turnLabel = `Turn ${turn?.index ?? "?"}`;
    links.push({
      key: `${keyPrefix}:turn:${turnID}`,
      label: turnLabel,
      eventID: anchor,
      ariaLabel: `Open ${turnLabel} in Trajectory`,
    });
  }
  return links;
}

function rowModel(
  warning: GuardrailWarning,
  position: number,
  turnByID: Map<string, Turn>,
): GuardrailRowModel | null {
  const label = typeof warning?.label === "string" ? warning.label : "";
  const observed = typeof warning?.observed === "string" ? warning.observed : "";
  if (label.length === 0 || observed.length === 0) return null;
  const id = typeof warning.id === "string" && warning.id ? warning.id : `budget-${position}`;
  const threshold = Number.isFinite(warning.threshold) ? formatBudget(warning.threshold) : "—";
  return {
    key: id,
    id,
    label,
    observed,
    threshold,
    note: `${observed} · budget ${threshold}`,
    basisLabel: "derived",
    advisoryLabel: "advisory",
    links: evidenceLinks(warning, label, turnByID, id),
  };
}

/**
 * An absent, empty or malformed sibling renders nothing; a session under every
 * budget leaves no frame behind.
 */
export function buildGuardrails(
  guardrails: Guardrails | null | undefined,
  turns: readonly Turn[] = [],
): GuardrailsModel {
  const turnByID = new Map<string, Turn>();
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (turn && typeof turn.id === "string") turnByID.set(turn.id, turn);
  }
  const rows: GuardrailRowModel[] = [];
  for (const warning of Array.isArray(guardrails?.warnings) ? guardrails.warnings : []) {
    const model = rowModel(warning, rows.length + 1, turnByID);
    if (model) rows.push(model);
  }
  const skipped = (Array.isArray(guardrails?.skipped) ? guardrails.skipped : [])
    .map((entry: GuardrailSkip) => {
      const label = typeof entry?.label === "string" ? entry.label : "";
      const note = typeof entry?.note === "string" ? entry.note : "";
      return label.length > 0 && note.length > 0 ? `${label}: ${note}` : "";
    })
    .filter((note) => note.length > 0);
  return {
    title: GUARDRAILS_TITLE,
    count: rows.length,
    countLabel: `${formatNumber(rows.length)} advisory`,
    basisLabel: "basis derived",
    advisoryCopy: GUARDRAIL_ADVISORY_COPY,
    rows,
    skipped,
    skippedNote:
      skipped.length > 0 ? `Not evaluated — ${skipped.join(" · ")}` : null,
    empty: rows.length === 0 && skipped.length === 0,
  };
}
