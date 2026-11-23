import { Fragment } from "react";
import clsx from "clsx";
import type { StatsColumn, StatsRow, StatsCell, StatusTone, TotalsRowModel } from "../lib/statistics.ts";
import { buildStepDetail } from "../lib/statistics.ts";
import { eventRowModel } from "../lib/statistics.ts";
import { Badge } from "./Badge.tsx";

const TONE_CLASS: Record<StatusTone, string> = {
  completed: "text-good",
  error: "text-critical",
  interrupted: "text-critical",
  running: "text-accent",
  unknown: "text-text-2",
};

const BASE_CELL = "border-b border-border px-2 py-1 align-top";

const FROZEN_CELL: Record<string, string> = {
  index: "sticky left-0 z-10 w-14 min-w-14 max-[700px]:static max-[700px]:z-auto",
  trigger:
    "sticky left-14 z-10 w-[9.5rem] min-w-[9.5rem] max-w-[9.5rem] border-r border-border-strong max-[700px]:static max-[700px]:z-auto max-[700px]:border-r-0",
  status:
    "sticky right-0 z-10 w-[7.5rem] min-w-[7.5rem] border-l border-border-strong max-[700px]:static max-[700px]:z-auto max-[700px]:border-l-0",
};

function frozenClass(column: StatsColumn): string {
  return column.frozen ? FROZEN_CELL[column.id] ?? "" : "";
}

function cellClass(cell: StatsCell, column: StatsColumn, background: string): string {
  return clsx(
    BASE_CELL,
    cell.numeric ? "text-right tabular-nums" : "",
    cell.mono ? "font-mono text-[11px]" : "",
    cell.muted ? "text-muted" : "",
    frozenClass(column),
    column.frozen ? background : "",
  );
}

function CellContent({
  cell,
  onToggleTurn,
  onToggleStep,
  onDrill,
  turnID,
}: {
  cell: StatsCell;
  onToggleTurn(turnID: string): void;
  onToggleStep(turnID: string, stepID: string): void;
  onDrill(eventID: string): void;
  turnID: string;
}) {
  return (
    <>
      {cell.toggle ? (
        <button
          type="button"
          aria-label={cell.toggle.label}
          aria-expanded={cell.toggle.expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggleTurn(turnID);
          }}
          className="mr-1 rounded-sm px-0.5 text-[11px] text-text-2 hover:text-text"
        >
          {cell.toggle.expanded ? "▾" : "▸"}
        </button>
      ) : null}
      {cell.status ? null : cell.text}
      {cell.mark ? (
        <sup className="ml-px align-super text-[10px] text-muted">{cell.mark}</sup>
      ) : null}
      {cell.sub ? <div className="text-[11px] text-muted">{cell.sub}</div> : null}
      {cell.status ? (
        <>
          {" "}
          <span className={clsx("text-[11px] font-semibold", TONE_CLASS[cell.status.tone])}>
            {cell.status.label}
          </span>
          {cell.status.uncertainty ? (
            <>
              {" "}
              <Badge
                label={cell.status.uncertainty.label}
                kind="uncertain"
                title={cell.status.uncertainty.title}
              />
            </>
          ) : null}
        </>
      ) : null}
      {cell.drill ? (
        <>
          {" "}
          <button
            type="button"
            aria-label={cell.drill.ariaLabel}
            title={cell.drill.ariaLabel}
            onClick={(event) => {
              event.stopPropagation();
              onDrill(cell.drill?.eventID ?? "");
            }}
            className="rounded-sm text-[11px] text-accent hover:underline"
          >
            {cell.drill.label}
          </button>
        </>
      ) : null}
    </>
  );
}

