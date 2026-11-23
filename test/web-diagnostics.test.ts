import test from "node:test";
import assert from "node:assert/strict";
import type { DiagnosticIncident, RecoveryState } from "../src/core/diagnostics.ts";
import type { Metric } from "../src/core/types.ts";
import {
  CARD_NOTE,
  DIAGNOSTICS_SECTION_TITLE,
  MAX_RECOVERY_CARDS,
  NO_INCIDENTS_TEXT,
  RECOVERY_LABELS,
  RECOVERY_MAP_TITLE,
  basisLabel,
  basisMark,
  buildDiagnosticsSection,
  buildRecoveryMap,
  diagnosticCard,
  diagnosticsSectionText,
  failureHighlight,
  incidentForFirstEvent,
  metricText,
  recoveryBadgeKind,
  recoveryLabel,
} from "../src/web/lib/diagnostics.ts";

function incident(overrides: Partial<DiagnosticIncident> = {}): DiagnosticIncident {
  return {
    tool: "bash",
    turn: 2,
    turnID: "turn-2",
    attempts: 3,
    recoveryEventID: "evt-success",
    recovery: "recovered",
    basis: "derived",
    failureBasis: "measured",
    why: "A same-tool success followed the run.",
    inputsCompared: true,
    inputsComparable: true,
    similarity: "identical",
    inputKeyShape: ["command"],
    firstFailureEventID: "evt-fail-1",
    lastFailureEventID: "evt-fail-3",
    failureEventIDs: ["evt-fail-1", "evt-fail-2", "evt-fail-3"],
    successEventID: "evt-success",
    trigger: { kind: "user", eventID: "evt-user", label: "User message" },
    elapsed: { value: 4_000, basis: "measured" },
    stepCostSum: { value: 0.25, basis: "derived" },
    ...overrides,
  };
}

/* ------------------------------------------------------------------- labels */

test("diagnostics: the four recovery states keep their DR-2 labels", () => {
  assert.equal(recoveryLabel("recovered"), "Recovery observed");
  assert.equal(recoveryLabel("possible-recovery"), "Possible recovery");
  assert.equal(recoveryLabel("no-recovery-evidence"), "No recovery evidence");
  assert.equal(recoveryLabel("insufficient-data"), "Insufficient data");
  assert.equal(recoveryLabel("something-new"), "Unknown");
  assert.equal(recoveryLabel(undefined), "Unknown");
  assert.deepEqual(Object.keys(RECOVERY_LABELS), [
    "recovered",
    "possible-recovery",
    "no-recovery-evidence",
    "insufficient-data",
    "unknown",
  ]);
});

test("diagnostics: the badge kind is a treatment, never the verdict", () => {
  const states: RecoveryState[] = [
    "recovered",
    "possible-recovery",
    "no-recovery-evidence",
    "insufficient-data",
  ];
  assert.deepEqual(states.map(recoveryBadgeKind), ["good", "accent", "uncertain", "uncertain"]);
  assert.equal(recoveryBadgeKind("unknown-state"), "uncertain");
});

test("diagnostics: metric text carries its provenance mark and note", () => {
  const measured = metricText({ value: 12, basis: "measured" }, String);
  assert.deepEqual(measured, { text: "12", basis: "measured", mark: "M", title: "measured" });
  const derived = metricText(
    { value: 12, basis: "derived", note: "from two timestamps" },
    String,
  );
  assert.equal(derived.mark, "D");
  assert.equal(derived.title, "derived: from two timestamps");
  const unavailable = metricText({ value: null, basis: "unavailable" }, String);
  assert.equal(unavailable.text, "—");
  assert.equal(unavailable.mark, "—");
  assert.equal(unavailable.title, "unavailable");
  const absent = metricText(undefined, String);
  assert.equal(absent.text, "—");
  assert.equal(basisMark("estimated"), "E");
  assert.equal(basisMark("unavailable"), "—");
  assert.equal(basisLabel("unavailable"), "unavailable");
});

/* -------------------------------------------------------------------- cards */

test("diagnostics: a card repeats the engine's fields verbatim", () => {
  const card = diagnosticCard(incident());
  assert.equal(card.key, "evt-fail-1");
  assert.equal(card.eventID, "evt-fail-1");
  assert.equal(card.tool, "bash");
  assert.deepEqual(card.badge, { label: "Recovery observed", kind: "good" });
  assert.equal(card.turnText, "Turn 2");
  assert.equal(card.triggerLabel, "User message");
  assert.equal(card.openLabel, "Open bash incident in Trajectory");
  assert.equal(card.why, "A same-tool success followed the run.");
  assert.equal(card.note, CARD_NOTE);
  assert.deepEqual(
    card.stats.map((stat) => [stat.label, stat.value.text]),
    [
      ["Attempts", "3"],
      ["Elapsed (context)", "4.00 s"],
      ["Step cost sum (context)", "$0.2500"],
    ],
  );
});

