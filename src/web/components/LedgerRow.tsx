import clsx from "clsx";
import type { NormalizedEvent } from "../../core/types.ts";
import {
  CURSOR_LABEL,
  eventBadges,
  eventMetrics,
  eventPreview,
  eventSubLine,
  hasEventSubLine,
  kindBadge,
  type LedgerRow,
} from "../lib/ledger.ts";
import { formatTime, modelLabel } from "../lib/format.ts";
import { Badge } from "./Badge.tsx";

export interface LedgerRowProps {
  row: LedgerRow;
  /** The drawer's event. */
  selected: boolean;
  /** The `j`/`k` keyboard cursor. */
  cursor: boolean;
  /** Inside the open incident's failure sequence. */
  highlighted: boolean;
  onOpen(eventID: string): void;
}

const STATUS: Record<string, string> = {
  completed: "text-good",
  succeeded: "text-good",
  error: "text-critical",
  failed: "text-critical",
  interrupted: "text-critical",
  running: "text-accent",
};

/** Status text always renders next to the colour (`DESIGN.md:60-62`). */
export function statusClass(status: string | null | undefined): string {
  return (status && STATUS[status]) || "text-text-2";
}

function TurnHeader({ row }: { row: Extract<LedgerRow, { type: "turn" }> }) {
  if (!row.turn) {
    return (
      <div className="flex min-h-[46px] items-center gap-2.5 border-b border-grid bg-surface-2 px-3 text-[12px] text-text-2">
        <span className="font-semibold text-text">Unattached</span>
        <span className="min-w-0 flex-1 truncate">
          Events not attributable to a turn (preserved in recorded order)
        </span>
        <Badge label="uncertain" kind="uncertain" />
      </div>
    );
  }
  const turn = row.turn;
  return (
    <div className="flex min-h-[46px] items-center gap-2.5 border-b border-grid bg-surface-2 px-3 text-[12px] text-text-2">
      <span className="font-semibold text-text">Turn {turn.index}</span>
      <span className="min-w-0 flex-1 truncate">{turn.trigger.label}</span>
      <Badge label={turn.trigger.kind} kind="neutral" />
      <span className={clsx("text-[11px] font-semibold", statusClass(turn.status))}>
        {turn.status}
      </span>
      <span className="text-[11px] text-muted">{turn.steps.length} step(s)</span>
    </div>
  );
}

function StepHeader({ row }: { row: Extract<LedgerRow, { type: "step" }> }) {
  const step = row.step;
  return (
    <div className="flex min-h-[32px] items-center gap-2 border-b border-dashed border-grid bg-surface px-3 pl-[26px] text-[11.5px] text-text-2">
      <span className="font-semibold text-text">Step {step?.index ?? "?"}</span>
      <span className="min-w-0 flex-1 truncate">
        {step?.model ? modelLabel(step.model) : ""}
      </span>
      <span className={clsx("text-[11px] font-semibold", statusClass(step?.status))}>
        {step?.status ?? "?"}
      </span>
    </div>
  );
}

function EventRow({
  event,
  selected,
  cursor,
  highlighted,
  onOpen,
}: {
  event: NormalizedEvent;
  selected: boolean;
  cursor: boolean;
  highlighted: boolean;
  onOpen(eventID: string): void;
}) {
  const approximate = event.meta?.timestampApproximate === true;
  const sub = hasEventSubLine(event) ? eventSubLine(event) : "";
  const preview = eventPreview(event);
  const metrics = eventMetrics(event);
  const rule = selected && highlighted
    ? "border-l-4 border-l-accent"
    : selected
      ? "border-l-[3px] border-l-accent"
      : highlighted
        ? "border-l-2 border-l-accent"
        : "border-l-0";

  return (
    <button
      type="button"
      data-event-id={event.id}
      data-cursor={cursor ? "true" : undefined}
      aria-current={cursor ? "true" : undefined}
      onClick={() => onOpen(event.id)}
      className={clsx(
        // The rail is square and the state cues are the 3 px rule and the
        // `accent-weak` wash; hover is `surface-2` (DESIGN.md:48). The legacy
        // class names are kept so drill selectors and tests keep their contract.
        "ledger-row flex w-full items-stretch gap-2.5 rounded-none border-b border-r-0 border-t-0 border-grid py-2 pr-3 pl-[26px] text-left text-text",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
        rule,
        selected || highlighted ? "bg-accent-weak" : "",
        selected && "selected",
        highlighted && "diagnostic-highlight",
        !selected && !highlighted && "hover:bg-surface-2",
      )}
    >
      <span
        className="w-16 shrink-0 pt-0.5 text-[11px] text-muted tabular-nums"
        title={
          approximate ? "Timestamp is approximate; recorded order is exact" : undefined
        }
      >
        {cursor ? (
          <span aria-hidden="true" className="mr-0.5 text-text">
            ›
          </span>
        ) : null}
        {approximate ? "~" : ""}
        {formatTime(event.timestamp)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-semibold">
            {event.title}
          </span>
          <Badge label={kindBadge(event).label} kind={kindBadge(event).kind} />
          {eventBadges(event).map((badge) => (
            <Badge
              key={`${badge.label}:${badge.kind}`}
              label={badge.label}
              kind={badge.kind}
              title={badge.title}
            />
          ))}
        </span>
        {sub ? <span className="truncate text-[11.5px] text-text-2">{sub}</span> : null}
        {preview ? (
          // Up to four lines, then an ellipsis. The measured row height follows
          // the real line count, so nothing is clipped (see lib/ledger.ts).
          <span className="line-clamp-4 text-[12px] break-words text-text-2">
            {preview}
          </span>
        ) : null}
        {metrics.length ? (
          <span
            className="flex flex-nowrap gap-x-1.5 overflow-hidden text-[11px] text-muted"
            title={metrics.join(" · ")}
          >
            {metrics.map((metric) => (
              <span key={metric} className="whitespace-nowrap">
                {metric}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1 self-center text-[11px] text-muted">
        {cursor ? <span className="text-[10px]">{CURSOR_LABEL}</span> : null}
        <span aria-hidden="true">›</span>
      </span>
    </button>
  );
}

/** One ledger row: turn header, step header or the event button. */
export function LedgerRowView({
  row,
  selected,
  cursor,
  highlighted,
  onOpen,
}: LedgerRowProps) {
  if (row.type === "turn") return <TurnHeader row={row} />;
  if (row.type === "step") return <StepHeader row={row} />;
  return (
    <EventRow
      event={row.event}
      selected={selected}
      cursor={cursor}
      highlighted={highlighted}
      onOpen={onOpen}
    />
  );
}
