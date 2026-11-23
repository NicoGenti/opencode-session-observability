import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef } from "react";
import type { CompactionTransaction, NormalizedEvent } from "../../core/types.ts";
import type { ApiFn } from "../lib/api.ts";
import {
  compactionFacts,
  compactionForEvent,
  drawerHeader,
  drawerMeta,
  drawerSections,
  payloadText,
  toolBox,
} from "../lib/drawer.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { useEventDetail } from "../hooks/useEvents.ts";
import { Badge } from "./Badge.tsx";

export interface EventDrawerProps {
  api: ApiFn;
  sessionID: string | null;
  eventID: string | null;
  compactions: readonly CompactionTransaction[];
  onClose(): void;
  /** Focus restoration target, run from Radix's `onCloseAutoFocus`. */
  onRestoreFocus?(): void;
  /** Surfaces the legacy global error banner when a detail cannot be loaded. */
  onError(message: string): void;
  /** "Show in Trajectory" on a compaction. */
  onOpenEvent(eventID: string): void;
  onOpenSession(sessionID: string): void;
  /** Copies one block of text and reports the confirmation ("Copied"). */
  onCopy(text: string, success: string): void;
  /** Copies the event's tab-separated metrics line ("Metrics copied"). */
  onCopyMetrics(event: NormalizedEvent): void;
  /** Copies the turn chain, or reports the missing attribution. */
  onCopyTurnChain(event: NormalizedEvent): void;
}

const MARKDOWN_CLASS = [
  "text-[12.5px] leading-[1.55]",
  "[&_p]:my-1 [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-[13px] [&_h2]:font-semibold",
  "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-[12.5px] [&_h3]:font-semibold",
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5 [&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-2 [&_blockquote]:text-text-2",
  "[&_a]:text-accent [&_a]:underline [&_code]:rounded-sm [&_code]:bg-surface-2 [&_code]:px-1",
  "[&_pre]:my-1 [&_pre]:overflow-auto [&_pre]:rounded-sm [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-2 [&_pre]:p-2",
  "[&_table]:my-1 [&_table]:w-full [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_th]:text-left",
  "[&_td]:border [&_td]:border-border [&_td]:px-1.5",
].join(" ");

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 break-words">{value}</dd>
    </>
  );
}

/**
 * The 640 px detail drawer (`drawerHtml`, `app.js:2650-2799`).
 *
 * - Radix Dialog owns the focus trap, `Esc`, the overlay click and the
 *   opener restoration; the close button is the first focus target.
 * - Sections appear in legacy reading order and only when populated:
 *   Event → Text → Tool call → Compaction transaction → Payload.
 * - Unrecorded metadata collapses into one `Not recorded (N)` disclosure.
 * - The detail request is `GET /api/sessions/:id/events/:eventID` behind the
 *   same sequence guard as `useSessions`; a late response cannot fill a newer
 *   drawer.
 * - The Text section renders the shared Markdown subset. Its HTML comes from
 *   `renderMarkdown`, which escapes the source before any rule runs. Every
 *   `dangerouslySetInnerHTML` in `src/web` is fed by that function — this
 *   drawer's text section and `StatsTable`'s two step-detail blocks — never raw
 *   event text.
 */
