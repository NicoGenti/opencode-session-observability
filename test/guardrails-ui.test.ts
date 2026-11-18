import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_GUARDRAILS,
  GUARDRAIL_MAX,
} from "../src/core/guardrails.ts";
// @ts-expect-error - plain browser module without type declarations
import * as settings from "../src/ui/settings.js";
import {
  GUARDRAIL_ADVISORY_COPY,
  MAX_EVENT_LINKS,
  guardrailsHtml,
  // @ts-expect-error - plain browser module without type declarations
} from "../src/ui/guardrails.js";

const STORAGE_KEY = "observability-guardrails";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

const storage = memoryStorage();
Object.assign(globalThis, {
  localStorage: storage,
  document: {
    documentElement: {
      dataset: {},
      style: {
        setProperty() {},
        removeProperty() {},
      },
    },
    body: { dataset: {} },
  },
});

test.beforeEach(() => {
  settings.reset();
  settings.applyViewMode("basic");
});

function warning(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tokens-total",
    label: "Token budget",
    observed: "2500000 total token(s) recorded",
    threshold: 2_000_000,
    basis: "derived",
    advisory: true,
    eventIDs: ["evt_1", "evt_2"],
    turnIDs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Settings store
// ---------------------------------------------------------------------------

test("the browser mirror matches the core defaults and bounds field for field", () => {
  assert.ok(Object.isFrozen(settings.GUARDRAIL_DEFAULTS));
  assert.deepEqual({ ...settings.GUARDRAIL_DEFAULTS }, { ...DEFAULT_GUARDRAILS });
  assert.ok(Object.isFrozen(settings.GUARDRAIL_MAX));
  assert.deepEqual({ ...settings.GUARDRAIL_MAX }, { ...GUARDRAIL_MAX });
  assert.equal(settings.GUARDRAIL_FIELDS.length, 6);
  for (const field of settings.GUARDRAIL_FIELDS) {
    assert.equal(field.max, GUARDRAIL_MAX[field.key as keyof typeof GUARDRAIL_MAX]);
  }
});

test("guardrail budgets round-trip through the per-browser store", () => {
  assert.deepEqual(settings.getGuardrails(), { ...settings.GUARDRAIL_DEFAULTS });

  const saved = settings.setGuardrail("costTotal", "12");
  assert.deepEqual(saved, { ok: true, value: 12 });
  assert.equal(settings.getGuardrails().costTotal, 12);
  // Persisted for later reloads, not only held in memory.
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}").costTotal, 12);

  const restored = settings.resetGuardrails();
  assert.deepEqual(restored, { ...settings.GUARDRAIL_DEFAULTS });
  assert.equal(settings.getGuardrails().costTotal, 5);
});

test("invalid budgets are rejected with a message and never stored", () => {
  const before = settings.getGuardrails();
  const rejected: Array<[string, unknown]> = [
    ["retries", -1],
    ["costTotal", "abc"],
    ["contextRun", Number.NaN],
    ["elapsedMinutes", GUARDRAIL_MAX.elapsedMinutes + 1],
    ["tokensTotal", Number.POSITIVE_INFINITY],
    // An emptied field must never read as a budget of 0.
    ["costTotal", ""],
    ["retries", "  "],
    ["tokensTotal", null],
    ["toolFailures", []],
    ["toolFailures", true],
  ];
  for (const [key, value] of rejected) {
    const result = settings.setGuardrail(key, value);
    assert.equal(result.ok, false, `${key}=${String(value)}`);
    assert.match(result.message, /must be a number between/);
  }
  const unknown = settings.setGuardrail("unknownBudget", 1);
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /Unknown guardrail budget/);

  assert.deepEqual(settings.getGuardrails(), before);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("an emptied settings field normalizes to reject, not to zero", () => {
  for (const key of ["costTotal", "retries", "tokensTotal", "elapsedMinutes"]) {
    assert.equal(settings.normalizeGuardrailValue(key, ""), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, "   "), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, null), null, key);
  }
  // Explicit zero is still a legitimate budget.
  assert.equal(settings.normalizeGuardrailValue("costTotal", 0), 0);
  assert.equal(settings.normalizeGuardrailValue("retries", "0"), 0);
});

