/**
 * Per-turn attribution of the recorded session to the task, the files and the
 * shell commands involved in each turn.
 *
 * The evaluator never performs I/O, never reads the clock and never re-reads
 * the source: it is a pure function of an already-loaded `Analysis`. It runs
 * once, in `loadDataset`, so every downstream path (analysis, export, UI) reads
 * the same object verbatim.
 *
 * Two structural rules keep the DTO safe and honest:
 *
 * - No payload-shaped text ever enters it. File paths come from recorded tool
 *   `input` path fields and write-tool file lists; patch text is never read.
 *   Command rows carry the first shell token only, never the command line.
 *   Everything still passes through the service's `redactValue` path like every
 *   other analysis rider.
 * - Every value says how it was obtained. A recorded path is `measured`; a
 *   per-file cost share is `derived` (a step's recorded cost divided evenly,
 *   never the session row's auxiliary-inclusive total); commit linkage is
 *   `unavailable` because the session database records no git data at all.
 */

import { MAX_ASSESSED_CHILDREN } from "./delegation.ts";
import { MAX_EVENT_LINKS } from "./health.ts";
import { metric } from "./types.ts";
import type {
  Analysis,
  EventIndexEntry,
  Metric,
  Step,
  ToolCallDetail,
  Turn,
  TurnTrigger,
} from "./types.ts";

/** Turn-level file cap: the breakdown stays scannable on a wide session. */
export const MAX_FILES_PER_TURN = 12;
/** Evidence links kept per file row. */
export const MAX_FILE_EVIDENCE = 6;
/** Turn-level command cap. */
export const MAX_COMMANDS_PER_TURN = 8;
/** Evidence links kept per command row. */
export const MAX_COMMAND_EVIDENCE = 6;
/** Longest recorded path kept; anything longer is not a path we can trust. */
export const MAX_PATH_LENGTH = 400;
/** Longest first-token kept; a command name is short by definition. */
export const MAX_COMMAND_TOKEN_LENGTH = 64;

/** One file the turn touched, with the two op counters kept apart. */
export interface FileAttribution {
  path: string;
  ops: { read: number; write: number };
  /**
   * `derived`: the recorded step cost divided evenly across the step's tool
   * calls, then across the files a call touched. `unavailable` when no step
   * that touched this path recorded a cost.
   */
  costShare: Metric;
  basis: "measured";
  /** Capped tool-call event ids that touched the path. */
  eventIDs: string[];
}

/** One shell program the turn ran, by name only. */
export interface CommandAttribution {
  /** First recorded shell token; the command line itself is never included. */
  name: string;
  count: number;
  basis: "derived";
  eventIDs: string[];
}

/** One delegated child session recorded inside the turn. */
export interface SubtaskAttribution {
  sessionID: string;
  agent: string | null;
  basis: "measured";
}

/**
 * One turn's attribution. `taskID` equals `turnID`: the turn is the only task
 * unit the session database records, so no other grouping is invented.
 */
export interface TurnAttribution {
  turnID: string;
  turnIndex: number;
  taskID: string;
  trigger: TurnTrigger;
  files: FileAttribution[];
  commands: CommandAttribution[];
  subtasks: SubtaskAttribution[];
  eventIDs: string[];
}

export interface Attribution {
  /** Only turns that yielded at least one signal, in recorded turn order. */
  turns: TurnAttribution[];
  basisNotes: string[];
}

/**
 * The standing basis notes. Deterministic phrases only: they restate where each
 * value comes from and which linkage the recorder cannot supply.
 */
const BASIS_NOTES: readonly string[] = Object.freeze([
  "File paths are measured: they come from recorded tool inputs and write-tool file lists.",
  "Per-file cost shares are derived: each step's recorded cost is divided evenly across its tool calls, then across the files a call touched; calls that touch no file are not allocated.",
  "Command names are derived: the first recorded shell token only; full command text is never included.",
  "Commit linkage is unavailable: the session database records no git data (see docs/DATA-SOURCES.md).",
]);

/** Tool names whose `input` path fields name a read target. */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "ls",
  "view",
  "search",
]);

/** Tool names whose `input` path fields name a write target. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "apply_patch",
  "create",
]);

/** Tools whose input carries the shell command line. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["shell", "bash"]);

/** Input keys that carry a path verbatim. */
const PATH_KEYS: readonly string[] = ["path", "filePath", "file", "dir", "directory"];

