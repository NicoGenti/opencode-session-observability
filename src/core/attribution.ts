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
  /** Distinct paths dropped by `MAX_FILES_PER_TURN`; never silently lost. */
  filesTruncated: number;
  /** Distinct commands dropped by `MAX_COMMANDS_PER_TURN`; never silently lost. */
  commandsTruncated: number;
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

/** Bare punctuation is never an executable name. */
const BARE_PUNCTUATION: ReadonlySet<string> = new Set(["--", ".", "/"]);

/** A leading `NAME=value` environment assignment is not the executable. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Path identity follows the recorded filesystem's case semantics. */
const CASE_INSENSITIVE_PATHS = process.platform === "win32";

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
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (value.endsWith(".")) return false;
  if (/[\\/]/.test(value)) return true;
  // An interior dot is enough for a bare filename (`a.ts`); a leading or
  // trailing dot alone is not path-shaped.
  const dot = value.indexOf(".");
  return dot > 0 && dot < value.length - 1;
}

/**
 * Accumulator identity for a path: separators unified to `/`, leading `./`
 * dropped, and case-folded where the recorded filesystem is case-insensitive.
 * The first spelling seen is what the DTO displays.
 */
function pathKey(path: string): string {
  let key = path.replace(/\\/g, "/");
  while (key.startsWith("./")) key = key.slice(2);
  return CASE_INSENSITIVE_PATHS ? key.toLowerCase() : key;
}

interface ToolPath {
  path: string;
  op: "read" | "write";
}

/**
 * Paths a single tool call touched. Every path key is shape-gated, not just
 * `description`: an MCP or plugin tool may emit any string there, and prose or
 * a credential-shaped token must not become a file row. A write tool's
 * `metadata.files[].file` list is a write; `metadata.files[].patch` is
 * deliberately never read.
 */
function toolPaths(tool: ToolCallDetail): ToolPath[] {
  const out: ToolPath[] = [];
  const seen = new Set<string>();
  const input = recordOf(tool.input);
  const writes = WRITE_TOOL_NAMES.has(tool.name);
  const reads = READ_TOOL_NAMES.has(tool.name);
  // A known write family writes; every other tool's path input is recorded as a
  // read, its shape still gated below.
  const op: "read" | "write" = writes ? "write" : "read";
  const push = (value: unknown, kind: "read" | "write"): void => {
    if (typeof value !== "string" || !pathShaped(value)) return;
    const path = cleanPath(value);
    if (path === null) return;
    const key = pathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, op: kind });
  };
  for (const key of PATH_KEYS) push(input[key], op);
  // `description` is prose by default. It is only consulted for a known file
  // tool family, and even then it must pass the same shape gate.
  if (reads || writes) {
    for (const key of DESCRIPTION_KEYS) push(input[key], op);
  }
  const metadata = recordOf(tool.metadata);
  if (writes) {
    const files = Array.isArray(metadata.files) ? metadata.files : [];
    for (const entry of files) {
      const record = recordOf(entry);
      push(record.file ?? record.path ?? record.filePath, "write");
    }
  }
  return out;
}

/**
 * Splits a recorded command line into tokens without breaking quoted segments.
 * A quoted value stays one token (its surrounding quotes removed), so
 * `PASSWORD="correct horse" npm test` tokenizes as the assignment, `npm`,
 * `test` — never as `horse` followed by `npm`.
 */
function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * First executable token of a recorded shell command. Only LEADING `KEY=value`
 * assignments are skipped so a credential assignment cannot become the name; a
 * first token that is not shell-token shaped yields no row at all.
 */
