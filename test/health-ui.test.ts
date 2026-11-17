import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// @ts-expect-error - plain browser module without type declarations
import { healthBadgeHtml, healthBreakdownHtml, missingHealth } from "../src/ui/health.js";

const DISCLAIMER =
  "Derived signal from recorded observability data — not a quality judgment.";

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

async function healthSource(): Promise<string> {
  return readFile(new URL("../src/ui/health.js", import.meta.url), "utf8");
}

async function styleSource(): Promise<string> {
  return readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8");
}

/** Body of one top-level function, up to the next top-level declaration. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const next = source.indexOf("\nfunction ", start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Fixtures in the shape produced by src/core/health.ts
// ---------------------------------------------------------------------------

interface RuleFixture {
  id: string;
  label: string;
  triggered: boolean;
  level: "watch" | "strong" | null;
  evaluable: boolean;
  note: string;
  eventIDs: string[];
  turnIDs: string[];
}

function rule(overrides: Partial<RuleFixture> = {}): RuleFixture {
  return {
    id: "error-rate",
    label: "Error rate",
    triggered: false,
    level: null,
    evaluable: true,
    note: "2 error(s) across 40 step(s); rate 0.05",
    eventIDs: [],
    turnIDs: [],
    ...overrides,
  };
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    state: "healthy",
    insufficient: false,
    insufficientReasons: [],
    rules: [rule()],
    triggeredCount: 0,
    ...overrides,
  };
}

const TURNS = [
  { id: "trn_1", index: 1, trigger: { eventID: "evt_turn_1" }, eventIDs: ["evt_step_1"] },
  { id: "trn_2", index: 2, trigger: { eventID: null }, eventIDs: ["evt_step_2"] },
  { id: "trn_3", index: 3, trigger: {}, eventIDs: [] },
];

function eventLinks(markup: string): string[] {
  return [...markup.matchAll(/data-event-id="([^"]*)"/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

test("the three states render distinct sentence-case badge text", () => {
  const healthy = healthBadgeHtml(health({ state: "healthy" }));
  const watch = healthBadgeHtml(health({ state: "watch", rules: [rule({ triggered: true, level: "watch" })] }));
  const degraded = healthBadgeHtml(health({ state: "degraded", rules: [rule({ triggered: true, level: "strong" })] }));
  assert.match(healthy, />Session health: Healthy</);
  assert.match(watch, />Session health: Watch</);
  assert.match(degraded, />Session health: Degraded</);
  assert.notEqual(healthy, watch);
  assert.notEqual(watch, degraded);
  assert.notEqual(healthy, degraded);
});

test("the badge is a toggle button that carries aria state", () => {
  const closed = healthBadgeHtml(health(), false);
  const open = healthBadgeHtml(health(), true);
  assert.match(closed, /^<button type="button"/);
  assert.match(closed, /data-health-toggle/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(closed, /aria-controls="health-breakdown"/);
});

test("colour never carries state alone: every badge keeps its text label", () => {
  for (const state of ["healthy", "watch", "degraded"]) {
    const markup = healthBadgeHtml(health({ state }));
    assert.match(markup, new RegExp(`health-badge-${state}`));
    assert.match(markup, /health-badge-state/);
    assert.match(markup, /Session health: /);
  }
});

test("insufficient data reads as Watch, never Healthy, with the dashed treatment", () => {
  const markup = healthBadgeHtml(
    health({ state: "watch", insufficient: true, insufficientReasons: ["no turns were recorded"] }),
  );
  assert.match(markup, /Session health: Watch/);
  assert.doesNotMatch(markup, /Healthy/);
  assert.match(markup, /insufficient data/);
  assert.match(markup, /health-badge-watch/);
  assert.match(markup, /health-badge-insufficient/);
});

test("a missing health DTO renders the watch/insufficient shape", () => {
  const fallback = missingHealth();
  assert.equal(fallback.state, "watch");
  assert.equal(fallback.insufficient, true);
  assert.ok(fallback.insufficientReasons.length > 0);
  assert.deepEqual(fallback.rules, []);
  assert.equal(fallback.triggeredCount, 0);

  const badge = healthBadgeHtml(null);
  assert.match(badge, /Session health: Watch/);
  assert.match(badge, /insufficient data/);
  assert.doesNotMatch(badge, /Healthy/);
  const breakdown = healthBreakdownHtml(null, []);
  assert.match(breakdown, /session health was not evaluated/);
  assert.match(breakdown, /No rule was evaluated/);
});

test("badge and breakdown both carry the standing disclaimer", () => {
  const badge = healthBadgeHtml(health({ state: "watch" }));
  assert.ok(badge.includes(DISCLAIMER));
  const breakdown = healthBreakdownHtml(health({ state: "watch" }), TURNS);
  assert.ok(breakdown.includes(DISCLAIMER));
  assert.match(breakdown, /health-disclaimer/);
  assert.doesNotMatch(badge, /score/i);
  assert.doesNotMatch(breakdown, /score/i);
});

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

test("every rule keeps its label, level badge and observed-values note", () => {
  const markup = healthBreakdownHtml(
    health({
      state: "degraded",
      rules: [
        rule({ id: "error-rate", label: "Error rate", triggered: true, level: "strong", note: "7 error(s) across 20 step(s); rate 0.35" }),
        rule({ id: "retry-count", label: "Retry count", triggered: true, level: "watch", note: "8 retry event(s) recorded" }),
        rule({ id: "context-growth", label: "Context growth", note: "longest growth run 2 turn(s); final context 90000" }),
        rule({ id: "cost-per-turn", label: "Cost per turn", evaluable: false, note: "cost was not recorded" }),
      ],
      triggeredCount: 2,
    }),
    TURNS,
  );
  assert.match(markup, /Error rate/);
  assert.match(markup, /Retry count/);
  assert.match(markup, /Cost per turn/);
  assert.match(markup, /health-level-strong">Strong</);
  assert.match(markup, /health-level-watch">Watch</);
  assert.match(markup, />Triggered</);
  assert.match(markup, />Not triggered</);
  assert.match(markup, />Not evaluable</);
  assert.match(markup, /7 error\(s\) across 20 step\(s\); rate 0\.35/);
  assert.match(markup, /cost was not recorded/);
});

test("turn links use the trigger event, then the first turn event, and skip turns without an anchor", () => {
  const markup = healthBreakdownHtml(
    health({
      rules: [
        rule({
          id: "context-growth",
          label: "Context growth",
          triggered: true,
          level: "watch",
          turnIDs: ["trn_1", "trn_2", "trn_3"],
        }),
      ],
    }),
    TURNS,
  );
  const links = eventLinks(markup);
  assert.deepEqual(links, ["evt_turn_1", "evt_step_2"]);
  assert.match(markup, />Turn 1</);
  assert.match(markup, />Turn 2</);
  assert.doesNotMatch(markup, />Turn 3</);
  assert.equal(count(markup, 'class="link-button health-rule-link"'), 2);
});

test("event links carry data-event-id iff the rule has event ids", () => {
  const none = healthBreakdownHtml(health({ rules: [rule()] }), TURNS);
  assert.deepEqual(eventLinks(none), []);
  assert.doesNotMatch(none, /health-rule-links/);

  const some = healthBreakdownHtml(
    health({ rules: [rule({ triggered: true, level: "watch", eventIDs: ["evt_1", "evt_2"] })] }),
    TURNS,
  );
  assert.deepEqual(eventLinks(some), ["evt_1", "evt_2"]);
  assert.match(some, /aria-label="Open event evt_1 in Trajectory"/);
});

test("event and turn links are capped at 10 and 6", () => {
  const eventIDs = Array.from({ length: 15 }, (_, index) => `evt_${index + 1}`);
  const manyTurns = Array.from({ length: 8 }, (_, index) => ({
    id: `trn_${index + 1}`,
    index: index + 1,
    trigger: { eventID: `evt_turn_${index + 1}` },
    eventIDs: [],
  }));
  const markup = healthBreakdownHtml(
    health({ rules: [rule({ eventIDs, turnIDs: manyTurns.map((turn) => turn.id) })] }),
    manyTurns,
  );
  const links = eventLinks(markup);
  assert.equal(links.filter((id) => /^evt_\d+$/.test(id)).length, 10);
  assert.equal(links.filter((id) => id.startsWith("evt_turn_")).length, 6);
  assert.equal(count(markup, 'class="link-button health-rule-link"'), 16);
  assert.doesNotMatch(markup, /evt_11/);
  assert.doesNotMatch(markup, /evt_turn_7/);
});

test("insufficient reasons are listed above the rules", () => {
  const markup = healthBreakdownHtml(
    health({
      state: "watch",
      insufficient: true,
      insufficientReasons: ["no turns were recorded", "the analysis covers a window, not the full session"],
      rules: [rule()],
    }),
    TURNS,
  );
  const reasons = markup.indexOf("health-insufficient");
  const rules = markup.indexOf("health-rules");
  assert.ok(reasons >= 0 && rules > reasons);
  assert.match(markup, /no turns were recorded/);
  assert.match(markup, /the analysis covers a window, not the full session/);
  assert.match(markup, /<li>no turns were recorded<\/li>/);
  assert.ok(markup.indexOf("no turns were recorded") < markup.indexOf("Error rate"));
});

test("all dynamic text is escaped", () => {
  const markup = healthBreakdownHtml(
    health({
      rules: [
        rule({
          label: '<img src=x onerror="alert(1)">',
          note: "<script>alert(1)</script>",
          level: "watch",
          triggered: true,
          eventIDs: ['evt_1" onmouseover="alert(1)'],
        }),
      ],
      insufficientReasons: ["<b>no turns</b>"],
    }),
    TURNS,
  );
  assert.doesNotMatch(markup, /<img/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(markup, /data-event-id="evt_1&quot; onmouseover=&quot;alert\(1\)"/);
});

// ---------------------------------------------------------------------------
// Builder module discipline
// ---------------------------------------------------------------------------

test("the builder module is DOM-free and only imports ./format.js", async () => {
  const source = await healthSource();
  assert.doesNotMatch(source, /\bdocument\b/);
  assert.doesNotMatch(source, /\bwindow\b/);
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["./format.js"]);
});

// ---------------------------------------------------------------------------
// app.js wiring
// ---------------------------------------------------------------------------

test("health markup lives only in the Advanced renderer, after the Basic early return", async () => {
  const source = await appSource();
  const advanced = functionBody(source, "function renderStatistics()");
  const basic = functionBody(source, "function renderStatisticsBasic()");

  assert.equal(count(source, "healthBadgeHtml"), 2, "one import plus one render call");
  assert.equal(count(source, "healthBreakdownHtml"), 2, "one import plus one render call");
  assert.equal(count(source, "missingHealth"), 3, "one import plus the two fallbacks");

  assert.equal(count(basic, "health"), 0);
  const earlyReturn = advanced.indexOf('state.viewMode === "basic"');
  assert.ok(earlyReturn >= 0);
  assert.ok(advanced.indexOf("healthBadgeHtml") > earlyReturn);
  assert.ok(advanced.indexOf("healthBreakdownHtml") > earlyReturn);
  assert.match(advanced, /analysis\.health \?\? missingHealth\(\)/);
});

test("the breakdown renders between the toolbar and the table/charts pane", async () => {
  const source = await appSource();
  const advanced = functionBody(source, "function renderStatistics()");
  const copyDigest = advanced.indexOf('id="copy-digest"');
  const breakdown = advanced.indexOf("state.healthPanelOpen ? healthBreakdownHtml(");
  const pane = advanced.indexOf("? chartsPaneHtml(analysis)");
  assert.ok(copyDigest >= 0 && breakdown > copyDigest && pane > breakdown);
  assert.match(advanced, /state\.healthPanelOpen\s*\?\s*healthBreakdownHtml\(/);
});

test("bindStatistics binds the badge toggle and keeps aria-expanded in sync", async () => {
  const source = await appSource();
  const body = functionBody(source, "function bindStatistics()");
  assert.match(body, /querySelectorAll\("\[data-health-toggle\]"\)/);
  assert.match(body, /state\.healthPanelOpen = !state\.healthPanelOpen/);
  assert.match(body, /setAttribute\("aria-expanded", String\(state\.healthPanelOpen\)\)/);
  assert.match(body, /renderStatistics\(\)/);
});

test("the existing drill selectors are unchanged", async () => {
  const source = await appSource();
  const body = functionBody(source, "function bindStatistics()");
  assert.match(body, /"\[data-jump-step\]"/);
  assert.match(body, /"\[data-event-id\]:not\(\[data-open-incident\]\)"/);
  assert.match(body, /bindDiagnosticCards\(\);/);
  assert.match(body, /"\[data-session-id\]"/);
  assert.match(body, /void jumpToEvent\(eventID\)/);
  // No duplicate wiring for the rule links: one event-id loop only.
  assert.equal(count(body, '"[data-event-id]:not([data-open-incident])"'), 1);
});

// ---------------------------------------------------------------------------
// styles.css tokens
// ---------------------------------------------------------------------------

test("health styles use existing tokens and no hex literals", async () => {
  const css = await styleSource();
  const start = css.indexOf(".health-badge {");
  assert.ok(start >= 0, ".health-badge not found");
  const next = css.indexOf("/* ---", start);
  const block = css.slice(start, next === -1 ? css.length : next);
  assert.ok(block.length > 0);
  assert.match(block, /var\(--/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(block, /\.health-badge\s*\{[\s\S]*border-radius: var\(--radius-sm\)/);
  assert.match(block, /\.health-badge-insufficient\s*\{[^}]*border-style: dashed/);
  assert.match(block, /\.health-badge-watch\s*\{[^}]*var\(--warning\)/);
  assert.match(block, /\.health-badge-healthy\s*\{[^}]*var\(--good\)/);
  assert.match(block, /\.health-badge-degraded\s*\{[^}]*var\(--critical\)/);
  assert.match(block, /\.health-rule\s*\{[^}]*1px solid var\(--border\)[^}]*var\(--radius\)/);
});