test("diagnostics: a missing tool and trigger still render a label", () => {
  const card = diagnosticCard(
    Object.assign(incident(), { tool: "", trigger: undefined }),
  );
  assert.equal(card.tool, "—");
  assert.equal(card.triggerLabel, "—");
  assert.equal(card.openLabel, "Open — incident in Trajectory");
});

test("diagnostics: colour never carries a state alone", () => {
  for (const state of [
    "recovered",
    "possible-recovery",
    "no-recovery-evidence",
    "insufficient-data",
    "future-state",
  ] as const) {
    const card = diagnosticCard(incident({ recovery: state as RecoveryState }));
    assert.equal(card.badge.label.trim().length > 0, true, state);
    assert.equal(card.badge.label, recoveryLabel(state));
    assert.match(card.badge.label, /^[A-Z]/);
    for (const stat of card.stats) {
      assert.equal(stat.label.trim().length > 0, true, `${state} ${stat.label}`);
    }
  }
});

/* ----------------------------------------------------------------- sections */

test("diagnostics: the empty state is one sentence, no cards", () => {
  const map = buildRecoveryMap([]);
  assert.equal(map.title, RECOVERY_MAP_TITLE);
  assert.equal(map.countLabel, "0 incident(s) from the deterministic diagnostics engine");
  assert.equal(map.empty, true);
  assert.deepEqual(map.cards, []);
  assert.equal(map.note, NO_INCIDENTS_TEXT);
  assert.equal(NO_INCIDENTS_TEXT, "No diagnostic incidents recorded in this session.");
  const section = buildDiagnosticsSection([]);
  assert.equal(section.title, DIAGNOSTICS_SECTION_TITLE);
  assert.equal(section.empty, true);
});

test("diagnostics: the section title differs from the strip title", () => {
  assert.equal(buildRecoveryMap([incident()]).title, "Recovery map");
  assert.equal(buildDiagnosticsSection([incident()]).title, "Diagnostics");
  assert.equal(
    buildRecoveryMap([incident(), incident({ firstFailureEventID: "evt-2" })]).countLabel,
    "2 incident(s) from the deterministic diagnostics engine",
  );
});

test("diagnostics: the card list is capped and the overflow is stated", () => {
  const many = Array.from({ length: MAX_RECOVERY_CARDS + 5 }, (_, index) =>
    incident({ firstFailureEventID: `evt-${index}` }),
  );
  const model = buildRecoveryMap(many);
  assert.equal(model.cards.length, MAX_RECOVERY_CARDS);
  assert.deepEqual(model.overflow, {
    count: 5,
    text: "5 further incident(s) are not shown.",
  });
  const exact = buildRecoveryMap(many.slice(0, MAX_RECOVERY_CARDS));
  assert.equal(exact.overflow, null);
});

test("diagnostics: hostile recorded text stays literal text, never markup", () => {
  const hostile = diagnosticCard(
    incident({
      tool: '<img src=x onerror="alert(1)">',
      why: "<script>alert(2)</script>",
      trigger: { kind: "user", eventID: null, label: "<svg onload=alert(3)>" },
    }),
  );
  const text = diagnosticsSectionText(buildRecoveryMap([
    incident({
      tool: hostile.tool,
      why: hostile.why,
      trigger: { kind: "user", eventID: null, label: hostile.triggerLabel },
    }),
  ]));
  assert.equal(text.includes('<img src=x onerror="alert(1)">'), true);
  assert.equal(text.includes("<script>alert(2)</script>"), true);
  assert.equal(text.includes("<svg onload=alert(3)>"), true);
  assert.equal(text.includes("&lt;"), false);
});

/* ------------------------------------------------------------------ dr-1/dr-4 */

test("diagnostics: only the incident anchored on the opened event matches", () => {
  const items = [incident(), incident({ firstFailureEventID: "evt-other" })];
  assert.equal(incidentForFirstEvent(items, "evt-fail-1")?.tool, "bash");
  assert.equal(incidentForFirstEvent(items, "evt-nope"), null);
  assert.equal(incidentForFirstEvent(items, null), null);
});

test("diagnostics: the highlight is the failure sequence, validated against known ids", () => {
  const items = [incident()];
  assert.deepEqual(
    failureHighlight(items, "evt-fail-1", new Set()),
    ["evt-fail-1", "evt-fail-2", "evt-fail-3"],
  );
  assert.deepEqual(
    failureHighlight(items, "evt-fail-1", new Set(["evt-fail-1", "evt-fail-3"])),
    ["evt-fail-1", "evt-fail-3"],
  );
  assert.deepEqual(failureHighlight(items, "evt-other", new Set()), []);
  assert.deepEqual(failureHighlight(items, null, new Set()), []);
});

test("diagnostics: repeated builds are deep-equal and do not mutate input", () => {
  const items = [incident()];
  const snapshot = JSON.stringify(items);
  assert.deepEqual(buildRecoveryMap(items), buildRecoveryMap(items));
  assert.equal(JSON.stringify(items), snapshot);
});
