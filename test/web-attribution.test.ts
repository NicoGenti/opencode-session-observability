import test from "node:test";
import assert from "node:assert/strict";
import type {
  Attribution,
  CommandAttribution,
  FileAttribution,
  SubtaskAttribution,
  TurnAttribution,
} from "../src/core/attribution.ts";
import {
  MAX_COMMANDS_PER_TURN,
  MAX_COMMAND_EVIDENCE,
  MAX_FILES_PER_TURN,
  MAX_FILE_EVIDENCE,
  MAX_SUBTASKS_PER_TURN,
  MAX_TURN_EVIDENCE,
} from "../src/web/lib/attribution.ts";
import {
  COMMIT_LINKAGE_NOTE,
  buildAttribution,
} from "../src/web/lib/attribution.ts";

function file(overrides: Partial<FileAttribution> = {}): FileAttribution {
  return {
    path: "src/core/analysis.ts",
    ops: { read: 2, write: 1 },
    costShare: { value: 0.25, basis: "derived", note: "even allocation" },
    basis: "measured",
    eventIDs: ["evt-file-1"],
    ...overrides,
  };
}

function command(overrides: Partial<CommandAttribution> = {}): CommandAttribution {
  return {
    name: "bash",
    count: 3,
    basis: "derived",
    eventIDs: ["evt-cmd-1"],
    ...overrides,
  };
}

function subtask(overrides: Partial<SubtaskAttribution> = {}): SubtaskAttribution {
  return { sessionID: "child-1", agent: "build", basis: "measured", ...overrides };
}

function turn(overrides: Partial<TurnAttribution> = {}): TurnAttribution {
  return {
    turnID: "turn-1",
    turnIndex: 1,
    taskID: "turn-1",
    trigger: { kind: "user", eventID: "evt-turn-1", label: "User message" },
    files: [file()],
    commands: [command()],
    subtasks: [subtask()],
    eventIDs: ["evt-turn-1"],
    filesTruncated: 0,
    commandsTruncated: 0,
    ...overrides,
  };
}

function attribution(overrides: Partial<Attribution> = {}): Attribution {
  return {
    turns: [turn()],
    basisNotes: [
      "Commit linkage unavailable: the session database records no git data.",
      "Cost shares are derived from recorded step cost.",
    ],
    ...overrides,
  };
}

test("attribution: a turn lists its recorded index, trigger and capped evidence", () => {
  const model = buildAttribution(attribution());
  assert.equal(model.empty, false);
  const first = model.turns[0]!;
  assert.equal(first.indexLabel, "Turn 1");
  assert.equal(first.trigger, "User message");
  assert.equal(first.files.rows.length, 1);
  assert.equal(first.files.rows[0]?.path, "src/core/analysis.ts");
  assert.equal(first.files.rows[0]?.ops, "2 read · 1 write");
  assert.equal(first.files.rows[0]?.share.text, "$0.2500");
  assert.equal(first.files.rows[0]?.share.mark, "D");
  assert.deepEqual(first.files.rows[0]?.links.map((link) => link.label), ["File 1 · Event 1"]);
  assert.equal(first.commands.rows[0]?.count, "×3");
  assert.equal(first.subtasks.rows[0]?.agent, "build");
});

test("attribution: the provenance rail and the standing commit row are always present", () => {
  const model = buildAttribution(attribution());
  assert.equal(model.rail, "Paths measured · cost shares derived · commits unavailable");
  assert.equal(model.commitNote, COMMIT_LINKAGE_NOTE);
  assert.deepEqual(model.notes, ["Cost shares are derived from recorded step cost."]);
});

test("attribution: an absent, empty or malformed rider renders nothing", () => {
  assert.equal(buildAttribution(null).empty, true);
  assert.equal(buildAttribution({ turns: [], basisNotes: [] }).empty, true);
  assert.equal(buildAttribution(undefined).empty, true);
});