test("count budgets are whole numbers, cost and minutes stay fractional", () => {
  for (const key of ["tokensTotal", "contextRun", "retries", "toolFailures"]) {
    assert.equal(settings.normalizeGuardrailValue(key, 1.5), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, "2.25"), null, key);
    assert.equal(settings.normalizeGuardrailValue(key, 3), 3, key);
    assert.equal(settings.normalizeGuardrailValue(key, "3"), 3, key);
  }
  assert.equal(settings.normalizeGuardrailValue("costTotal", 12.75), 12.75);
  assert.equal(settings.normalizeGuardrailValue("elapsedMinutes", 2.5), 2.5);
});

test("a hand-edited stored value degrades to the default", () => {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ costTotal: -4, retries: "many", tokensTotal: 7 }),
  );
  const values = settings.getGuardrails();
  assert.equal(values.costTotal, settings.GUARDRAIL_DEFAULTS.costTotal);
  assert.equal(values.retries, settings.GUARDRAIL_DEFAULTS.retries);
  assert.equal(values.tokensTotal, 7);
});

test("the analysis params carry exactly the six budgets in a fixed order", () => {
  const params = settings.guardrailParams();
  assert.deepEqual(Object.keys(params), [
    "gr.tokensTotal",
    "gr.costTotal",
    "gr.contextRun",
    "gr.retries",
    "gr.toolFailures",
    "gr.elapsedMinutes",
  ]);
  assert.equal(params["gr.tokensTotal"], "2000000");
  assert.equal(params["gr.elapsedMinutes"], "60");

  settings.setGuardrail("costTotal", 12);
  assert.equal(settings.guardrailParams()["gr.costTotal"], "12");

  // A malformed value falls back instead of being dropped or forwarded.
  const fallback = settings.guardrailParams({
    ...settings.GUARDRAIL_DEFAULTS,
    retries: Number.NaN,
  });
  assert.equal(fallback["gr.retries"], "10");
  assert.equal(Object.keys(fallback).length, 6);
});

