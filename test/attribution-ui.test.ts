import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COMMIT_LINKAGE_NOTE,
  MAX_COMMANDS_PER_TURN,
  MAX_FILES_PER_TURN,
  MAX_FILE_EVIDENCE,
  MAX_SUBTASKS_PER_TURN,
  MAX_TURN_EVIDENCE,
  attributionSectionHtml,
  // @ts-expect-error - plain browser module without type declarations
} from "../src/ui/attribution.js";

const COST_SHARE = {
  value: 0.02,
  basis: "derived",
  note: "step cost divided evenly across the step's tool calls and the files each call touched",
};

interface FileRow {
  path: string;
  ops: { read: number; write: number };
  costShare: typeof COST_SHARE | { value: null; basis: "unavailable"; note: string };
  basis: "measured";
  eventIDs: string[];
}

function file(overrides: Partial<FileRow> = {}): FileRow {
  return {
    path: "src/core/attribution.ts",
    ops: { read: 1, write: 1 },
    costShare: COST_SHARE,
    basis: "measured",
    eventIDs: ["msg_a1:0"],
    ...overrides,
  };
}

interface TurnRow {
  turnID: string;
  turnIndex: number;
  taskID: string;
  trigger: { kind: string; eventID: string | null; label: string };
  files: FileRow[];
  commands: Array<{
    name: string;
    count: number;
    basis: "derived";
    eventIDs: string[];
  }>;
  subtasks: Array<{ sessionID: string; agent: string | null; basis: "measured" }>;
  eventIDs: string[];
  filesTruncated?: number;
  commandsTruncated?: number;
}

function turn(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turnID: "ses_t:t1",
    turnIndex: 1,
    taskID: "ses_t:t1",
    trigger: { kind: "user", eventID: "msg_u1", label: "User message" },
    files: [file()],
    commands: [
      { name: "npm", count: 2, basis: "derived", eventIDs: ["msg_a1:9"] },
    ],
    subtasks: [{ sessionID: "ses_child", agent: "explorer", basis: "measured" }],
    eventIDs: ["msg_u1", "msg_a1"],
    ...overrides,
  };
}