test("attribution: an unavailable cost share stays an em dash, a recorded zero stays $0", () => {
  const none = buildAttribution(
    attribution({ turns: [turn({ files: [file({ costShare: { value: null, basis: "unavailable" } })] })] }),
  );
  assert.equal(none.turns[0]?.files.rows[0]?.share.text, "—");
  const zero = buildAttribution(
    attribution({ turns: [turn({ files: [file({ costShare: { value: 0, basis: "derived" } })] })] }),
  );
  assert.equal(zero.turns[0]?.files.rows[0]?.share.text, "$0");
});

test("attribution: files and evidence are capped in the model", () => {
  assert.equal(MAX_FILES_PER_TURN, 12);
  assert.equal(MAX_FILE_EVIDENCE, 6);
  const files = Array.from({ length: 14 }, (_, index) =>
    file({ path: `file-${index + 1}.ts`, eventIDs: [] }),
  );
  const model = buildAttribution(attribution({ turns: [turn({ files })] }));
  assert.equal(model.turns[0]?.files.rows.length, 12);
  const evidence = Array.from({ length: 9 }, (_, index) => `evt-${index + 1}`);
  const capped = buildAttribution(
    attribution({ turns: [turn({ files: [file({ eventIDs: evidence })] })] }),
  );
  assert.equal(capped.turns[0]?.files.rows[0]?.links.length, 6);
});

test("attribution: commands and turn evidence follow their own caps", () => {
  assert.equal(MAX_COMMANDS_PER_TURN, 8);
  assert.equal(MAX_COMMAND_EVIDENCE, 6);
  assert.equal(MAX_SUBTASKS_PER_TURN, 8);
  assert.equal(MAX_TURN_EVIDENCE, 10);
  const commands = Array.from({ length: 10 }, (_, index) =>
    command({ name: `cmd-${index + 1}`, eventIDs: [] }),
  );
  const evidence = Array.from({ length: 14 }, (_, index) => `evt-${index + 1}`);
  const model = buildAttribution(
    attribution({ turns: [turn({ commands, eventIDs: evidence })] }),
  );
  assert.equal(model.turns[0]?.commands.rows.length, 8);
  assert.equal(model.turns[0]?.links.length, 10);
});

test("attribution: capped turns surface the +N note from the truncation counts", () => {
  const model = buildAttribution(
    attribution({ turns: [turn({ filesTruncated: 3, commandsTruncated: 2 })] }),
  );
  assert.equal(model.turns[0]?.files.more, "+3 more files not shown");
  assert.equal(model.turns[0]?.commands.more, "+2 more commands not shown");
  assert.equal(model.turns[0]?.subtasks.more, "");
});

test("attribution: every evidence chip names its own row so identical numbers stay distinct", () => {
  const model = buildAttribution(
    attribution({
      turns: [
        turn({
          files: [file({ path: "a.ts" }), file({ path: "b.ts" })],
          commands: [command({ name: "ls" }), command({ name: "pwd" })],
        }),
      ],
    }),
  );
  assert.deepEqual(
    model.turns[0]?.files.rows.map((row) => row.links[0]?.label),
    ["File 1 · Event 1", "File 2 · Event 1"],
  );
  assert.deepEqual(
    model.turns[0]?.commands.rows.map((row) => row.links[0]?.label),
    ["Command 1 · Event 1", "Command 2 · Event 1"],
  );
  assert.deepEqual(model.turns[0]?.links.map((link) => link.label), ["Turn 1 · Event 1"]);
});

test("attribution: rows with no path, name or session id are skipped", () => {
  const model = buildAttribution(
    attribution({
      turns: [
        turn({
          files: [file({ path: "" })],
          commands: [command({ name: "" })],
          subtasks: [subtask({ sessionID: "" })],
        }),
      ],
    }),
  );
  assert.equal(model.turns[0]?.files.rows.length, 0);
  assert.equal(model.turns[0]?.commands.rows.length, 0);
  assert.equal(model.turns[0]?.subtasks.rows.length, 0);
});

test("attribution: a turn without an index keeps the neutral Turn label", () => {
  const model = buildAttribution(
    attribution({ turns: [turn({ turnIndex: undefined as unknown as number })] }),
  );
  assert.equal(model.turns[0]?.indexLabel, "Turn");
});

test("attribution: a tool-free session leaves no section behind", () => {
  assert.equal(buildAttribution({ turns: [], basisNotes: [] }).empty, true);
});
