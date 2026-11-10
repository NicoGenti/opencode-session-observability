import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import { evaluateDiagnostics } from "../src/core/diagnostics.ts";
import { listDiagnosticEpisodes } from "../src/core/episodes.ts";
import type { DiagnosticEpisode } from "../src/core/episodes.ts";
import type { RawMessage } from "../src/core/types.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  memorySource,
  session,
  textBlock,
  toolBlock,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

let callCounter = 0;

function diagnosticsSession(messages: RawMessage[]): Fixture {
  return fixture([
    {
      meta: session("ses_diag", {
        time: {
          created: BASE,
          updated: BASE + 20_000,
          busy: BASE,
          idle: BASE + 19_000,
        },
      }),
      messages,
    },
  ]);
}

function assistantMessage(
  id: string,
  seq: number,
  created: number,
  content: unknown[],
): RawMessage {
  return assistant({
    id,
    seq,
    created,
    streamed: created + 400,
    completed: created + 500,
    content,
  });
}

function call(
  name: string,
  input: unknown,
  options: {
    at: number;
    status?: "completed" | "error";
    error?: Record<string, unknown>;
  },
): unknown {
  callCounter += 1;
  return toolBlock({
    callID: `call_${callCounter}`,
    name,
    created: options.at,
    ran: options.at + 5,
    completed: options.at + 10,
    status: options.status ?? "completed",
    input,
    output: options.status === "error" ? "" : "ok",
    error: options.error,
  });
}

async function episodes(data: Fixture): Promise<DiagnosticEpisode[]> {
  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", {
    reveal: true,
  });
  return listDiagnosticEpisodes(
    evaluateDiagnostics(events, analysis),
    analysis.session.id,
  );
}

test("maps a recovered incident to one episode carrying its event ids", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 400 }),
    ]),
    idle("i1", 3, BASE + 600, "succeeded"),
  ]);

  const list = await episodes(data);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: "ses_diag:ses_diag:t1:read:a1:0",
    sessionID: "ses_diag",
    turnID: "ses_diag:t1",
    turnIndex: 1,
    tool: "read",
    attemptCount: 2,
    recovery: "recovered",
    similarity: "identical",
    failureEventIDs: ["a1:0", "a1:1"],
    recoveryEventID: "a1:2",
  });
});

test("maps an unrecovered incident with no recovery event id", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300, status: "error" }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const list = await episodes(data);
  assert.equal(list.length, 1);
  const episode = list[0]!;
  assert.equal(episode.tool, "read");
  assert.equal(episode.attemptCount, 2);
  assert.equal(episode.recovery, "no-recovery-evidence");
  assert.equal(episode.similarity, "unknown");
  assert.deepEqual(episode.failureEventIDs, ["a1:0", "a1:1"]);
  assert.equal(episode.recoveryEventID, null);
  assert.equal(episode.id, "ses_diag:ses_diag:t1:read:a1:0");
});

test("carries a recovery id only for recovered episodes", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
    user("u2", 4, BASE + 600),
    assistantMessage("a2", 5, BASE + 700, [
      call("read", { path: "src/b.ts" }, { at: BASE + 800, status: "error" }),
      // A different tool's success: possible recovery, but no same-tool id.
      call("grep", { pattern: "b" }, { at: BASE + 900 }),
    ]),
    idle("i2", 6, BASE + 1_100, "succeeded"),
    user("u3", 7, BASE + 1_200),
    assistantMessage("a3", 8, BASE + 1_300, [
      call("shell", { command: "ls" }, { at: BASE + 1_400, status: "error" }),
      textBlock("could not list the directory"),
    ]),
    idle("i3", 9, BASE + 1_600, "succeeded"),
    user("u4", 10, BASE + 1_700),
    assistantMessage("a4", 11, BASE + 1_800, [
      // Truncated input: the comparison cannot be made, so no id is recorded.
      call("grep", { pattern: "needle…" }, { at: BASE + 1_900, status: "error" }),
      call("grep", { pattern: "needle" }, { at: BASE + 2_000 }),
    ]),
    idle("i4", 12, BASE + 2_200, "succeeded"),
  ]);

  const list = await episodes(data);
  assert.equal(list.length, 4);
  assert.deepEqual(
    list.map((episode) => episode.recovery),
    [
      "recovered",
      "possible-recovery",
      "no-recovery-evidence",
      "insufficient-data",
    ],
  );
  assert.deepEqual(
    list.map((episode) => episode.recoveryEventID),
    ["a1:1", null, null, null],
  );
  assert.deepEqual(
    list.map((episode) => episode.failureEventIDs),
    [["a1:0"], ["a2:0"], ["a3:0"], ["a4:0"]],
  );
});

