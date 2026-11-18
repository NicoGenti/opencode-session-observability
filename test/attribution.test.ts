import test from "node:test";
import assert from "node:assert/strict";

import { ObservabilityService } from "../src/core/service.ts";
import {
  MAX_COMMAND_EVIDENCE,
  MAX_COMMANDS_PER_TURN,
  MAX_COMMAND_TOKEN_LENGTH,
  MAX_FILES_PER_TURN,
  MAX_FILE_EVIDENCE,
  MAX_PATH_LENGTH,
  evaluateAttribution,
} from "../src/core/attribution.ts";
import type { Attribution, FileAttribution } from "../src/core/attribution.ts";
import type { Analysis, RawMessage } from "../src/core/types.ts";import {
  BASE,
  assistant,
  fixture,
  idle,
  memorySource,
  session,
  simpleFixture,
  subagentFixture,
  textBlock,
  toolBlock,
  toolsFixture,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

const TOKENS = {
  input: 100,
  output: 10,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function closeTo(actual: number | null, expected: number): void {
  assert.ok(actual !== null, "expected a value, got null");
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${expected}, got ${actual}`,
  );
}

async function analysisOf(data: Fixture): Promise<Analysis> {
  const service = new ObservabilityService(memorySource(data));
  const dataset = await service.loadDataset(data.sessions[0]!.meta.id);
  return dataset.analysis;
}

function attributionOf(analysis: Analysis): Attribution {
  assert.ok(analysis.attribution, "attribution must be attached");
  return analysis.attribution;
}

function fileRow(attribution: Attribution, path: string): FileAttribution {
  const row = attribution.turns
    .flatMap((turn) => turn.files)
    .find((file) => file.path === path);
  assert.ok(row, `no file row for ${path}`);
  return row;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One step: read + edit of the same file, then a write with a file list. */
function writeFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 1_000,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { path: "src/core/attribution.ts" },
          output: "file body",
        }),
        toolBlock({
          name: "edit",
          created: BASE + 350,
          ran: BASE + 400,
          completed: BASE + 600,
          input: {
            filePath: "src/core/attribution.ts",
            oldString: "a",
            newString: "b",
          },
        }),
        toolBlock({
          name: "write",
          created: BASE + 650,
          ran: BASE + 700,
          completed: BASE + 900,
          input: {
            filePath: "docs/ATTRIBUTION.md",
            content: "PATCH_SENTINEL_TEXT",
          },
          metadata: {
            truncated: false,
            files: [
              {
                file: "docs/ATTRIBUTION.md",
                patch: "*** Begin Patch\n+PATCH_SENTINEL_TEXT\n*** End Patch",
              },
            ],
          },
        }),
      ],
      tokens: TOKENS,
      cost: 0.03,
    }),
    idle("msg_i1", 3, BASE + 1_100, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_write", {
        time: { created: BASE, updated: BASE + 1_100, busy: BASE, idle: BASE + 1_100 },
      }),
      messages,
    },
  ]);
}

/** Even allocation over two calls and one file each; cost 0.02. */
function allocationFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 900,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { path: "src/a.ts" },
        }),
        toolBlock({
          name: "write",
          created: BASE + 350,
          ran: BASE + 400,
          completed: BASE + 600,
          input: { filePath: "src/b.ts" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    idle("msg_i1", 3, BASE + 1_000, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_alloc", {
        time: { created: BASE, updated: BASE + 1_000, busy: BASE, idle: BASE + 1_000 },
      }),
      messages,
    },
  ]);
}

/** Shell calls plus a command line that must never be published. */
function commandFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 1_200,
      content: [
        toolBlock({
          name: "shell",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 400,
          input: { command: "npm run check -- --watch" },
          output: "ok",
        }),
        toolBlock({
          name: "shell",
          created: BASE + 500,
          ran: BASE + 600,
          completed: BASE + 800,
          input: { command: "npm test -- --test-name-pattern attribution" },
          output: "ok",
        }),
        toolBlock({
          name: "shell",
          created: BASE + 900,
          ran: BASE + 950,
          completed: BASE + 1_100,
          input: { command: "API_KEY=SECRET_SENTINEL_TOKEN curl https://x" },
          output: "no",
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    idle("msg_i1", 3, BASE + 1_300, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_cmd", {
        time: { created: BASE, updated: BASE + 1_300, busy: BASE, idle: BASE + 1_300 },
      }),
      messages,
    },
  ]);
}

/** A write tool whose path is credential-shaped: redaction must reach it. */
function secretPathFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 300,
      completed: BASE + 400,
      content: [
        toolBlock({
          name: "write",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { filePath: "notes/sk-abcdefghijklmnopqrstuvwxyz.txt", content: "x" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 500, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_secret", {
        time: { created: BASE, updated: BASE + 500, busy: BASE, idle: BASE + 500 },
      }),
      messages,
    },
  ]);
}

function wideFileFixture(files: number, opsPerFile = 1): Fixture {
  const content: unknown[] = [];
  for (let index = 0; index < files; index += 1) {
    for (let op = 0; op < opsPerFile; op += 1) {
      content.push(
        toolBlock({
          name: "read",
          created: BASE + 100 + index * 10 + op,
          ran: BASE + 120 + index * 10 + op,
          completed: BASE + 140 + index * 10 + op,
          input: { path: `src/f${index}.ts` },
        }),
      );
    }
  }
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 5_000,
      completed: BASE + 6_000,
      content,
      tokens: TOKENS,
      cost: 1,
    }),
    idle("msg_i1", 3, BASE + 6_100, "succeeded"),
  ];
  return fixture([
    {
      meta: session(`ses_attr_wide_${files}_${opsPerFile}`, {
        time: { created: BASE, updated: BASE + 6_100, busy: BASE, idle: BASE + 6_100 },
      }),
      messages,
    },
  ]);
}

function childFanOutFixture(children: number): Fixture {
  const content: unknown[] = [];
  for (let index = 0; index < children; index += 1) {
    content.push(
      toolBlock({
        name: "subagent",
        created: BASE + 100 + index * 10,
        ran: BASE + 120 + index * 10,
        completed: BASE + 140 + index * 10,
        input: { agent: `agent_${index}`, description: "Do the thing" },
        metadata: { truncated: false, sessionID: `ses_child_${index}` },
        output: "done",
      }),
    );
  }
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 5_000,
      completed: BASE + 6_000,
      content,
      tokens: TOKENS,
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 6_100, "succeeded"),
  ];
  return fixture([
    {
      meta: session(`ses_attr_fanout_${children}`, {
        time: { created: BASE, updated: BASE + 6_100, busy: BASE, idle: BASE + 6_100 },
      }),
      messages,
    },
  ]);
}

/** A file-touching step with no recorded cost. */
function noCostFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 300,
      completed: BASE + 400,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { path: "src/nocost.ts" },
        }),
      ],
      tokens: TOKENS,
      cost: null,
    }),
    idle("msg_i1", 3, BASE + 500, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_nocost", {
        time: { created: BASE, updated: BASE + 500, busy: BASE, idle: BASE + 500 },
      }),
      messages,
    },
  ]);
}

/** Quoted assignments keep their quoted segment; `npm` stays the executable. */
function quotedAssignmentFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 900,
      content: [
        toolBlock({
          name: "shell",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { command: 'PASSWORD="correct horse" npm test' },
        }),
        toolBlock({
          name: "shell",
          created: BASE + 350,
          ran: BASE + 400,
          completed: BASE + 500,
          input: { command: "TOKEN='a b c' bash -c 'echo hi'" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    idle("msg_i1", 3, BASE + 1_000, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_quoted", {
        time: { created: BASE, updated: BASE + 1_000, busy: BASE, idle: BASE + 1_000 },
      }),
      messages,
    },
  ]);
}

/** A `dir` input is accepted, but prose and credential-shaped tokens are not. */
function payloadShapeFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 900,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { path: "Rewrite the attribution evaluator prose" },
        }),
        toolBlock({
          name: "edit",
          created: BASE + 350,
          ran: BASE + 400,
          completed: BASE + 500,
          input: { file: "sk-abcdefghijklmnopqrstuvwxyz", oldString: "a", newString: "b" },
        }),
        toolBlock({
          name: "glob",
          created: BASE + 550,
          ran: BASE + 600,
          completed: BASE + 700,
          input: { dir: "src/core" },
        }),
        toolBlock({
          name: "write",
          created: BASE + 750,
          ran: BASE + 800,
          completed: BASE + 850,
          input: { directory: "src/trailing.", content: "x" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.04,
    }),
    idle("msg_i1", 3, BASE + 1_000, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_shape", {
        time: { created: BASE, updated: BASE + 1_000, busy: BASE, idle: BASE + 1_000 },
      }),
      messages,
    },
  ]);
}

/** One write call whose metadata lists two files: each takes half the step cost. */
function metadataMultiFileFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 900,
      content: [
        toolBlock({
          name: "write",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { content: "x" },
          metadata: {
            truncated: false,
            files: [{ file: "src/a.ts" }, { file: "src/b.ts" }],
          },
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    idle("msg_i1", 3, BASE + 1_000, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_multifile", {
        time: { created: BASE, updated: BASE + 1_000, busy: BASE, idle: BASE + 1_000 },
      }),
      messages,
    },
  ]);
}

/** 20 steps with distinct costs, so the file cap keeps a knowable top 12. */
function distinctCostFixture(): Fixture {
  const messages: RawMessage[] = [user("msg_u1", 1, BASE)];
  for (let index = 0; index < 20; index += 1) {
    messages.push(
      assistant({
        id: `msg_a${index}`,
        seq: index + 2,
        created: BASE + 100 + index * 100,
        streamed: BASE + 150 + index * 100,
        completed: BASE + 180 + index * 100,
        content: [
          toolBlock({
            name: "read",
            created: BASE + 110 + index * 100,
            ran: BASE + 120 + index * 100,
            completed: BASE + 140 + index * 100,
            input: { path: `src/f${index}.ts` },
          }),
        ],
        tokens: TOKENS,
        cost: (index + 1) * 0.01,
      }),
    );
  }
  messages.push(idle("msg_i1", 22, BASE + 3_000, "succeeded"));
  return fixture([
    {
      meta: session("ses_attr_distinct", {
        time: { created: BASE, updated: BASE + 3_000, busy: BASE, idle: BASE + 3_000 },
      }),
      messages,
    },
  ]);
}

/** A step whose recorded cost divides to a repeating binary fraction. */
function floatNoiseFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 900,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 250,
          input: { path: "src/a.ts" },
        }),
        toolBlock({
          name: "read",
          created: BASE + 350,
          ran: BASE + 400,
          completed: BASE + 450,
          input: { path: "src/b.ts" },
        }),
        toolBlock({
          name: "read",
          created: BASE + 550,
          ran: BASE + 600,
          completed: BASE + 650,
          input: { path: "src/c.ts" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.03,
    }),
    idle("msg_i1", 3, BASE + 1_000, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_float", {
        time: { created: BASE, updated: BASE + 1_000, busy: BASE, idle: BASE + 1_000 },
      }),
      messages,
    },
  ]);
}

/** The same file recorded with `./`, `/` and a Windows separator / case. */
function pathVariantFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 700,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 250,
          input: { path: "./src/a.ts" },
        }),
        toolBlock({
          name: "read",
          created: BASE + 300,
          ran: BASE + 350,
          completed: BASE + 400,
          input: { path: "src/a.ts" },
        }),
        toolBlock({
          name: "read",
          created: BASE + 450,
          ran: BASE + 500,
          completed: BASE + 550,
          input: { path: "src\\A.ts" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.03,
    }),
    idle("msg_i1", 3, BASE + 800, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_variants", {
        time: { created: BASE, updated: BASE + 800, busy: BASE, idle: BASE + 800 },
      }),
      messages,
    },
  ]);
}

/** One shell call whose only token is longer than a command name may be. */
function longCommandTokenFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 300,
      completed: BASE + 400,
      content: [
        toolBlock({
          name: "shell",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { command: "a".repeat(MAX_COMMAND_TOKEN_LENGTH + 1) },
        }),
      ],
      tokens: TOKENS,
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 500, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_longcmd", {
        time: { created: BASE, updated: BASE + 500, busy: BASE, idle: BASE + 500 },
      }),
      messages,
    },
  ]);
}

/** One read path longer than `MAX_PATH_LENGTH`. */
function longPathFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 300,
      completed: BASE + 400,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { path: `src/${"a".repeat(MAX_PATH_LENGTH)}` },
        }),
      ],
      tokens: TOKENS,
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 500, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_longpath", {
        time: { created: BASE, updated: BASE + 500, busy: BASE, idle: BASE + 500 },
      }),
      messages,
    },
  ]);
}

/** Nine shell calls to the same command: row count 9, evidence capped at 6. */
function repeatedCommandFixture(): Fixture {
  const content: unknown[] = [];
  for (let index = 0; index < 9; index += 1) {
    content.push(
      toolBlock({
        name: "shell",
        created: BASE + 100 + index * 50,
        ran: BASE + 110 + index * 50,
        completed: BASE + 120 + index * 50,
        input: { command: "npm run check" },
      }),
    );
  }
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 1_000,
      completed: BASE + 1_200,
      content,
      tokens: TOKENS,
      cost: 0.05,
    }),
    idle("msg_i1", 3, BASE + 1_300, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_attr_repeatcmd", {
        time: { created: BASE, updated: BASE + 1_300, busy: BASE, idle: BASE + 1_300 },
      }),
      messages,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Measured paths and derived cost shares
// ---------------------------------------------------------------------------

test("read tools yield measured file paths with derived cost shares", async () => {
  const analysis = await analysisOf(toolsFixture());
  const attribution = attributionOf(analysis);

  const file = fileRow(attribution, "src/index.ts");
  assert.equal(file.basis, "measured");
  assert.deepEqual(file.ops, { read: 1, write: 0 });
  // toolsFixture step 1: cost 0.02 across two tool calls, one of which touches
  // a file.
  closeTo(file.costShare.value, 0.01);
  assert.equal(file.costShare.basis, "derived");
  assert.match(file.costShare.note ?? "", /evenly/);
  assert.ok(file.eventIDs.length >= 1);
  // The grep call records a pattern, not a path: no file row comes from it.
  assert.equal(
    attribution.turns.flatMap((turn) => turn.files).some((row) => row.path === "TODO"),
    false,
  );
});

test("write tools yield measured paths from input and from metadata.files", async () => {
  const analysis = await analysisOf(writeFixture());
  const attribution = attributionOf(analysis);
  const files = attribution.turns[0]!.files;

  const edited = fileRow(attribution, "src/core/attribution.ts");
  assert.deepEqual(edited.ops, { read: 1, write: 1 });
  closeTo(edited.costShare.value, 0.02);

  const written = fileRow(attribution, "docs/ATTRIBUTION.md");
  assert.deepEqual(written.ops, { read: 0, write: 1 });
  closeTo(written.costShare.value, 0.01);

  // Highest share first, so the cap keeps the files that cost the turn.
  assert.deepEqual(
    files.map((file) => file.path),
    ["src/core/attribution.ts", "docs/ATTRIBUTION.md"],
  );
});

test("per-file cost is allocated evenly across a step's tool calls", async () => {
  const analysis = await analysisOf(allocationFixture());
  const attribution = attributionOf(analysis);

  closeTo(fileRow(attribution, "src/a.ts").costShare.value, 0.01);
  closeTo(fileRow(attribution, "src/b.ts").costShare.value, 0.01);
  for (const file of attribution.turns[0]!.files) {
    assert.equal(file.costShare.basis, "derived");
    assert.match(file.costShare.note ?? "", /divided evenly/);
  }
});

test("a file touched without a recorded step cost keeps its share unavailable", async () => {
  const analysis = await analysisOf(noCostFixture());
  const file = fileRow(attributionOf(analysis), "src/nocost.ts");

  assert.equal(file.costShare.value, null);
  assert.equal(file.costShare.basis, "unavailable");
  assert.match(file.costShare.note ?? "", /cost/);
  assert.equal(file.basis, "measured");
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

test("shell commands are reduced to their first token, counted per turn", async () => {
  const analysis = await analysisOf(commandFixture());
  const commands = attributionOf(analysis).turns[0]!.commands;

  const npm = commands.find((command) => command.name === "npm");
  assert.ok(npm);
  assert.equal(npm.count, 2);
  assert.equal(npm.basis, "derived");
  assert.equal(npm.eventIDs.length, 2);
  // The credential assignment is skipped, so the executable is still found.
  assert.deepEqual(
    commands.map((command) => command.name),
    ["npm", "curl"],
  );
  assert.equal(commands.find((command) => command.name === "curl")?.count, 1);
});

test("a first token that is not shell-token shaped yields no command row", async () => {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 300,
      completed: BASE + 400,
      content: [
        toolBlock({
          name: "shell",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: { command: "--password=hunter2 do-something" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 500, "succeeded"),
  ];
  const analysis = await analysisOf(
    fixture([
      {
        meta: session("ses_attr_badtoken"),
        messages,
      },
    ]),
  );

  assert.equal(analysis.attribution, undefined);
});

test("a quoted env assignment keeps its value out of the command name", async () => {
  const commands = attributionOf(await analysisOf(quotedAssignmentFixture())).turns[0]!
    .commands;

  assert.deepEqual(
    commands.map((command) => command.name),
    ["bash", "npm"],
  );
  const text = JSON.stringify(commands);
  assert.equal(text.includes("horse"), false, "the quoted value must not leak");
  assert.equal(text.includes("correct"), false);
  assert.equal(text.includes("PASSWORD"), false);
});

test("bare punctuation is never accepted as a command name", async () => {
  const content = ["--", ".", "/", "npm"].map((command, index) =>
    toolBlock({
      name: "shell",
      created: BASE + 100 + index * 50,
      ran: BASE + 110 + index * 50,
      completed: BASE + 120 + index * 50,
      input: { command },
    }),
  );
  const analysis = await analysisOf(
    fixture([
      {
        meta: session("ses_attr_punct"),
        messages: [
          user("msg_u1", 1, BASE),
          assistant({
            id: "msg_a1",
            seq: 2,
            created: BASE + 100,
            streamed: BASE + 400,
            completed: BASE + 500,
            content,
            tokens: TOKENS,
            cost: 0.01,
          }),
          idle("msg_i1", 3, BASE + 600, "succeeded"),
        ],
      },
    ]),
  );

  const names = attributionOf(analysis).turns[0]!.commands.map((row) => row.name);
  assert.deepEqual(names, ["npm"]);
});

// ---------------------------------------------------------------------------
// Payload neutrality
// ---------------------------------------------------------------------------

test("patch text and full command lines never enter the DTO", async () => {
  const written = attributionOf(await analysisOf(writeFixture()));
  const commands = attributionOf(await analysisOf(commandFixture()));
  const text = JSON.stringify({ written, commands });

  for (const sentinel of [
    "PATCH_SENTINEL_TEXT",
    "*** Begin Patch",
    "run check",
    "test-name-pattern",
    "SECRET_SENTINEL_TOKEN",
    "https://x",
  ]) {
    assert.equal(text.includes(sentinel), false, `payload leaked: ${sentinel}`);
  }
  // The assertion is not vacuous: the rows themselves are present.
  assert.ok(written.turns[0]!.files.length > 0);
  assert.ok(commands.turns[0]!.commands.length > 0);
});

test("a description is only accepted as a file path when it is path-shaped", async () => {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 300,
      completed: BASE + 400,
      content: [
        toolBlock({
          name: "edit",
          created: BASE + 150,
          ran: BASE + 200,
          completed: BASE + 300,
          input: {
            description: "Rewrite the attribution evaluator prose",
            oldString: "a",
            newString: "b",
          },
        }),
      ],
      tokens: TOKENS,
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 500, "succeeded"),
  ];
  const analysis = await analysisOf(
    fixture([{ meta: session("ses_attr_desc"), messages }]),
  );

  assert.equal(analysis.attribution, undefined);
});

test("prose and credential-shaped path keys never become file rows", async () => {
  const attribution = attributionOf(await analysisOf(payloadShapeFixture()));
  const files = attribution.turns[0]!.files;

  // `dir` is accepted, so the rider exists and the negative asserts are real.
  assert.deepEqual(
    files.map((file) => file.path),
    ["src/core"],
  );
  assert.deepEqual(files[0]!.ops, { read: 1, write: 0 });
  const text = JSON.stringify(files);
  assert.equal(text.includes("Rewrite the attribution"), false);
  assert.equal(text.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(text.includes("src/trailing."), false);
});

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

test("subagent nesting yields measured subtasks with their recorded agent", async () => {
  const analysis = await analysisOf(subagentFixture());
  const attribution = attributionOf(analysis);

  const subtasks = attribution.turns.flatMap((turn) => turn.subtasks);
  assert.deepEqual(subtasks, [
    { sessionID: "ses_child", agent: "explorer", basis: "measured" },
  ]);
});

test("subtask evidence is capped at the delegation assessment cap", async () => {
  const analysis = await analysisOf(childFanOutFixture(12));
  const subtasks = attributionOf(analysis).turns.flatMap((turn) => turn.subtasks);

  assert.equal(subtasks.length, 8);
  assert.deepEqual(
    subtasks.map((subtask) => subtask.sessionID),
    Array.from({ length: 8 }, (_, index) => `ses_child_${index}`),
  );
});

// ---------------------------------------------------------------------------
// Caps, absence and determinism
// ---------------------------------------------------------------------------

test("files per turn are capped, keeping the highest cost shares", async () => {
  const analysis = await analysisOf(wideFileFixture(20));
  const files = attributionOf(analysis).turns[0]!.files;

  assert.equal(files.length, MAX_FILES_PER_TURN);
  for (const file of files) assert.equal(file.basis, "measured");
});

test("the file cap keeps the 12 highest distinct shares and reports the rest", async () => {
  const analysis = await analysisOf(distinctCostFixture());
  const turn = attributionOf(analysis).turns[0]!;

  assert.equal(turn.files.length, MAX_FILES_PER_TURN);
  // Step i costs (i + 1) * 0.01, so the top 12 are steps 19 down to 8.
  assert.deepEqual(
    turn.files.map((file) => file.path),
    Array.from({ length: 12 }, (_, offset) => `src/f${19 - offset}.ts`),
  );
  for (const [offset, file] of turn.files.entries()) {
    closeTo(file.costShare.value, (20 - offset) * 0.01);
  }
  assert.equal(turn.filesTruncated, 8);
  assert.equal(turn.commandsTruncated, 0);
});

test("one call's metadata file list splits the step cost evenly", async () => {
  const files = attributionOf(await analysisOf(metadataMultiFileFixture())).turns[0]!
    .files;

  assert.deepEqual(
    files.map((file) => [file.path, file.costShare.value]),
    [
      ["src/a.ts", 0.01],
      ["src/b.ts", 0.01],
    ],
  );
  for (const file of files) {
    assert.deepEqual(file.ops, { read: 0, write: 1 });
    assert.equal(file.costShare.basis, "derived");
  }
});

test("cost shares are rounded to a 1e-12 grid", async () => {
  const files = attributionOf(await analysisOf(floatNoiseFixture())).turns[0]!.files;

  assert.deepEqual(
    files.map((file) => file.path),
    ["src/a.ts", "src/b.ts", "src/c.ts"],
  );
  for (const file of files) {
    // 0.03 / 3 is 0.009999999999999998 in binary floating point.
    assert.equal(file.costShare.value, 0.01);
  }
  assert.equal(JSON.stringify(files).includes("00999999"), false);
});

test("path variants share one accumulator and keep the first spelling", async () => {
  const files = attributionOf(await analysisOf(pathVariantFixture())).turns[0]!.files;
  const merged = files.find((file) => file.path === "./src/a.ts");

  assert.ok(merged, "the first recorded spelling is the displayed path");
  assert.equal(merged.path, "./src/a.ts");
  assert.equal(merged.ops.read, process.platform === "win32" ? 3 : 2);
  if (process.platform === "win32") {
    assert.equal(files.length, 1);
  } else {
    // Case-sensitive semantics keep `src\A.ts` distinct from `src/a.ts`.
    assert.ok(files.some((file) => file.path === "src\\A.ts"));
  }
});

test("a path longer than the path cap yields no row", async () => {
  const analysis = await analysisOf(longPathFixture());

  assert.equal(analysis.attribution, undefined);
});

test("per-file evidence links are capped", async () => {
  const analysis = await analysisOf(wideFileFixture(1, 9));
  const file = attributionOf(analysis).turns[0]!.files[0]!;

  assert.equal(file.ops.read, 9);
  assert.equal(file.eventIDs.length, MAX_FILE_EVIDENCE);
});

test("command evidence links are capped", async () => {
  const turn = attributionOf(await analysisOf(repeatedCommandFixture())).turns[0]!;

  assert.equal(turn.commands.length, 1);
  assert.equal(turn.commands[0]!.name, "npm");
  assert.equal(turn.commands[0]!.count, 9);
  assert.equal(turn.commands[0]!.eventIDs.length, MAX_COMMAND_EVIDENCE);
});

test("a command token longer than the token cap yields no row", async () => {
  const analysis = await analysisOf(longCommandTokenFixture());

  assert.equal(analysis.attribution, undefined);
});

test("commands per turn are capped and the dropped count is reported", async () => {
  const content: unknown[] = [];
  for (let index = 0; index < 12; index += 1) {
    content.push(
      toolBlock({
        name: "shell",
        created: BASE + 100 + index * 10,
        ran: BASE + 120 + index * 10,
        completed: BASE + 140 + index * 10,
        input: { command: `tool${index} --flag` },
      }),
    );
  }
  const analysis = await analysisOf(
    fixture([
      {
        meta: session("ses_attr_manycmd"),
        messages: [
          user("msg_u1", 1, BASE),
          assistant({
            id: "msg_a1",
            seq: 2,
            created: BASE + 100,
            streamed: BASE + 1_000,
            completed: BASE + 1_200,
            content,
            tokens: TOKENS,
            cost: 0.01,
          }),
          idle("msg_i1", 3, BASE + 1_300, "succeeded"),
        ],
      },
    ]),
  );
  const turn = attributionOf(analysis).turns[0]!;

  assert.equal(turn.commands.length, MAX_COMMANDS_PER_TURN);
  assert.equal(turn.commandsTruncated, 12 - MAX_COMMANDS_PER_TURN);
});

test("attribution is absent when no turn records a signal", async () => {
  const analysis = await analysisOf(simpleFixture());

  assert.equal(analysis.attribution, undefined);
  assert.equal(evaluateAttribution(analysis), null);
});

test("a malformed analysis yields the absent rider instead of throwing", () => {
  assert.equal(evaluateAttribution({} as Analysis), null);
  assert.equal(
    evaluateAttribution({ events: [], turns: "nope" } as unknown as Analysis),
    null,
  );
  assert.doesNotThrow(() =>
    evaluateAttribution({ events: [], turns: [{ steps: "nope" }] } as unknown as Analysis),
  );
  assert.equal(
    evaluateAttribution({ events: [], turns: [{ steps: "nope" }] } as unknown as Analysis),
    null,
  );
});

test("attribution carries the turn identity, trigger and evidence", async () => {
  const analysis = await analysisOf(writeFixture());
  const turn = analysis.turns[0]!;
  const row = attributionOf(analysis).turns[0]!;

  assert.equal(row.turnID, turn.id);
  assert.equal(row.taskID, turn.id);
  assert.equal(row.turnIndex, turn.index);
  assert.deepEqual(row.trigger, turn.trigger);
  assert.equal(row.trigger.kind, "user");
  assert.equal(row.trigger.label, "User message");
  assert.ok(row.eventIDs.length > 0);
  assert.ok(row.eventIDs.length <= 10);
});

test("the basis notes always state the cost basis and the missing commit link", async () => {
  const attribution = attributionOf(await analysisOf(writeFixture()));
  const joined = attribution.basisNotes.join(" ");

  assert.match(joined, /unavailable/);
  assert.match(joined, /no git data/);
  assert.match(joined, /docs\/DATA-SOURCES\.md/);
  assert.match(joined, /derived/);
  assert.match(joined, /evenly/);
  assert.match(joined, /first recorded shell token/);
});

test("evaluation is deterministic", async () => {
  const analysis = await analysisOf(writeFixture());

  assert.deepEqual(evaluateAttribution(analysis), evaluateAttribution(analysis));
});

test("only turns with a signal are listed, in recorded order", async () => {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 300,
      completed: BASE + 400,
      content: [textBlock("nothing tool-shaped")],
      tokens: TOKENS,
      cost: 0.01,
    }),
    user("msg_u2", 3, BASE + 500),
    assistant({
      id: "msg_a2",
      seq: 4,
      created: BASE + 600,
      streamed: BASE + 800,
      completed: BASE + 900,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 650,
          ran: BASE + 700,
          completed: BASE + 800,
          input: { path: "src/only.ts" },
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    idle("msg_i1", 5, BASE + 1_000, "succeeded"),
  ];
  const analysis = await analysisOf(
    fixture([{ meta: session("ses_attr_two"), messages }]),
  );
  const turns = attributionOf(analysis).turns;

  assert.equal(analysis.turns.length, 2);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.turnIndex, 2);
  assert.equal(turns[0]!.files[0]!.path, "src/only.ts");
});

// ---------------------------------------------------------------------------
// Service path: redaction parity and export
// ---------------------------------------------------------------------------

test("attribution redacts by default and reveals explicitly", async () => {
  const data = secretPathFixture();
  const id = data.sessions[0]!.meta.id;
  const service = new ObservabilityService(memorySource(data));

  const redacted = await service.analyze(id);
  const redactedText = JSON.stringify(redacted.analysis.attribution);
  assert.equal(redactedText.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(redactedText, /\[REDACTED/);
  assert.ok(redacted.analysis.attribution);

  const revealed = await service.analyze(id, { reveal: true });
  const path = revealed.analysis.attribution?.turns[0]?.files[0]?.path ?? "";
  assert.equal(path, "notes/sk-abcdefghijklmnopqrstuvwxyz.txt");
});

test("attribution rides the export verbatim and stays redacted", async () => {
  const data = secretPathFixture();
  const id = data.sessions[0]!.meta.id;
  const service = new ObservabilityService(memorySource(data));

  const exported = await service.export(id, { format: "json" });
  assert.equal(exported.redacted, true);
  assert.equal(exported.content.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);

  const payload = JSON.parse(exported.content) as {
    analysis: Analysis;
  };
  const attribution = payload.analysis.attribution;
  assert.ok(attribution, "the export must carry the attribution rider");
  assert.deepEqual(
    attribution.turns[0]!.files.map((file) => file.path),
    ["notes/[REDACTED:openai-key].txt"],
  );
  assert.match(attribution.basisNotes.join(" "), /no git data/);

  const revealed = await service.export(id, { format: "json", reveal: true });
  const revealedPayload = JSON.parse(revealed.content) as { analysis: Analysis };
  assert.equal(
    revealedPayload.analysis.attribution?.turns[0]?.files[0]?.path,
    "notes/sk-abcdefghijklmnopqrstuvwxyz.txt",
  );
});

test("the analysis endpoint nulls tool payloads while attribution stays", async () => {
  const data = writeFixture();
  const id = data.sessions[0]!.meta.id;
  const service = new ObservabilityService(memorySource(data));
  const { analysis } = await service.analyze(id);

  const tool = analysis.turns[0]!.steps[0]!.toolCalls[0]!;
  assert.equal(tool.input, null);
  assert.equal(tool.metadata, null);
  assert.ok(analysis.attribution);
  // The rider itself is payload-neutral: patch text is not reachable from it.
  assert.equal(
    JSON.stringify(analysis.attribution).includes("PATCH_SENTINEL_TEXT"),
    false,
  );
});