test("the documented bounds are inclusive", () => {
  assert.equal(
    settings.normalizeGuardrailValue("elapsedMinutes", GUARDRAIL_MAX.elapsedMinutes),
    GUARDRAIL_MAX.elapsedMinutes,
  );
  assert.equal(
    settings.normalizeGuardrailValue(
      "elapsedMinutes",
      GUARDRAIL_MAX.elapsedMinutes + 1,
    ),
    null,
  );
  assert.equal(settings.normalizeGuardrailValue("retries", 0), 0);
  assert.equal(settings.normalizeGuardrailValue("retries", -0.001), null);
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test("the block renders advisory rows with evidence and provenance", () => {
  const markup = guardrailsHtml({ warnings: [warning()], skipped: [] });

  assert.match(markup, /class="guardrails-section"/);
  assert.match(markup, /aria-label="Guardrail budgets"/);
  assert.match(markup, /Guardrails<\/h2>/);
  assert.match(markup, /1 advisory/);
  assert.match(markup, /basis derived/);
  assert.match(markup, new RegExp(GUARDRAIL_ADVISORY_COPY));
  assert.match(markup, /class="guardrail-row"/);
  assert.match(markup, /data-budget="tokens-total"/);
  assert.match(markup, /class="guardrail-basis">derived/);
  assert.match(markup, /2500000 total token\(s\) recorded · budget 2,000,000/);
  assert.equal((markup.match(/data-event-id=/g) ?? []).length, 2);
  assert.match(markup, /data-event-id="evt_1"/);
  // Advisory, not a verdict: no score, severity or ranking vocabulary.
  assert.doesNotMatch(markup, /score|severity|priority|rank/i);
});

test("a skipped budget is reported instead of guessed", () => {
  const markup = guardrailsHtml({
    warnings: [],
    skipped: [
      {
        id: "elapsed-minutes",
        label: "Elapsed-time budget",
        note: "the analysis covers a window, not the full session",
      },
    ],
  });
  assert.match(markup, /0 advisory/);
  assert.match(markup, /Not evaluated/);
  assert.match(
    markup,
    /Elapsed-time budget: the analysis covers a window, not the full session/,
  );
});

test("an absent, empty or malformed sibling renders nothing", () => {
  assert.equal(guardrailsHtml(null), "");
  assert.equal(guardrailsHtml(undefined), "");
  assert.equal(guardrailsHtml({}), "");
  assert.equal(guardrailsHtml({ warnings: [], skipped: [] }), "");
  assert.equal(
    guardrailsHtml({ warnings: [{ id: "x", label: "", observed: "" }] }),
    "",
  );
});

test("every dynamic string is escaped", () => {
  const markup = guardrailsHtml({
    warnings: [
      warning({
        label: '<script>alert(1)</script>',
        observed: '<img src=x onerror="boom">',
      }),
    ],
    skipped: [{ id: "x", label: "<b>", note: "<i>" }],
  });
  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;b&gt;/);
});

test("evidence links are capped at the health event cap", () => {
  const ids = Array.from({ length: 14 }, (_, index) => `evt_${index}`);
  const markup = guardrailsHtml({
    warnings: [warning({ eventIDs: ids })],
    skipped: [],
  });
  assert.equal((markup.match(/data-event-id=/g) ?? []).length, MAX_EVENT_LINKS);
  assert.equal(MAX_EVENT_LINKS, 10);
});

const TURNS = [
  { id: "trn_1", index: 1, trigger: { eventID: "evt_turn_1" }, eventIDs: ["evt_step_1"] },
  { id: "trn_2", index: 2, trigger: { eventID: null }, eventIDs: ["evt_step_2"] },
  { id: "trn_3", index: 3, trigger: {}, eventIDs: [] },
];

function eventLinks(markup: string): string[] {
  return [...markup.matchAll(/data-event-id="([^"]*)"/g)].map((match) => match[1]);
}

test("an event-only budget renders Turn links from the loaded turns", () => {
  // tokens-total carries no eventIDs: the turn anchors are its whole evidence.
  const markup = guardrailsHtml(
    {
      warnings: [
        warning({
          eventIDs: [],
          turnIDs: ["trn_1", "trn_2"],
        }),
      ],
      skipped: [],
    },
    TURNS,
  );
  assert.match(markup, />Turn 1</);
  assert.match(markup, />Turn 2</);
  assert.match(markup, /data-budget="tokens-total"/);
  assert.match(markup, /2500000 total token\(s\) recorded · budget 2,000,000/);
});

test("turn anchors follow the health order: trigger event, then turn event", () => {
  const markup = guardrailsHtml(
    {
      warnings: [
        warning({
          id: "context-run",
          label: "Context growth budget",
          observed: "longest growth run 7 turn(s)",
          threshold: 6,
          eventIDs: ["evt_1"],
          turnIDs: ["trn_1", "trn_2"],
        }),
      ],
      skipped: [],
    },
    TURNS,
  );
  // Event links first, then the turn anchors in the health precedent's order.
  assert.deepEqual(eventLinks(markup), ["evt_1", "evt_turn_1", "evt_step_2"]);
});

test("a turn with no resolvable anchor renders no link", () => {
  const markup = guardrailsHtml(
    {
      warnings: [warning({ eventIDs: [], turnIDs: ["trn_3", "trn_missing"] })],
      skipped: [],
    },
    TURNS,
  );
  assert.equal(eventLinks(markup).length, 0);
  // The observation still renders: the budget is never hidden by thin evidence.
  assert.match(markup, /budget 2,000,000/);
});

test("a fractional budget keeps its decimals instead of rounding up", () => {
  const markup = guardrailsHtml({
    warnings: [
      warning({
        id: "cost-total",
        label: "Cost budget",
        observed: "$15.45 total recorded cost",
        threshold: 12.75,
        eventIDs: [],
        turnIDs: [],
      }),
    ],
    skipped: [],
  });
  assert.match(markup, /budget 12\.75/);
  assert.doesNotMatch(markup, /budget 13\b/);
});

test("identical input renders byte-identical markup", () => {
  const guardrails = { warnings: [warning()], skipped: [] };
  assert.equal(guardrailsHtml(guardrails), guardrailsHtml(guardrails));
});

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

/**
 * One function's source. The slice stops right after the first `}` in column 0
 * (tolerating CRLF), so a nested block or the next declaration cannot widen it.
 */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  let end = -1;
  for (
    let index = source.indexOf("\n}", start + header.length);
    index !== -1;
    index = source.indexOf("\n}", index + 2)
  ) {
    const after = source[index + 2];
    if (after === undefined || after === "\n" || after === "\r") {
      end = index + 2;
      break;
    }
  }
  return source.slice(start, end === -1 ? source.length : end);
}