function attribution(overrides: Record<string, unknown> = {}) {
  return {
    turns: [turn()],
    basisNotes: [
      "File paths are measured: they come from recorded tool inputs and write-tool file lists.",
      "Per-file cost shares are derived: each step's recorded cost is divided evenly across its tool calls, then across the files a call touched; calls that touch no file are not allocated.",
      "Command names are derived: the first recorded shell token only; full command text is never included.",
      "Commit linkage is unavailable: the session database records no git data (see docs/DATA-SOURCES.md).",
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test("a turn row lists files, ops, cost share and its evidence", () => {
  const markup = attributionSectionHtml(attribution());

  assert.match(markup, /class="attribution-section"/);
  assert.match(markup, /Task and file attribution/);
  assert.match(markup, /Turn 1/);
  assert.match(markup, /User message/);
  assert.match(markup, /class="attribution-file"/);
  assert.match(markup, /src\/core\/attribution\.ts/);
  assert.match(markup, /1 read · 1 write/);
  // The derived share keeps the metric mark and its note in the tooltip.
  assert.match(markup, /metric metric-derived/);
  assert.match(markup, /<sup>D<\/sup>/);
  assert.match(markup, /derived: step cost divided evenly/);
  assert.match(markup, /\$0\.02/);
});

test("commands render by first token with their count only", () => {
  const markup = attributionSectionHtml(attribution());

  assert.match(markup, /class="attribution-command"/);
  assert.match(markup, /<code>npm<\/code>/);
  assert.match(markup, /×2/);
});

test("subtasks render as child-session drill buttons with their agent", () => {
  const markup = attributionSectionHtml(attribution());

  assert.match(markup, /class="attribution-subtask"/);
  assert.match(markup, /data-session-id="ses_child"/);
  assert.match(markup, /explorer/);
});

test("every row drills through the existing event link button", () => {
  const markup = attributionSectionHtml(attribution());

  assert.match(markup, /data-event-id="msg_a1:0"/);
  assert.match(markup, /data-event-id="msg_a1:9"/);
  assert.match(markup, /data-event-id="msg_u1"/);
  assert.match(markup, /class="link-button attribution-link"/);
  // One file link, one command link and the turn's two evidence links.
  assert.equal((markup.match(/data-event-id="/g) ?? []).length, 4);
  assert.equal((markup.match(/aria-label="Open event/g) ?? []).length, 4);
});

test("the standing commit row is always present and never doubled", () => {
  const markup = attributionSectionHtml(attribution());

  assert.match(markup, /class="attribution-commit"/);
  assert.ok(markup.includes(COMMIT_LINKAGE_NOTE));
  assert.equal(
    (markup.match(/Commit linkage/gi) ?? []).length,
    1,
    "the DTO's own commit note must not repeat the standing row",
  );
  // The other basis notes stay visible.
  assert.match(markup, /File paths are measured/);
  assert.match(markup, /Command names are derived/);
});

test("an absent, empty or malformed rider renders nothing", () => {
  assert.equal(attributionSectionHtml(undefined), "");
  assert.equal(attributionSectionHtml(null), "");
  assert.equal(attributionSectionHtml({}), "");
  assert.equal(attributionSectionHtml({ turns: [] }), "");
  assert.equal(attributionSectionHtml({ turns: "nope" }), "");
});

test("files and evidence are capped in the renderer", () => {
  const files = Array.from({ length: 20 }, (_, index) =>
    file({
      path: `src/f${index}.ts`,
      eventIDs: Array.from({ length: 9 }, (_, id) => `evt_${index}_${id}`),
    }),
  );
  const commands = Array.from({ length: 12 }, (_, index) => ({
    name: `tool${index}`,
    count: 1,
    basis: "derived" as const,
    eventIDs: [`cmd_${index}`],
  }));
  const subtasks = Array.from({ length: 12 }, (_, index) => ({
    sessionID: `ses_child_${index}`,
    agent: null,
    basis: "measured" as const,
  }));

  const markup = attributionSectionHtml(
    attribution({ turns: [turn({ files, commands, subtasks })] }),
  );

  assert.equal((markup.match(/class="attribution-file"/g) ?? []).length, MAX_FILES_PER_TURN);
  assert.equal((markup.match(/class="attribution-command"/g) ?? []).length, MAX_COMMANDS_PER_TURN);
  assert.equal((markup.match(/class="attribution-subtask"/g) ?? []).length, MAX_SUBTASKS_PER_TURN);
  // Per-file evidence keeps the core cap.
  assert.equal(
    (markup.match(/data-event-id="evt_0_\d"/g) ?? []).length,
    MAX_FILE_EVIDENCE,
  );
});

test("every dynamic string is escaped", () => {
  const markup = attributionSectionHtml(
    attribution({
      turns: [
        turn({
          trigger: { kind: "user", eventID: null, label: '<script>alert("x")</script>' },
          files: [file({ path: '<img src=x onerror="alert(1)">.ts', eventIDs: ['evt"1'] })],
          commands: [{ name: "<b>npm</b>", count: 1, basis: "derived", eventIDs: [] }],
          subtasks: [{ sessionID: '<b>ses</b>', agent: "<i>x</i>", basis: "measured" }],
        }),
      ],
    }),
  );

  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /<img /);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;b&gt;npm&lt;\/b&gt;/);
  assert.match(markup, /data-event-id="evt&quot;1"/);
  assert.match(markup, /data-session-id="&lt;b&gt;ses&lt;\/b&gt;"/);
});

test("an unavailable cost share renders the em dash, never a zero", () => {
  const markup = attributionSectionHtml(
    attribution({
      turns: [
        turn({
          files: [
            file({
              costShare: {
                value: null,
                basis: "unavailable",
                note: "no step that touched this path recorded a cost",
              },
            }),
          ],
        }),
      ],
    }),
  );

  assert.match(markup, /metric unavailable/);
  assert.match(markup, /—/);
  assert.doesNotMatch(markup, /\$0/);
});

test("a recorded zero share renders $0, not the unavailable dash", () => {
  const markup = attributionSectionHtml(
    attribution({
      turns: [
        turn({
          files: [
            file({
              costShare: {
                value: 0,
                basis: "derived",
                note: "step cost divided evenly across the step's tool calls and the files each call touched",
              },
            }),
          ],
        }),
      ],
    }),
  );

  assert.match(markup, /metric metric-derived/);
  assert.match(markup, /\$0</);
  assert.doesNotMatch(markup, /metric unavailable/);
});

test("capped turns surface a +N more note from the truncation counts", () => {
  const markup = attributionSectionHtml(
    attribution({
      turns: [turn({ filesTruncated: 5, commandsTruncated: 3 })],
    }),
  );

  assert.match(markup, /\+5 more files not shown/);
  assert.match(markup, /\+3 more commands not shown/);
  // An uncapped turn renders no note.
  assert.doesNotMatch(attributionSectionHtml(attribution()), /more files/);
});

test("every evidence chip names its own row", () => {
  const markup = attributionSectionHtml(attribution());

  assert.match(markup, /File 1 · Event 1/);
  assert.match(markup, /Command 1 · Event 1/);
  assert.match(markup, /Turn 1 · Event 1/);
});

test("the turn evidence cap is named and enforced", () => {
  const markup = attributionSectionHtml(
    attribution({
      turns: [
        turn({
          eventIDs: Array.from({ length: MAX_TURN_EVIDENCE + 5 }, (_, index) =>
            `evt_${index}`,
          ),
        }),
      ],
    }),
  );
  const turnHead = markup.slice(0, markup.indexOf('class="attribution-group"'));

  assert.equal((turnHead.match(/data-event-id="evt_/g) ?? []).length, MAX_TURN_EVIDENCE);
});

test("the builder module is DOM-free and only imports ./format.js", async () => {
  const source = await readFile(
    new URL("../src/ui/attribution.js", import.meta.url),
    "utf8",
  );
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(specifiers, ["./format.js"]);
  assert.doesNotMatch(source, /(^|[^\w.])document\./m);
  assert.doesNotMatch(source, /(^|[^\w.])window\./m);
  assert.doesNotMatch(source, /fetch\(/);
});

// ---------------------------------------------------------------------------
// app.js wiring
// ---------------------------------------------------------------------------

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

/** One function's source, up to the first `}` in column 0. */
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

test("renderStatistics renders the section after the table and before the legend", async () => {
  const source = await appSource();
  const body = functionBody(source, "function renderStatistics()");

  const basic = body.indexOf("renderStatisticsBasic()");
  const table = body.indexOf('class="table-wrap"');
  const section = body.indexOf("attributionSectionHtml(analysis.attribution)");
  const legend = body.indexOf('<div class="basis-legend">');

  assert.ok(basic >= 0 && table >= 0 && section >= 0 && legend >= 0);
  assert.ok(section > basic, "the Advanced early return must stay above it");
  assert.ok(section > table, "the section sits below the table/charts block");
  assert.ok(section < legend, "the section sits above the basis legend");
  assert.match(
    source,
    /import \{ attributionSectionHtml \} from "\.\/attribution\.js";/,
  );
});

test("Basic mode renders no attribution markup", async () => {
  const source = await appSource();
  const basic = functionBody(source, "function renderStatisticsBasic()");

  assert.ok(basic.length > 0);
  assert.doesNotMatch(basic, /attribution/);
  assert.doesNotMatch(basic, /attributionSectionHtml/);
});

test("the drill selectors the section relies on stay bound", async () => {
  const source = await appSource();
  const bind = functionBody(source, "function bindStatistics()");

  assert.match(bind, /\[data-event-id\]:not\(\[data-open-incident\]\)/);
  assert.match(bind, /\[data-session-id\]/);
  assert.match(bind, /jumpToEvent\(eventID\)/);
  assert.match(bind, /selectSession\(element\.dataset\.sessionId\)/);
});

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

test("attribution styles reuse tokens only and never warn as text", async () => {
  const css = await readFile(
    new URL("../src/ui/styles.css", import.meta.url),
    "utf8",
  );
  const start = css.lastIndexOf("/*", css.indexOf("task attribution */"));
  const end = css.lastIndexOf("/*", css.indexOf("live mode */"));
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end);

  assert.match(block, /\.attribution-section \{/);
  assert.match(block, /\.attribution-turn \{/);
  assert.match(block, /\.attribution-file, \.attribution-command, \.attribution-subtask \{/);
  assert.match(block, /var\(--surface-2\)/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(block, /color:\s*var\(--warning\)/);
  assert.doesNotMatch(block, /!important/);
});
