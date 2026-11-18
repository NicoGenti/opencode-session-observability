/**
 * Task and file attribution renderers for Advanced Statistics.
 *
 * DOM-free string builders in the same shape as `health.js` and `live.js`: they
 * consume the stored `Analysis.attribution` DTO and return escaped markup.
 * Nothing is re-derived here — the evaluator lives in core, the paths and the
 * cost shares arrive already labelled — and no request is made. The only
 * import is `./format.js`, so the module stays plain browser ESM with no build
 * step.
 *
 * Every row keeps the data basis in view: the file paths are `measured` by the
 * recorded tool calls, the per-file cost share is `derived` (metric mark plus
 * its note in the tooltip), and the standing commit row says the linkage is
 * unavailable. Drill targets are plain `data-event-id` buttons and
 * `data-session-id` buttons, which the existing `bindStatistics()` loops
 * already route through `jumpToEvent()` and `selectSession()`.
 */

import {
  escapeAttr,
  escapeHtml,
  formatCost,
  formatNumber,
  metricHtml,
} from "./format.js";

/** Mirrors of the core caps; a hostile payload cannot grow a row. */
export const MAX_FILES_PER_TURN = 12;
export const MAX_FILE_EVIDENCE = 6;
export const MAX_COMMANDS_PER_TURN = 8;
export const MAX_COMMAND_EVIDENCE = 6;
export const MAX_SUBTASKS_PER_TURN = 8;
/** Turn-head evidence links; the same cap as `MAX_EVENT_LINKS` in core. */
export const MAX_TURN_EVIDENCE = 10;

/**
 * The standing row: attribution never claims a commit link, because the
 * session database records no git data. Fixed copy, independent of the payload.
 */
export const COMMIT_LINKAGE_NOTE =
  "Commit linkage unavailable: the session database records no git data.";