test("loadSessionData sends the budgets and stores the sibling", async () => {
  const source = await appSource();
  const load = functionBody(source, "async function loadSessionData(");
  assert.match(load, /\.\.\.guardrailParams\(\)/);
  assert.match(load, /state\.guardrails = analysisData\.guardrails \?\? null/);
  assert.match(load, /renderGuardrails\(\)/);
});

test("guardrails render app-wide, never behind the Advanced gate", async () => {
  const source = await appSource();
  const render = functionBody(source, "function renderGuardrails()");
  assert.match(render, /guardrailsHtml\(\s*state\.guardrails,\s*turns\s*\)/);
  assert.match(render, /state\.analysis\?\.turns \?\? \[\]/);
  assert.doesNotMatch(render, /advanced|viewMode|statsTab/);
  assert.match(source, /dom\.guardrails = \$\("#guardrails"\)/);

  // The settings panel offers every budget plus a reset action.
  assert.match(source, /data-guardrail=/);
  assert.match(source, /id="guardrails-reset"/);
  assert.match(source, /GUARDRAIL_FIELDS\.map/);
});

test("clicking a guardrail evidence chip jumps to the event", async () => {
  const source = await appSource();
  assert.match(
    source,
    /dom\.guardrails\?\.addEventListener\("click", \(event\) => \{/,
  );
});

test("the guardrails container sits below the live warnings and above the pane", async () => {
  const html = await readFile(
    new URL("../src/ui/index.html", import.meta.url),
    "utf8",
  );
  const warnings = html.indexOf('id="live-warnings"');
  const guardrails = html.indexOf('id="guardrails"');
  const view = html.indexOf('id="view"');
  assert.ok(warnings >= 0 && guardrails > warnings && view > guardrails);
  // Not an Advanced-only surface: the container carries no gating class.
  const line = html.slice(
    html.lastIndexOf("<div", guardrails),
    html.indexOf(">", guardrails) + 1,
  );
  assert.doesNotMatch(line, /advanced-only/);
});

test("guardrail styles reuse tokens only and never warn as text", async () => {
  const css = await readFile(
    new URL("../src/ui/styles.css", import.meta.url),
    "utf8",
  );
  const start = css.indexOf(
    "/* -------------------------------------------------------------- guardrails */",
  );
  const end = css.indexOf(
    "/* ---------------------------------------------------------- recommendations */",
  );
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end);

  assert.match(block, /\.guardrail-row \{/);
  assert.match(block, /\.guardrails-section \{/);
  assert.match(block, /var\(--warning\)/);
  assert.doesNotMatch(block, /color:\s*var\(--warning\)/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(block, /rgba?\(/);
});