function firstCommandToken(input: unknown): string | null {
  const record = recordOf(input);
  const command = record.command ?? record.script ?? record.cmd;
  if (typeof command !== "string") return null;
  const tokens = commandTokens(command);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] ?? "")) {
    index += 1;
  }
  const token = tokens[index];
  if (token === undefined || token.length === 0) return null;
  if (token.length > MAX_COMMAND_TOKEN_LENGTH) return null;
  if (BARE_PUNCTUATION.has(token)) return null;
  return COMMAND_TOKEN.test(token) ? token : null;
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
  const ids = Array.isArray(step.eventIDs) ? step.eventIDs : [];
  for (const eventID of ids) {
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

/** Rounds a share to a 1e-12 grid so binary float noise never reaches the DTO. */
function roundShare(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

interface Rows<T> {
  rows: T[];
  /** Distinct entries dropped by the cap. */
  truncated: number;
}

function fileRows(files: ReadonlyMap<string, FileAccumulator>): Rows<FileAttribution> {
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
              roundShare(item.cost),
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
  const kept = rows.slice(0, MAX_FILES_PER_TURN);
  return { rows: kept, truncated: rows.length - kept.length };
}

function commandRows(
  commands: ReadonlyMap<string, CommandAccumulator>,
): Rows<CommandAttribution> {
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
  const kept = rows.slice(0, MAX_COMMANDS_PER_TURN);
  return { rows: kept, truncated: rows.length - kept.length };
}

function attributeTurn(
  turn: Turn,
  eventByID: ReadonlyMap<string, EventIndexEntry>,
): TurnAttribution | null {
  const files = new Map<string, FileAccumulator>();
  const commands = new Map<string, CommandAccumulator>();
  const subtasks: SubtaskAttribution[] = [];
  const seenSubtasks = new Set<string>();
  const steps = Array.isArray(turn.steps) ? turn.steps : [];

  for (const step of steps) {
    if (!step) continue;
    const cost =
      typeof step.cost === "number" && Number.isFinite(step.cost) ? step.cost : null;
    const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const callCount = toolCalls.length;
    const callEvents = toolEventIDs(step, eventByID);
    for (let index = 0; index < callCount; index += 1) {
      const tool = toolCalls[index];
      if (!tool) continue;
      const eventID = callEvents[index] ?? null;
      const paths = toolPaths(tool);
      const share = shareOf(cost, callCount, paths.length);
      for (const item of paths) {
        const key = pathKey(item.path);
        let accumulator = files.get(key);
        if (!accumulator) {
          accumulator = {
            path: item.path,
            read: 0,
            write: 0,
            cost: null,
            eventIDs: [],
          };
          files.set(key, accumulator);
        }
        if (item.op === "write") accumulator.write += 1;
        else accumulator.read += 1;
        if (share !== null) {
          accumulator.cost = roundShare((accumulator.cost ?? 0) + share);
        }
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
      const childIDs = Array.isArray(tool.childSessionIDs)
        ? tool.childSessionIDs
        : [];
      for (const sessionID of childIDs) {
        if (typeof sessionID !== "string" || sessionID.length === 0) continue;
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
    attributedFiles.rows.length === 0 &&
    attributedCommands.rows.length === 0 &&
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
    files: attributedFiles.rows,
    commands: attributedCommands.rows,
    subtasks,
    eventIDs: capEvidenceIDs(
      Array.isArray(turn.eventIDs) ? turn.eventIDs : [],
      MAX_EVENT_LINKS,
    ),
    filesTruncated: attributedFiles.truncated,
    commandsTruncated: attributedCommands.truncated,
  };
}

/**
 * Primary entry point. Pure, deterministic and local.
 *
 * Returns `null` when no turn recorded a file, a shell command or a delegated
 * child: the rider then stays absent instead of asserting an empty
 * attribution, mirroring the diagnostics precedent. A malformed analysis also
 * yields the absent rider instead of throwing, matching `delegation.ts`.
 */
export function evaluateAttribution(analysis: Analysis): Attribution | null {
  if (!analysis || !Array.isArray(analysis.events) || !Array.isArray(analysis.turns)) {
    return null;
  }
  const eventByID = new Map(
    analysis.events.map((event) => [event.id, event] as const),
  );
  const turns: TurnAttribution[] = [];
  for (const turn of analysis.turns) {
    if (!turn) continue;
    const attributed = attributeTurn(turn, eventByID);
    if (attributed !== null) turns.push(attributed);
  }
  if (turns.length === 0) return null;
  return { turns, basisNotes: [...BASIS_NOTES] };
}
