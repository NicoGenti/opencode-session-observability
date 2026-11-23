/**
 * The detail drawer's data model, ported from `drawerHtml` (`app.js:2650-2799`).
 *
 * The legacy function returned a markup string; this module returns the same
 * fields, in the same reading order, as plain data. The component owns the
 * Radix dialog, the focus trap and the token-only classes.
 *
 * Two contracts are enforced here rather than in the renderer:
 *
 * - Field gating: the six identity fields always render; every other field is
 *   dropped when it has no recorded value, and the dropped labels collapse into
 *   ONE "Not recorded (N)" disclosure.
 * - Section gating: only populated sections are listed, in the documented order
 *   event → text → tool → compaction → payload.
 */

import type { CompactionTransaction, NormalizedEvent } from "../../core/types.ts";
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatNumber,
  modelLabel,
} from "./format.ts";
import { metricText } from "./diagnostics.ts";

export type DrawerSectionId = "event" | "text" | "tool" | "compaction" | "payload";

export interface DrawerSectionModel {
  id: DrawerSectionId;
  title: string;
}

const SECTION_TITLES: Record<DrawerSectionId, string> = {
  event: "Event",
  text: "Text",
  tool: "Tool call",
  compaction: "Compaction transaction",
  payload: "Payload",
};

export const DRAWER_IDENTITY_LABELS = Object.freeze([
  "Event ID",
  "Message ID",
  "Session",
  "Seq / order",
  "Turn",
  "Timestamp",
] as const);

export const NOT_RECORDED_LABEL = "Not recorded";

export const COMPACTION_NOTE =
  "Compaction is not a normal step; its usage is excluded from turn/step totals.";

export const PAYLOAD_SUMMARY = "Raw event payload (redacted unless reveal is on)";

export interface DrawerField {
  label: string;
  value: string;
}

export interface DrawerMeta {
  present: DrawerField[];
  missing: string[];
  /** `Not recorded (N)` when any optional field is absent, else null. */
  missingSummary: string | null;
}

interface MetaEntry extends DrawerField {
  always: boolean;
}

function metaEntries(event: NormalizedEvent): MetaEntry[] {
  return [
    { label: "Event ID", value: event.id, always: true },
    { label: "Message ID", value: event.messageID, always: true },
    { label: "Session", value: event.sessionID, always: true },
    { label: "Seq / order", value: `${event.seq} / ${event.order}`, always: true },
    { label: "Turn", value: event.turnID || "unattached", always: true },
    { label: "Timestamp", value: formatDateTime(event.timestamp), always: true },
    { label: "Step", value: event.stepID ?? "", always: false },
    { label: "Agent", value: event.agent ?? "", always: false },
    {
      label: "Model",
      value: event.model ? modelLabel(event.model) : "",
      always: false,
    },
    { label: "Provider", value: event.provider ?? "", always: false },
    { label: "Status", value: event.status ?? "", always: false },
    {
      label: "End",
      value: event.endTimestamp ? formatDateTime(event.endTimestamp) : "",
      always: false,
    },
    {
      label: "Duration",
      value: event.endTimestamp ? formatDuration(event.endTimestamp - event.timestamp) : "",
      always: false,
    },
    { label: "Tokens", value: event.tokens ? JSON.stringify(event.tokens) : "", always: false },
    {
      label: "Cost",
      value: event.cost === null || event.cost === undefined ? "" : formatCost(event.cost),
      always: false,
    },
    {
      label: "Uncertainty",
      value: event.uncertainty.length ? event.uncertainty.join(", ") : "",
      always: false,
    },
  ];
}

export function drawerMeta(event: NormalizedEvent): DrawerMeta {
  const entries = metaEntries(event);
  const present = entries.filter(
    (entry) =>
      entry.always ||
      (entry.value !== null &&
        entry.value !== undefined &&
        String(entry.value).trim() !== "" &&
        entry.value !== "—"),
  );
  const presentLabels = new Set(present.map((entry) => entry.label));
  const missing = entries
    .filter((entry) => !presentLabels.has(entry.label))
    .map((entry) => entry.label);
  return {
    present: present.map(({ label, value }) => ({ label, value })),
    missing,
    missingSummary: missing.length
      ? `${NOT_RECORDED_LABEL} (${missing.length})`
      : null,
  };
}

