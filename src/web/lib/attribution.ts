/**
 * The task and file attribution model, a pure port of `src/ui/attribution.js`.
 *
 * The section only ever renders what the recorded tool calls measured: paths
 * are measured, cost shares are derived (their note travels with the mark), and
 * commit linkage is unavailable by construction. Caps come from core so the
 * browser cannot show a row the evaluator could not have produced.
 */

import {
  MAX_COMMANDS_PER_TURN,
  MAX_COMMAND_EVIDENCE,
  MAX_FILES_PER_TURN,
  MAX_FILE_EVIDENCE,
  type Attribution,
  type CommandAttribution,
  type FileAttribution,
  type SubtaskAttribution,
  type TurnAttribution,
} from "../../core/attribution.ts";
import { MAX_EVENT_LINKS } from "../../core/health.ts";
import { formatCost, formatNumber } from "./format.ts";
import { metricText } from "./diagnostics.ts";

export {
  MAX_COMMANDS_PER_TURN,
  MAX_COMMAND_EVIDENCE,
  MAX_FILES_PER_TURN,
  MAX_FILE_EVIDENCE,
  MAX_EVENT_LINKS,
};

/** Turn-head evidence links; the same cap as the health rules. */
export const MAX_TURN_EVIDENCE = MAX_EVENT_LINKS;
export const MAX_SUBTASKS_PER_TURN = 8;

/** The standing row: attribution never claims a commit link (`attribution.js:40`). */
export const COMMIT_LINKAGE_NOTE =
  "Commit linkage unavailable: the session database records no git data.";

export const ATTRIBUTION_PROVENANCE_RAIL =
  "Paths measured · cost shares derived · commits unavailable";

export const ATTRIBUTION_TITLE = "Task and file attribution";

export interface EvidenceLinkModel {
  key: string;
  label: string;
  eventID: string;
  ariaLabel: string;
}

export interface AttributionFileModel {
  key: string;
  path: string;
  ops: string;
  share: ReturnType<typeof metricText>;
  links: EvidenceLinkModel[];
}

export interface AttributionCommandModel {
  key: string;
  name: string;
  count: string;
  links: EvidenceLinkModel[];
}

export interface AttributionSubtaskModel {
  key: string;
  sessionID: string;
  agent: string | null;
  ariaLabel: string;
}

export interface AttributionGroupModel<T> {
  label: string;
  rows: T[];
  more: string;
}

export interface AttributionTurnModel {
  key: string;
  indexLabel: string;
  trigger: string;
  links: EvidenceLinkModel[];
  files: AttributionGroupModel<AttributionFileModel>;
  commands: AttributionGroupModel<AttributionCommandModel>;
  subtasks: AttributionGroupModel<AttributionSubtaskModel>;
}

export interface AttributionSectionModel {
  title: string;
  rail: string;
  commitNote: string;
  turns: AttributionTurnModel[];
  notes: string[];
  empty: boolean;
}