function StepDetailRow({
  row,
  columns,
  responseLimit,
  onDrill,
  onOpenSession,
}: {
  row: StatsRow;
  columns: readonly StatsColumn[];
  responseLimit: number;
  onDrill(eventID: string): void;
  onOpenSession(sessionID: string): void;
}) {
  if (!row.turn || !row.step) return null;
  const detail = buildStepDetail(row.turn, row.step, responseLimit);
  return (
    <tr>
      <td colSpan={columns.length} className="border-b border-border bg-surface-2 px-3 py-2.5">
        <div className="grid gap-3 min-[760px]:grid-cols-2">
          <div className="min-w-0">
            <h4 className="m-0 mb-1 text-[12px] font-semibold text-text">
              {detail.heading}
              {detail.truncated ? " (truncated)" : ""}
            </h4>
            <div
              className="max-w-[72ch] text-[12px] leading-[1.55] text-text-2"
              // `renderMarkdown` escapes the whole source before any rule runs.
              dangerouslySetInnerHTML={{ __html: detail.html }}
            />
            {detail.reasoningHtml ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11.5px] text-text-2">Reasoning</summary>
                <div
                  className="max-w-[72ch] text-[12px] leading-[1.55] text-text-2"
                  dangerouslySetInnerHTML={{ __html: detail.reasoningHtml }}
                />
              </details>
            ) : null}
          </div>
          <div className="min-w-0">
            <h4 className="m-0 mb-1 text-[12px] font-semibold text-text">Step facts</h4>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
              {detail.facts.map((fact) => (
                <Fragment key={fact.label}>
                  <dt className="text-muted">{fact.label}</dt>
                  <dd className="m-0 break-words text-text-2">{fact.value}</dd>
                </Fragment>
              ))}
            </dl>
            <h4 className="m-0 mt-2 mb-1 text-[12px] font-semibold text-text">Tool calls</h4>
            {detail.tools.length === 0 ? (
              <p className="m-0 text-[11.5px] text-muted">{detail.noToolsNote}</p>
            ) : (
              <div className="grid gap-1.5">
                {detail.tools.map((tool) => (
                  <div key={tool.key} className="rounded-sm border border-border bg-surface px-2 py-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge label={tool.status} kind={tool.statusKind} />
                      <strong className="text-[11.5px] text-text">{tool.name}</strong>
                      <span className="text-[11px] text-muted tabular-nums" title={tool.duration.title}>
                        {tool.duration.text}
                      </span>
                      {tool.childSessionIDs.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => onOpenSession(id)}
                          aria-label={`Open child session ${id}`}
                          className="rounded-sm text-[11px] text-accent hover:underline"
                        >
                          subagent {id}
                        </button>
                      ))}
                    </div>
                    {tool.inputPreview ? (
                      <pre className="mt-1 mb-0 overflow-x-auto text-[11px] text-text-2">
                        {tool.inputPreview}
                      </pre>
                    ) : null}
                    {tool.outputPreview ? (
                      <pre className="mt-1 mb-0 overflow-x-auto text-[11px] text-text-2">
                        {tool.outputPreview}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {detail.jump ? (
              <div className="mt-2">
                <button
                  type="button"
                  aria-label={detail.jump.ariaLabel}
                  onClick={() => onDrill(detail.jump?.eventID ?? "")}
                  className="rounded-sm border border-border bg-surface px-2 py-1 text-[11.5px] text-text-2 hover:border-border-strong hover:text-text"
                >
                  {detail.jump.label}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  );
}

export interface StatsTableProps {
  columns: readonly StatsColumn[];
  rows: readonly StatsRow[];
  totals: TotalsRowModel;
  responseLimit: number;
  onToggleTurn(turnID: string): void;
  onToggleStep(turnID: string, stepID: string): void;
  onDrill(eventID: string): void;
  onOpenSession(sessionID: string): void;
}

/**
 * The one statistics table, parameterised by the column model. Identity
 * columns stay visible while the 19-column set scrolls horizontally: `#` and
 * `Trigger` stick to the left, `Status` to the right, each separated by a
 * `border-strong` rule, and the frozen behaviour is released below 700 px. The
 * totals row sticks to the bottom on `surface-3` (`DESIGN.md:49`).
 */
export function StatsTable({
  columns,
  rows,
  totals,
  responseLimit,
  onToggleTurn,
  onToggleStep,
  onDrill,
  onOpenSession,
}: StatsTableProps) {
  return (
    <div className="overflow-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-max border-collapse text-[12px]">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={clsx(
                  "border-b border-border bg-surface-2 px-2 py-1.5 text-left text-[11px] font-semibold whitespace-nowrap text-text-2",
                  column.numeric ? "text-right" : "",
                  frozenClass(column),
                  column.frozen ? "bg-surface-2" : "",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.kind === "detail") {
              return (
                <StepDetailRow
                  key={row.key}
                  row={row}
                  columns={columns}
                  responseLimit={responseLimit}
                  onDrill={onDrill}
                  onOpenSession={onOpenSession}
                />
              );
            }
            if (row.kind === "event") {
              const event = row.event;
              if (!event) return null;
              const model = eventRowModel(event);
              return (
                <tr
                  key={row.key}
                  className="cursor-pointer bg-surface-2 hover:bg-surface-3"
                  onClick={() => onDrill(event.id)}
                >
                  <td className="border-b border-border px-2 py-1 font-mono text-[11px] text-muted">
                    {model.time}
                  </td>
                  <td className="border-b border-border px-2 py-1 text-[11.5px] text-text-2">
                    {model.kind}
                  </td>
                  <td className="border-b border-border px-2 py-1 text-[11.5px] text-text-2" colSpan={columns.length - 2}>
                    {model.title} <span className="text-muted">— {model.note}</span>
                  </td>
                </tr>
              );
            }
            const background = row.expanded ? "bg-surface-2" : "bg-surface";
            return (
              <tr
                key={row.key}
                className={clsx(
                  "cursor-pointer",
                  row.expanded ? "bg-surface-2" : "bg-surface",
                  row.kind === "step" ? "text-[11.5px]" : "",
                )}
                onClick={() => {
                  if (row.kind === "step" && row.stepID) onToggleStep(row.turnID, row.stepID);
                  else onToggleTurn(row.turnID);
                }}
              >
                {row.cells.map((cell, index) => {
                  const column = columns[index];
                  if (!column) return null;
                  return (
                    <td
                      key={cell.key}
                      colSpan={cell.span}
                      title={cell.title}
                      className={cellClass(cell, column, background)}
                    >
                      <CellContent
                        cell={cell}
                        turnID={row.turnID}
                        onToggleTurn={onToggleTurn}
                        onToggleStep={onToggleStep}
                        onDrill={onDrill}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-surface-3 font-semibold">
            {totals.cells.map((cell) => (
              <td
                key={cell.key}
                colSpan={cell.span}
                title={cell.title}
                className={clsx(
                  "sticky bottom-0 z-20 border-t border-border-strong bg-surface-3 px-2 py-1.5 align-top",
                  cell.numeric ? "text-right tabular-nums" : "",
                )}
              >
                <CellContent
                  cell={cell}
                  turnID=""
                  onToggleTurn={onToggleTurn}
                  onToggleStep={onToggleStep}
                  onDrill={onDrill}
                />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
