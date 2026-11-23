/**
 * The Session health display model, a pure port of `src/ui/health.js`.
 *
 * The evaluator, its thresholds and the sufficiency gate live in core
 * (`src/core/health.ts`); this module only mirrors the stored DTO into the
 * strings the Advanced Statistics badge and breakdown render. Missing health
 * becomes `Watch` with an explicit "insufficient data" sub-label — never a bare
 * healthy state — and the caps are imported from core so the UI cannot drift.
 */

import {
  MAX_EVENT_LINKS,
  MAX_TURN_LINKS,
  type HealthRuleLevel,
  type HealthRuleResult,
  type HealthState,
  type SessionHealth,
} from "../../core/health.ts";
import type { Turn } from "../../core/types.ts";

export { MAX_EVENT_LINKS, MAX_TURN_LINKS };

export const HEALTH_BREAKDOWN_ID = "health-breakdown";

/** The standing copy: a derived signal, never a quality judgment or a score. */
export const HEALTH_DISCLAIMER =
  "Derived signal from recorded observability data — not a quality judgment.";

export const HEALTH_TOGGLE_HINT = `${HEALTH_DISCLAIMER} Select to see the rules.`;

export const HEALTH_INSUFFICIENT_COPY =
  "Insufficient data: these rules were recorded, but they cannot claim a healthy session.";

export const HEALTH_STATE_COPY: Readonly<Record<HealthState, string>> = Object.freeze({
  healthy: "Healthy",
  watch: "Watch",
  degraded: "Degraded",
});

export const HEALTH_LEVEL_COPY: Readonly<Record<HealthRuleLevel, string>> = Object.freeze({
  watch: "Watch",
  strong: "Strong",
});

export interface HealthBadgeModel {
  state: HealthState;
  word: string;
  insufficient: boolean;
  subLabel: string | null;
  ariaLabel: string;
  title: string;
}

/**
 * The shape rendered when `analysis.health` is absent (`health.js:58`): watch
 * with an explicit insufficient-data sub-label, never a bare healthy badge.
 */
export function missingHealth(): SessionHealth {
  return {
    state: "watch",
    insufficient: true,
    insufficientReasons: ["session health was not evaluated for this analysis"],
    rules: [],
    triggeredCount: 0,
  };
}

interface PresentedHealth {
  state: HealthState;
  word: string;
  insufficient: boolean;
  reasons: string[];
  rules: HealthRuleResult[];
}

/** Insufficiency forces the attention wording (`health.js:39-52`). */
function presented(health: SessionHealth | null | undefined): PresentedHealth {
  const record = health ?? missingHealth();
  const insufficient = record.insufficient === true;
  const known =
    record.state === "healthy" ||
    record.state === "watch" ||
    record.state === "degraded";
  const state: HealthState = insufficient ? "watch" : known ? record.state : "watch";
  return {
    state,
    word: HEALTH_STATE_COPY[state],
    insufficient,
    reasons:
      insufficient && Array.isArray(record.insufficientReasons)
        ? record.insufficientReasons
        : [],
    rules: Array.isArray(record.rules) ? record.rules : [],
  };
}

export function buildHealthBadge(
  health: SessionHealth | null | undefined,
): HealthBadgeModel {
  const view = presented(health);
  return {
    state: view.state,
    word: view.word,
    insufficient: view.insufficient,
    subLabel: view.insufficient ? "insufficient data" : null,
    ariaLabel: `${HEALTH_TOGGLE_HINT} Session health: ${view.word}${
      view.insufficient ? " — insufficient data" : ""
    }.`,
    title: HEALTH_TOGGLE_HINT,
  };
}

/** Capped, de-duplicated ids: the cap applies to what is rendered. */
export function capIDs(ids: unknown, limit: number): string[] {
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

export interface HealthLinkModel {
  key: string;
  label: string;
  eventID: string;
  ariaLabel: string;
}

export interface HealthRuleModel {
  id: string;
  label: string;
  level: HealthRuleLevel | null;
  levelLabel: string | null;
  statusLabel: "Triggered" | "Not triggered" | "Not evaluable";
  note: string;
  links: HealthLinkModel[];
}

function ruleStatus(rule: HealthRuleResult | undefined): HealthRuleModel["statusLabel"] {
  if (rule?.evaluable === false) return "Not evaluable";
  return rule?.triggered ? "Triggered" : "Not triggered";
}

function ruleLinks(rule: Partial<HealthRuleResult> | undefined, turnByID: Map<string, Turn>): HealthLinkModel[] {
  const links: HealthLinkModel[] = [];
  for (const [position, eventID] of capIDs(rule?.eventIDs, MAX_EVENT_LINKS).entries()) {
    links.push({
      key: `event:${eventID}:${position}`,
      label: `Event ${position + 1}`,
      eventID,
      ariaLabel: `Open event ${eventID} in Trajectory`,
    });
  }
  for (const turnID of capIDs(rule?.turnIDs, MAX_TURN_LINKS)) {
    const turn = turnByID.get(turnID);
    // Charts precedent: the trigger event, then any turn event. No anchor means
    // no link — an id that cannot be opened is never rendered.
    const anchor = turn?.trigger?.eventID ?? turn?.eventIDs?.[0] ?? null;
    if (!anchor) continue;
    const label = `Turn ${turn?.index ?? "?"}`;
    links.push({
      key: `turn:${turnID}`,
      label,
      eventID: anchor,
      ariaLabel: `Open ${label} in Trajectory`,
    });
  }
  return links;
}

export interface HealthBreakdownModel {
  state: HealthState;
  word: string;
  insufficient: boolean;
  reasons: string[];
  rules: HealthRuleModel[];
  disclaimer: string;
}

export function buildHealthBreakdown(
  health: SessionHealth | null | undefined,
  turns: readonly Turn[] = [],
): HealthBreakdownModel {
  const view = presented(health);
  const turnByID = new Map<string, Turn>();
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (turn && typeof turn.id === "string") turnByID.set(turn.id, turn);
  }
  return {
    state: view.state,
    word: view.word,
    insufficient: view.insufficient,
    reasons: view.reasons,
    rules: view.rules.map((rule, position) => {
      const level =
        rule?.level === "watch" || rule?.level === "strong" ? rule.level : null;
      return {
        id: rule?.id ?? `rule-${position}`,
        label: rule?.label ?? "Rule",
        level,
        levelLabel: level ? HEALTH_LEVEL_COPY[level] : null,
        statusLabel: ruleStatus(rule),
        note: rule?.note ?? "",
        links: ruleLinks(rule, turnByID),
      };
    }),
    disclaimer: HEALTH_DISCLAIMER,
  };
}