function cappedIDs(ids: readonly string[] | undefined, limit: number): string[] {
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

function eventLinks(
  ids: readonly string[] | undefined,
  limit: number,
  label: string,
  prefix: string,
  keyPrefix: string,
): EvidenceLinkModel[] {
  return cappedIDs(ids, limit).map((eventID, position) => ({
    key: `${keyPrefix}:event:${position}`,
    label: `${prefix} · Event ${position + 1}`,
    eventID,
    ariaLabel: `Open event ${position + 1} of ${label} in Trajectory`,
  }));
}

function opsText(file: FileAttribution): string {
  const parts: string[] = [];
  if (file.ops.read > 0) parts.push(`${formatNumber(file.ops.read)} read`);
  if (file.ops.write > 0) parts.push(`${formatNumber(file.ops.write)} write`);
  return parts.join(" · ");
}

function moreText(label: string, dropped: number): string {
  return dropped > 0 ? `+${formatNumber(dropped)} more ${label}` : "";
}

function fileModel(
  file: FileAttribution,
  turnIndex: number | string,
  rowIndex: number,
): AttributionFileModel | null {
  if (typeof file?.path !== "string" || file.path.length === 0) return null;
  return {
    key: `file:${turnIndex}:${rowIndex}`,
    path: file.path,
    ops: opsText(file),
    share: metricText(file.costShare, formatCost),
    links: eventLinks(
      file.eventIDs,
      MAX_FILE_EVIDENCE,
      `file ${rowIndex} in turn ${turnIndex}`,
      `File ${rowIndex}`,
      `file:${turnIndex}:${rowIndex}`,
    ),
  };
}

function commandModel(
  command: CommandAttribution,
  turnIndex: number | string,
  rowIndex: number,
): AttributionCommandModel | null {
  if (typeof command?.name !== "string" || command.name.length === 0) return null;
  return {
    key: `command:${turnIndex}:${rowIndex}`,
    name: command.name,
    count: `×${formatNumber(command.count)}`,
    links: eventLinks(
      command.eventIDs,
      MAX_COMMAND_EVIDENCE,
      `command ${rowIndex} in turn ${turnIndex}`,
      `Command ${rowIndex}`,
      `command:${turnIndex}:${rowIndex}`,
    ),
  };
}

function subtaskModel(
  subtask: SubtaskAttribution,
  rowIndex: number,
): AttributionSubtaskModel | null {
  if (typeof subtask?.sessionID !== "string" || subtask.sessionID.length === 0) {
    return null;
  }
  return {
    key: `subtask:${subtask.sessionID}:${rowIndex}`,
    sessionID: subtask.sessionID,
    agent: subtask.agent,
    ariaLabel: `Open child session ${subtask.sessionID}`,
  };
}

function group<T>(label: string, rows: T[], more: string): AttributionGroupModel<T> {
  return { label, rows, more };
}

function turnModel(turn: TurnAttribution): AttributionTurnModel {
  const rawIndex = typeof turn?.turnIndex === "number" ? turn.turnIndex : null;
  const indexLabel = rawIndex === null ? "Turn" : `Turn ${formatNumber(rawIndex)}`;
  const files = (Array.isArray(turn?.files) ? turn.files : [])
    .slice(0, MAX_FILES_PER_TURN)
    .map((file, position) => fileModel(file, rawIndex ?? "?", position + 1))
    .filter((row): row is AttributionFileModel => row !== null);
  const commands = (Array.isArray(turn?.commands) ? turn.commands : [])
    .slice(0, MAX_COMMANDS_PER_TURN)
    .map((command, position) => commandModel(command, rawIndex ?? "?", position + 1))
    .filter((row): row is AttributionCommandModel => row !== null);
  const subtasks = (Array.isArray(turn?.subtasks) ? turn.subtasks : [])
    .slice(0, MAX_SUBTASKS_PER_TURN)
    .map((subtask, position) => subtaskModel(subtask, position + 1))
    .filter((row): row is AttributionSubtaskModel => row !== null);
  return {
    key: turn?.turnID ?? `turn:${indexLabel}`,
    indexLabel,
    trigger: typeof turn?.trigger?.label === "string" ? turn.trigger.label : "",
    links: eventLinks(
      turn?.eventIDs,
      MAX_TURN_EVIDENCE,
      `${indexLabel} evidence`,
      indexLabel,
      `turn:${turn?.turnID ?? indexLabel}`,
    ),
    files: group("Files", files, moreText("files not shown", turn?.filesTruncated ?? 0)),
    commands: group(
      "Commands",
      commands,
      moreText("commands not shown", turn?.commandsTruncated ?? 0),
    ),
    subtasks: group("Subtasks", subtasks, ""),
  };
}

/** An absent rider renders nothing, so an empty frame never appears. */
export function buildAttribution(
  attribution: Attribution | null | undefined,
): AttributionSectionModel {
  const turns = (Array.isArray(attribution?.turns) ? attribution.turns : []).map(turnModel);
  const notes = (Array.isArray(attribution?.basisNotes) ? attribution.basisNotes : [])
    .filter((note): note is string => typeof note === "string" && note.length > 0)
    .filter((note) => !/^Commit linkage/i.test(note));
  return {
    title: ATTRIBUTION_TITLE,
    rail: ATTRIBUTION_PROVENANCE_RAIL,
    commitNote: COMMIT_LINKAGE_NOTE,
    turns,
    notes,
    empty: turns.length === 0,
  };
}