export interface ToolBoxModel {
  name: string;
  callID: string;
  status: string;
  duration: string;
  input: string;
  output: string;
  error: string | null;
  outputTruncated: boolean;
  childSessionIDs: string[];
  metadata: string | null;
  diff: string | null;
}

/** `renderToolDiff` (`app.js:2633-2648`): every recorded file patch, joined. */
function toolDiff(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const patches = files
    .map((file) =>
      file && typeof file === "object" && typeof (file as { patch?: unknown }).patch === "string"
        ? (file as { patch: string }).patch
        : null,
    )
    .filter((patch): patch is string => typeof patch === "string");
  return patches.length ? patches.join("\n") : null;
}

export function toolBox(event: NormalizedEvent): ToolBoxModel | null {
  const tool = event.tool;
  if (!tool) return null;
  return {
    name: tool.name,
    callID: tool.callID,
    status: tool.status,
    duration: formatDuration(tool.duration?.value ?? null),
    input: JSON.stringify(tool.input, null, 2),
    output: tool.output ?? "—",
    error: tool.error ? JSON.stringify(tool.error, null, 2) : null,
    outputTruncated: tool.outputTruncated === true,
    childSessionIDs: [...tool.childSessionIDs],
    metadata: tool.metadata ? JSON.stringify(tool.metadata, null, 2) : null,
    diff: toolDiff(tool.metadata),
  };
}

export interface CompactionModel {
  eventID: string;
  facts: DrawerField[];
  note: string;
}

/** `compactionSection` (`app.js:2742-2754`). */
export function compactionFacts(
  compaction: CompactionTransaction,
): CompactionModel {
  return {
    eventID: compaction.eventID,
    facts: [
      { label: "Status", value: compaction.status },
      { label: "Reason", value: compaction.reason || "—" },
      {
        label: "Context before",
        value: metricText(compaction.contextBefore, formatNumber).text,
      },
      {
        label: "Context after",
        value: metricText(compaction.contextAfter, formatNumber).text,
      },
      {
        label: "Removed",
        value: metricText(compaction.removedTokens, formatNumber).text,
      },
      { label: "Summary size", value: `${formatNumber(compaction.summaryChars)} chars` },
      { label: "Output tokens", value: formatNumber(compaction.tokens?.output) },
      { label: "Cost", value: formatCost(compaction.cost) },
      { label: "Duration", value: metricText(compaction.duration, formatDuration).text },
    ],
    note: COMPACTION_NOTE,
  };
}

/** The exact payload string the drawer prints (`app.js:2653-2657`). */
export function payloadText(event: NormalizedEvent): string {
  if (event.payload === null || event.payload === undefined) return "";
  if (typeof event.payload === "string") return event.payload;
  return JSON.stringify(event.payload, null, 2);
}

export interface DrawerHeaderModel {
  title: string;
  kind: string;
  timestamp: string;
  status: string | null;
}

export function drawerHeader(event: NormalizedEvent): DrawerHeaderModel {
  return {
    title: event.title,
    kind: event.kind,
    timestamp: formatDateTime(event.timestamp),
    status: event.status,
  };
}

/**
 * The populated sections in reading order. Event and payload are structural and
 * always present; text, tool and compaction appear only when recorded.
 */
export function drawerSections(
  event: NormalizedEvent,
  compaction: CompactionTransaction | null,
): DrawerSectionModel[] {
  const sections: DrawerSectionModel[] = [{ id: "event", title: SECTION_TITLES.event }];
  if (event.text) sections.push({ id: "text", title: SECTION_TITLES.text });
  if (event.tool) sections.push({ id: "tool", title: SECTION_TITLES.tool });
  if (compaction) sections.push({ id: "compaction", title: SECTION_TITLES.compaction });
  sections.push({ id: "payload", title: SECTION_TITLES.payload });
  return sections;
}

/** The compaction transaction anchored on `eventID` (`app.js:2629-2631`). */
export function compactionForEvent(
  compactions: readonly CompactionTransaction[],
  eventID: string | null,
): CompactionTransaction | null {
  if (!eventID) return null;
  return compactions.find((item) => item.eventID === eventID) ?? null;
}