test("orders episodes by turn and by recorded position of the first failure", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("grep", { pattern: "a" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 400 }),
      call("grep", { pattern: "a" }, { at: BASE + 500 }),
    ]),
    idle("i1", 3, BASE + 700, "succeeded"),
    user("u2", 4, BASE + 800),
    assistantMessage("a2", 5, BASE + 900, [
      call("read", { path: "src/b.ts" }, { at: BASE + 1_000, status: "error" }),
    ]),
    idle("i2", 6, BASE + 1_200, "succeeded"),
  ]);

  const list = await episodes(data);
  assert.deepEqual(
    list.map((episode) => [episode.turnIndex, episode.tool]),
    [
      [1, "grep"],
      [1, "read"],
      [2, "read"],
    ],
  );
  assert.deepEqual(
    list.map((episode) => episode.id),
    [
      "ses_diag:ses_diag:t1:grep:a1:0",
      "ses_diag:ses_diag:t1:read:a1:1",
      "ses_diag:ses_diag:t2:read:a2:0",
    ],
  );
  // Every id is unique, so an episode is addressable on its own.
  assert.equal(new Set(list.map((episode) => episode.id)).size, list.length);
});

test("returns an empty episode list when nothing failed", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [textBlock("all good")]),
    idle("i1", 3, BASE + 300, "succeeded"),
  ]);

  const list = await episodes(data);
  assert.deepEqual(list, []);
});

test("is pure: repeated enumeration is deep-equal and copies the incident ids", async () => {
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", { path: "src/a.ts" }, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", {
    reveal: true,
  });
  const diagnostics = evaluateDiagnostics(events, analysis);
  const incidentsBefore = structuredClone(diagnostics.incidents);

  const first = listDiagnosticEpisodes(diagnostics, analysis.session.id);
  const second = listDiagnosticEpisodes(diagnostics, analysis.session.id);

  assert.deepEqual(first, second);
  assert.deepEqual(diagnostics.incidents, incidentsBefore);
  // The episode owns its id list: mutating it cannot change the incident.
  first[0]!.failureEventIDs.push("injected");
  assert.deepEqual(diagnostics.incidents[0]!.failureEventIDs, ["a1:0"]);
});

test("extracts event ids from a cyclic recorded input", async () => {
  const cyclic: Record<string, unknown> = { path: "src/a.ts" };
  cyclic.self = cyclic;
  const data = diagnosticsSession([
    user("u1", 1, BASE),
    assistantMessage("a1", 2, BASE + 100, [
      call("read", cyclic, { at: BASE + 200, status: "error" }),
      call("read", { path: "src/a.ts" }, { at: BASE + 300 }),
    ]),
    idle("i1", 3, BASE + 500, "succeeded"),
  ]);

  const service = new ObservabilityService(memorySource(data));
  const { analysis, events } = await service.analyze("ses_diag", {
    reveal: true,
  });
  let list: DiagnosticEpisode[] = [];
  assert.doesNotThrow(() => {
    list = listDiagnosticEpisodes(
      evaluateDiagnostics(events, analysis),
      analysis.session.id,
    );
  });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]!.failureEventIDs, ["a1:0"]);
  assert.equal(typeof list[0]!.id, "string");
  assert.equal(list[0]!.recoveryEventID, "a1:1");
});