/** Input keys that carry prose; only accepted when the value is path-shaped. */
const DESCRIPTION_KEYS: readonly string[] = ["description"];

/**
 * A first token we are willing to publish: no whitespace, no `=`, no quotes —
 * so an inline credential assignment or a `--flag=secret` pair can never become
 * a command name.
 */
const COMMAND_TOKEN = /^[A-Za-z0-9_./:\\-]+$/;

/** A leading `NAME=value` environment assignment is not the executable. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Deduplicates, drops empty ids and caps the list in recorded order. */
function capEvidenceIDs(ids: readonly string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATH_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * A prose `description` is only treated as a path when it cannot be prose: one
 * token, and shaped like a path. This keeps free text out of the DTO while
 * still accepting the description-shaped path some tools record.
 */
function pathShaped(value: string): boolean {
  return !/\s/.test(value) && /[\\/.]/.test(value) && value.length <= MAX_PATH_LENGTH;
}

interface ToolPath {
  path: string;
  op: "read" | "write";
}

/**
 * Paths a single tool call touched. `input` path keys are read or write
 * depending on the tool family; a write tool's `metadata.files[].file` list is
 * always a write. `metadata.files[].patch` is deliberately never read.
 */
function toolPaths(tool: ToolCallDetail): ToolPath[] {
  const out: ToolPath[] = [];
  const seen = new Set<string>();
  const input = recordOf(tool.input);
  const op: "read" | "write" = WRITE_TOOL_NAMES.has(tool.name) ? "write" : "read";
  const push = (value: unknown, kind: "read" | "write"): void => {
    const path = cleanPath(value);
    if (path === null || seen.has(path)) return;
    seen.add(path);
    out.push({ path, op: kind });
  };
  for (const key of PATH_KEYS) push(input[key], op);
  for (const key of DESCRIPTION_KEYS) {
    const value = input[key];
    if (typeof value === "string" && pathShaped(value)) push(value, op);
  }
  const metadata = recordOf(tool.metadata);
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  for (const entry of files) {
    const record = recordOf(entry);
    push(record.file ?? record.path ?? record.filePath, "write");
  }
  return out;
}

/**
 * First executable token of a recorded shell command. Leading `KEY=value`
 * assignments are skipped so a credential assignment cannot become the name;
 * a first token that is not shell-token shaped yields no row at all.
 */
function firstCommandToken(input: unknown): string | null {
  const record = recordOf(input);
  const command = record.command ?? record.script ?? record.cmd;
  if (typeof command !== "string") return null;
  for (const raw of command.trim().split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (token.length === 0) continue;
    if (ENV_ASSIGNMENT.test(token)) continue;
    if (token.length > MAX_COMMAND_TOKEN_LENGTH) return null;
    return COMMAND_TOKEN.test(token) ? token : null;
  }
  return null;
}

/**
 * Tool-call event ids of a step, in recorded order. `Step.toolCalls` and the
 * step's `tool` events are both built from the same recorded content-block
 * order, so index `i` of each list names the same call.
 */
function toolEventIDs(
  step: Step,
  eventByID: ReadonlyMap<string, EventIndexEntry>,
): string[] {
  const out: string[] = [];
  for (const eventID of step.eventIDs) {
    if (eventByID.get(eventID)?.kind === "tool") out.push(eventID);
  }
  return out;
}

interface FileAccumulator {
  path: string;
  read: number;
  write: number;
  cost: number | null;
  eventIDs: string[];
}

interface CommandAccumulator {
  name: string;
  count: number;
  eventIDs: string[];
}

function shareOf(
  cost: number | null,
  toolCalls: number,
  filesInCall: number,
): number | null {
  if (cost === null || toolCalls <= 0 || filesInCall <= 0) return null;
  return cost / toolCalls / filesInCall;
}

function fileRows(files: ReadonlyMap<string, FileAccumulator>): FileAttribution[] {
  const rows: FileAttribution[] = [];
  for (const item of files.values()) {
    rows.push({
      path: item.path,
      ops: { read: item.read, write: item.write },
      costShare:
        item.cost === null
          ? metric(
              null,
              "unavailable",
              "no step that touched this path recorded a cost",
            )
          : metric(
              item.cost,
              "derived",
              "step cost divided evenly across the step's tool calls and the files each call touched",
            ),
      basis: "measured",
      eventIDs: capEvidenceIDs(item.eventIDs, MAX_FILE_EVIDENCE),
    });
  }
  // Highest share first so the cap keeps the files that actually cost the turn;
  // ties resolve by path so the order is total and deterministic.
  rows.sort(
    (left, right) =>
      (right.costShare.value ?? 0) - (left.costShare.value ?? 0) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  return rows.slice(0, MAX_FILES_PER_TURN);
}

function commandRows(
  commands: ReadonlyMap<string, CommandAccumulator>,
): CommandAttribution[] {
  const rows: CommandAttribution[] = [...commands.values()].map((item) => ({
    name: item.name,
    count: item.count,
    basis: "derived" as const,
    eventIDs: capEvidenceIDs(item.eventIDs, MAX_COMMAND_EVIDENCE),
  }));
  rows.sort(
    (left, right) =>
      right.count - left.count ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  return rows.slice(0, MAX_COMMANDS_PER_TURN);
}

function attributeTurn(
  turn: Turn,
  eventByID: ReadonlyMap<string, EventIndexEntry>,
): TurnAttribution | null {
  const files = new Map<string, FileAccumulator>();
  const commands = new Map<string, CommandAccumulator>();
  const subtasks: SubtaskAttribution[] = [];
  const seenSubtasks = new Set<string>();

  for (const step of turn.steps) {
    const cost =
      typeof step.cost === "number" && Number.isFinite(step.cost) ? step.cost : null;
    const callCount = step.toolCalls.length;
    const callEvents = toolEventIDs(step, eventByID);
    for (let index = 0; index < callCount; index += 1) {
      const tool = step.toolCalls[index];
      if (!tool) continue;
      const eventID = callEvents[index] ?? null;
      const paths = toolPaths(tool);
      const share = shareOf(cost, callCount, paths.length);
      for (const item of paths) {
        let accumulator = files.get(item.path);
        if (!accumulator) {
          accumulator = {
            path: item.path,
            read: 0,
            write: 0,
            cost: null,
            eventIDs: [],
          };
          files.set(item.path, accumulator);
        }
        if (item.op === "write") accumulator.write += 1;
        else accumulator.read += 1;
        if (share !== null) accumulator.cost = (accumulator.cost ?? 0) + share;
        if (eventID !== null) accumulator.eventIDs.push(eventID);
      }
      if (SHELL_TOOL_NAMES.has(tool.name)) {
        const name = firstCommandToken(tool.input);
        if (name !== null) {
          let accumulator = commands.get(name);
          if (!accumulator) {
            accumulator = { name, count: 0, eventIDs: [] };
            commands.set(name, accumulator);
          }
          accumulator.count += 1;
          if (eventID !== null) accumulator.eventIDs.push(eventID);
        }
      }
      for (const sessionID of tool.childSessionIDs) {
        if (seenSubtasks.has(sessionID)) continue;
        seenSubtasks.add(sessionID);
        if (subtasks.length >= MAX_ASSESSED_CHILDREN) continue;
        const agent = recordOf(tool.input).agent;
        subtasks.push({
          sessionID,
          agent: typeof agent === "string" && agent.length > 0 ? agent : null,
          basis: "measured",
        });
      }
    }
  }

  const attributedFiles = fileRows(files);
  const attributedCommands = commandRows(commands);
  if (
    attributedFiles.length === 0 &&
    attributedCommands.length === 0 &&
    subtasks.length === 0
  ) {
    return null;
  }
  return {
    turnID: turn.id,
    turnIndex: turn.index,
    taskID: turn.id,
    trigger: {
      kind: turn.trigger.kind,
      eventID: turn.trigger.eventID,
      label: turn.trigger.label,
    },
    files: attributedFiles,
    commands: attributedCommands,
    subtasks,
    eventIDs: capEvidenceIDs(turn.eventIDs, MAX_EVENT_LINKS),
  };
}

/**
 * Primary entry point. Pure, deterministic and local.
 *
 * Returns `null` when no turn recorded a file, a shell command or a delegated
 * child: the rider then stays absent instead of asserting an empty
 * attribution, mirroring the diagnostics precedent.
 */
export function evaluateAttribution(analysis: Analysis): Attribution | null {
  const eventByID = new Map(
    analysis.events.map((event) => [event.id, event] as const),
  );
  const turns: TurnAttribution[] = [];
  for (const turn of analysis.turns) {
    const attributed = attributeTurn(turn, eventByID);
    if (attributed !== null) turns.push(attributed);
  }
  if (turns.length === 0) return null;
  return { turns, basisNotes: [...BASIS_NOTES] };
}