const PROVENANCE_RAIL = "Paths measured · cost shares derived · commits unavailable";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function cappedIDs(ids, limit) {
  const out = [];
  const seen = new Set();
  for (const id of asArray(ids)) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function eventLinksHtml(ids, limit, label, prefix) {
  const capped = cappedIDs(ids, limit);
  if (capped.length === 0) return "";
  const links = capped
    .map(
      (eventID, position) =>
        `<button type="button" class="link-button attribution-link" data-event-id="${escapeAttr(
          eventID,
        )}" aria-label="${escapeAttr(
          `Open event ${position + 1} of ${label} in Trajectory`,
        )}">${escapeHtml(prefix)} · Event ${position + 1}</button>`,
    )
    .join("");
  return `<div class="attribution-links">${links}</div>`;
}

function opsText(ops) {
  const read = asCount(ops?.read);
  const write = asCount(ops?.write);
  const parts = [];
  if (read > 0) parts.push(`${formatNumber(read)} read`);
  if (write > 0) parts.push(`${formatNumber(write)} write`);
  return parts.join(" · ");
}

function moreText(label, dropped) {
  const count = asCount(dropped);
  return count > 0 ? `+${formatNumber(count)} more ${label}` : "";
}

function fileRowHtml(file, turnIndex, rowIndex) {
  const path = asText(file?.path);
  if (path.length === 0) return "";
  const ops = opsText(file?.ops);
  const rowLabel = `File ${rowIndex}`;
  return `<li class="attribution-file">
        <span class="mono attribution-file-path">${escapeHtml(path)}</span>
        <span class="attribution-ops">${escapeHtml(ops)}</span>
        <span class="attribution-share">${metricHtml(file?.costShare, formatCost)}</span>
        ${eventLinksHtml(
          file?.eventIDs,
          MAX_FILE_EVIDENCE,
          `file ${rowIndex} in turn ${turnIndex}`,
          rowLabel,
        )}
      </li>`;
}

function commandRowHtml(command, turnIndex, rowIndex) {
  const name = asText(command?.name);
  if (name.length === 0) return "";
  const count = asCount(command?.count);
  const rowLabel = `Command ${rowIndex}`;
  return `<li class="attribution-command">
        <code>${escapeHtml(name)}</code>
        <span class="attribution-ops">×${formatNumber(count)}</span>
        ${eventLinksHtml(
          command?.eventIDs,
          MAX_COMMAND_EVIDENCE,
          `command ${rowIndex} in turn ${turnIndex}`,
          rowLabel,
        )}
      </li>`;
}

function subtaskRowHtml(subtask) {
  const sessionID = asText(subtask?.sessionID);
  if (sessionID.length === 0) return "";
  const agent = asText(subtask?.agent);
  return `<li class="attribution-subtask">
        <button type="button" class="link-button attribution-session" data-session-id="${escapeAttr(
          sessionID,
        )}" aria-label="${escapeAttr(`Open child session ${sessionID}`)}">${escapeHtml(
          sessionID,
        )}</button>
        ${agent ? `<span class="attribution-ops">${escapeHtml(agent)}</span>` : ""}
      </li>`;
}

function groupHtml(label, rows, more) {
  if (rows.length === 0 && more.length === 0) return "";
  const list =
    rows.length > 0
      ? `<ul class="attribution-${label.toLowerCase()}">${rows.join("")}</ul>`
      : "";
  return `<div class="attribution-group">
        <span class="attribution-group-label">${escapeHtml(label)}</span>
        ${list}
        ${more ? `<span class="attribution-ops attribution-more">${escapeHtml(more)}</span>` : ""}
      </div>`;
}

function turnHtml(turn) {
  const rawIndex = typeof turn?.turnIndex === "number" ? turn.turnIndex : null;
  const indexLabel =
    rawIndex === null ? "Turn" : `Turn ${formatNumber(rawIndex)}`;
  const trigger = asText(turn?.trigger?.label);
  const files = asArray(turn?.files)
    .slice(0, MAX_FILES_PER_TURN)
    .map((file, position) => fileRowHtml(file, rawIndex ?? "?", position + 1))
    .filter(Boolean);
  const commands = asArray(turn?.commands)
    .slice(0, MAX_COMMANDS_PER_TURN)
    .map((command, position) =>
      commandRowHtml(command, rawIndex ?? "?", position + 1),
    )
    .filter(Boolean);
  const subtasks = asArray(turn?.subtasks)
    .slice(0, MAX_SUBTASKS_PER_TURN)
    .map(subtaskRowHtml)
    .filter(Boolean);
  return `<li class="attribution-turn">
      <div class="attribution-turn-head">
        <span class="attribution-turn-index">${escapeHtml(indexLabel)}</span>
        ${
          trigger
            ? `<span class="attribution-turn-trigger">${escapeHtml(trigger)}</span>`
            : ""
        }
        <span class="grow"></span>
        ${eventLinksHtml(
          turn?.eventIDs,
          MAX_TURN_EVIDENCE,
          `${indexLabel} evidence`,
          indexLabel,
        )}
      </div>
      ${groupHtml("Files", files, moreText("files not shown", turn?.filesTruncated))}
      ${groupHtml(
        "Commands",
        commands,
        moreText("commands not shown", turn?.commandsTruncated),
      )}
      ${groupHtml("Subtasks", subtasks, "")}
    </li>`;
}

/**
 * The section rendered in Advanced Statistics. An absent rider renders nothing,
 * so a session without tool signals leaves no empty frame behind.
 */
export function attributionSectionHtml(attribution) {
  const turns = asArray(attribution?.turns)
    .map(turnHtml)
    .filter((row) => row.length > 0);
  if (turns.length === 0) return "";
  // The commit row is a standing promise; the same sentence is not repeated
  // from the DTO's own notes.
  const notes = asArray(attribution?.basisNotes)
    .filter((note) => typeof note === "string" && note.length > 0)
    .filter((note) => !/^Commit linkage/i.test(note));
  const notesHtml =
    notes.length > 0
      ? `<ul class="attribution-notes">${notes
          .map((note) => `<li>${escapeHtml(note)}</li>`)
          .join("")}</ul>`
      : "";
  return `<section class="attribution-section" aria-label="Task and file attribution">
      <div class="attribution-head">
        <h2 class="stats-title">Task and file attribution</h2>
        <span class="muted small">${escapeHtml(PROVENANCE_RAIL)}</span>
      </div>
      <ul class="attribution-turns">${turns.join("")}</ul>
      <p class="attribution-commit">${escapeHtml(COMMIT_LINKAGE_NOTE)}</p>
      ${notesHtml}
    </section>`;
}