export function EventDrawer({
  api,
  sessionID,
  eventID,
  compactions,
  onClose,
  onRestoreFocus,
  onError,
  onOpenEvent,
  onOpenSession,
  onCopy,
  onCopyMetrics,
  onCopyTurnChain,
}: EventDrawerProps) {
  const detail = useEventDetail({ api, sessionID, eventID });
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (detail.status !== "error" || !detail.error) return;
    const key = `${sessionID}:${eventID}:${detail.error}`;
    if (reported.current === key) return;
    reported.current = key;
    onError(detail.error);
    onClose();
  }, [detail.status, detail.error, eventID, sessionID, onError, onClose]);

  useEffect(() => {
    if (!eventID) reported.current = null;
  }, [eventID]);

  const event = detail.event;
  const compaction = compactionForEvent(compactions, eventID);
  const meta = useMemo(() => (event ? drawerMeta(event) : null), [event]);
  const sections = useMemo(
    () => (event ? drawerSections(event, compaction) : []),
    [event, compaction],
  );
  const markdown = useMemo(
    () => renderMarkdown(event?.text ?? "", { maxChars: 24_000 }),
    [event?.text],
  );
  const box = useMemo(() => (event ? toolBox(event) : null), [event]);
  const compactionModel = useMemo(
    () => (compaction ? compactionFacts(compaction) : null),
    [compaction],
  );
  const header = event ? drawerHeader(event) : null;

  return (
    <Dialog.Root
      open={Boolean(eventID)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-page/70 frosted-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // A programmatically opened dialog has no Dialog.Trigger, so Radix
            // would drop focus to <body>; the view restores the opening row.
            event.preventDefault();
            onRestoreFocus?.();
          }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(640px,94vw)] flex-col border-l border-border-strong floating-frost text-text shadow-float max-[700px]:w-full"
        >
          <Dialog.Title className="sr-only">
            {header ? header.title : "Event detail"}
          </Dialog.Title>

          {/* No own surface: the header sits on the frosted panel so the sheet
              reads as one pane. */}
          <div className="flex flex-none items-start gap-2 border-b border-border px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <div className="break-words text-[14px] font-semibold">
                {header ? header.title : "Loading event"}
              </div>
              {header ? (
                <div className="mt-0.5 text-[11.5px] text-muted">
                  {header.kind} · {header.timestamp}
                  {header.status ? (
                    <>
                      {" · "}
                      <span className="text-text">{header.status}</span>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close detail"
                className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[12px] text-text-2"
              >
                Close
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-3.5 pb-6 pt-3">
            {!event ? (
              <p className="m-0 text-[12px] text-text-2">Loading event…</p>
            ) : (
              <>
                {/*
                 * The drawer's copy actions (`app.js:2772-2784`): JSON, text,
                 * metrics and the turn chain. The first two copy the same text
                 * the matching block renders, so the clipboard and the screen can
                 * never disagree.
                 */}
                <div className="mb-2.5 flex flex-wrap gap-1">
                  <button
                    type="button"
                    data-copy-el="detail-payload"
                    onClick={() => onCopy(payloadText(event) || "—", "Copied")}
                    className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2"
                  >
                    Copy JSON
                  </button>
                  <button
                    type="button"
                    data-copy-el="detail-text"
                    onClick={() => onCopy(event.text ?? "", "Copied")}
                    className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2"
                  >
                    Copy text
                  </button>
                  <button
                    type="button"
                    data-copy-metrics
                    onClick={() => onCopyMetrics(event)}
                    className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2"
                  >
                    Copy metrics
                  </button>
                  <button
                    type="button"
                    data-copy-turn
                    onClick={() => onCopyTurnChain(event)}
                    className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2"
                  >
                    Copy turn chain
                  </button>
                </div>
                {sections.map((section) => {
                  if (section.id === "event" && meta) {
                    return (
                      <div
                        key={section.id}
                        className="mt-2.5 border-t border-border pt-2.5 first:mt-0 first:border-t-0 first:pt-0"
                      >
                        <h3 className="m-0 mb-1.5 text-[12px] font-semibold text-text-2">
                          {section.title}
                        </h3>
                        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[12px]">
                          {meta.present.map((field) => (
                            <Row
                              key={field.label}
                              label={field.label}
                              value={field.value}
                            />
                          ))}
                        </dl>
                        {meta.missingSummary ? (
                          <details className="mt-2 text-[11.5px] text-text-2">
                            <summary className="cursor-pointer text-muted">
                              {meta.missingSummary}
                            </summary>
                            <ul className="mt-1.5 list-disc pl-4">
                              {meta.missing.map((label) => (
                                <li key={label}>{label}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </div>
                    );
                  }
                  if (section.id === "text") {
                    return (
                      <div
                        key={section.id}
                        className="mt-2.5 border-t border-border pt-2.5"
                      >
                        <h3 className="m-0 mb-1.5 text-[12px] font-semibold text-text-2">
                          {section.title}
                          {markdown.truncated ? " (truncated)" : ""}
                        </h3>
                        <div
                          className={MARKDOWN_CLASS}
                          // `renderMarkdown` escapes the whole source first and
                          // never re-enables raw HTML; this sink only receives
                          // that escaped output.
                          dangerouslySetInnerHTML={{ __html: markdown.html }}
                        />
                      </div>
                    );
                  }
                  if (section.id === "tool" && box) {
                    return (
                      <div
                        key={section.id}
                        className="mt-2.5 border-t border-border pt-2.5"
                      >
                        <h3 className="m-0 mb-1.5 text-[12px] font-semibold text-text-2">
                          {section.title}
                        </h3>
                        <div className="mt-1.5 rounded-sm border border-border bg-surface-2 p-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge
                              label={box.status}
                              kind={box.status === "error" ? "error" : "tool"}
                            />
                            <strong className="text-[12px]">{box.name}</strong>
                            <span className="text-[11px] text-muted">{box.callID}</span>
                            <span className="text-[11px] text-muted">{box.duration}</span>
                          </div>
                          <h4 className="m-0 mt-2 text-[12px]">Input</h4>
                          <pre className="mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface p-2.5 text-[11.5px]">
                            {box.input}
                          </pre>
                          <h4 className="m-0 mt-2 text-[12px]">Output</h4>
                          <pre className="mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface p-2.5 text-[11.5px]">
                            {box.output}
                          </pre>
                          {box.error ? (
                            <>
                              <h4 className="m-0 mt-2 text-[12px]">Error</h4>
                              <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface p-2.5 text-[11.5px]">
                                {box.error}
                              </pre>
                            </>
                          ) : null}
                          {box.outputTruncated ? (
                            <p className="m-0 mt-1 text-[11.5px] text-muted">
                              The recorded tool output was truncated by OpenCode.
                            </p>
                          ) : null}
                          {box.childSessionIDs.length ? (
                            <>
                              <h4 className="m-0 mt-2 text-[12px]">Subagent sessions</h4>
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {box.childSessionIDs.map((id) => (
                                  <button
                                    key={id}
                                    type="button"
                                    onClick={() => onOpenSession(id)}
                                    className="rounded-sm px-1 text-[12px] text-accent hover:underline"
                                  >
                                    {id}
                                  </button>
                                ))}
                              </div>
                            </>
                          ) : null}
                          {box.metadata ? (
                            <details className="mt-1.5 text-[11.5px] text-text-2">
                              <summary className="cursor-pointer text-muted">
                                Metadata
                              </summary>
                              <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface p-2.5 text-[11.5px]">
                                {box.metadata}
                              </pre>
                            </details>
                          ) : null}
                          {box.diff ? (
                            <>
                              <h4 className="m-0 mt-2 text-[12px]">Diff</h4>
                              <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface p-2.5 text-[11.5px]">
                                {box.diff}
                              </pre>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  }
                  if (section.id === "compaction" && compactionModel) {
                    return (
                      <div
                        key={section.id}
                        className="mt-2.5 border-t border-border pt-2.5"
                      >
                        <h3 className="m-0 mb-1.5 text-[12px] font-semibold text-text-2">
                          {section.title}
                        </h3>
                        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[12px]">
                          {compactionModel.facts.map((fact) => (
                            <Row key={fact.label} label={fact.label} value={fact.value} />
                          ))}
                        </dl>
                        <p className="m-0 mt-1.5 text-[11.5px] text-muted">
                          {compactionModel.note}
                        </p>
                        <button
                          type="button"
                          onClick={() => onOpenEvent(compactionModel.eventID)}
                          className="mt-1.5 rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2"
                        >
                          Show in Trajectory
                        </button>
                      </div>
                    );
                  }
                  if (section.id === "payload") {
                    const payload = payloadText(event);
                    return (
                      <div
                        key={section.id}
                        className="mt-2.5 border-t border-border pt-2.5"
                      >
                        <h3 className="m-0 mb-1.5 text-[12px] font-semibold text-text-2">
                          {section.title}
                        </h3>
                        <details open className="text-[11.5px] text-text-2">
                          <summary className="cursor-pointer text-muted">
                            Raw event payload (redacted unless reveal is on)
                          </summary>
                          <pre className="mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-2 p-2.5 text-[11.5px]">
                            {payload || "—"}
                          </pre>
                        </details>
                      </div>
                    );
                  }
                  return null;
                })}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
