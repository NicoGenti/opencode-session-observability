import type { Attribution } from "../../core/attribution.ts";
import type {
  AttributionCommandModel,
  AttributionFileModel,
  AttributionSubtaskModel,
} from "../lib/attribution.ts";
import { buildAttribution } from "../lib/attribution.ts";

function Share({ file }: { file: AttributionFileModel }) {
  const marked = file.share.basis === "derived" || file.share.basis === "estimated";
  return (
    <span className="text-[11px] text-text-2 tabular-nums" title={file.share.title}>
      {file.share.text}
      {marked ? (
        <sup className="ml-px align-super text-[10px] text-muted">{file.share.mark}</sup>
      ) : null}
    </span>
  );
}

function FileRow({
  file,
  onDrill,
}: {
  file: AttributionFileModel;
  onDrill(eventID: string): void;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-1.5">
      <span className="min-w-0 break-words font-mono text-[11px] text-text-2">{file.path}</span>
      <span className="text-[11px] text-muted">{file.ops}</span>
      <Share file={file} />
      {file.links.map((link) => (
        <button
          key={link.key}
          type="button"
          data-event-id={link.eventID}
          aria-label={link.ariaLabel}
          onClick={() => onDrill(link.eventID)}
          className="rounded-sm text-[11px] text-accent hover:underline"
        >
          {link.label}
        </button>
      ))}
    </li>
  );
}

function CommandRow({
  command,
  onDrill,
}: {
  command: AttributionCommandModel;
  onDrill(eventID: string): void;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-1.5">
      <code className="text-[11px] text-text-2">{command.name}</code>
      <span className="text-[11px] text-muted">{command.count}</span>
      {command.links.map((link) => (
        <button
          key={link.key}
          type="button"
          data-event-id={link.eventID}
          aria-label={link.ariaLabel}
          onClick={() => onDrill(link.eventID)}
          className="rounded-sm text-[11px] text-accent hover:underline"
        >
          {link.label}
        </button>
      ))}
    </li>
  );
}

function SubtaskRow({
  subtask,
  onOpenSession,
}: {
  subtask: AttributionSubtaskModel;
  onOpenSession(sessionID: string): void;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-1.5">
      <button
        type="button"
        data-session-id={subtask.sessionID}
        aria-label={subtask.ariaLabel}
        onClick={() => onOpenSession(subtask.sessionID)}
        className="rounded-sm text-[11px] text-accent hover:underline"
      >
        {subtask.sessionID}
      </button>
      {subtask.agent ? <span className="text-[11px] text-muted">{subtask.agent}</span> : null}
    </li>
  );
}

/**
 * Task and file attribution (`docs/UI.md:151-165`): one card per attributed
 * turn, capped rows, per-file cost shares carrying their derived mark and every
 * evidence chip naming its own row. An absent rider renders nothing.
 */
export function AttributionSection({
  attribution,
  onDrill,
  onOpenSession,
}: {
  attribution: Attribution | null | undefined;
  onDrill(eventID: string): void;
  onOpenSession(sessionID: string): void;
}) {
  const model = buildAttribution(attribution);
  if (model.empty) return null;
  return (
    <section aria-label={model.title} className="mt-2.5 rounded-lg border border-border bg-surface p-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-[13px] font-semibold text-text">{model.title}</h2>
        <span className="text-[11.5px] text-muted">{model.rail}</span>
      </div>

      <ul className="m-0 mt-2 grid list-none gap-2 p-0">
        {model.turns.map((turn) => (
          <li key={turn.key} className="rounded-sm border border-border bg-surface px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] font-semibold text-text">{turn.indexLabel}</span>
              {turn.trigger ? <span className="text-[11.5px] text-text-2">{turn.trigger}</span> : null}
              <span className="min-w-0 flex-1" />
              {turn.links.map((link) => (
                <button
                  key={link.key}
                  type="button"
                  data-event-id={link.eventID}
                  aria-label={link.ariaLabel}
                  onClick={() => onDrill(link.eventID)}
                  className="rounded-sm text-[11px] text-accent hover:underline"
                >
                  {link.label}
                </button>
              ))}
            </div>

            {turn.files.rows.length > 0 || turn.files.more ? (
              <div className="mt-1.5">
                <div className="text-[11px] text-muted">{turn.files.label}</div>
                {turn.files.rows.length > 0 ? (
                  <ul className="m-0 mt-0.5 grid list-none gap-0.5 p-0">
                    {turn.files.rows.map((file) => (
                      <FileRow key={file.key} file={file} onDrill={onDrill} />
                    ))}
                  </ul>
                ) : null}
                {turn.files.more ? (
                  <div className="text-[11px] text-muted">{turn.files.more}</div>
                ) : null}
              </div>
            ) : null}

            {turn.commands.rows.length > 0 || turn.commands.more ? (
              <div className="mt-1.5">
                <div className="text-[11px] text-muted">{turn.commands.label}</div>
                {turn.commands.rows.length > 0 ? (
                  <ul className="m-0 mt-0.5 grid list-none gap-0.5 p-0">
                    {turn.commands.rows.map((command) => (
                      <CommandRow key={command.key} command={command} onDrill={onDrill} />
                    ))}
                  </ul>
                ) : null}
                {turn.commands.more ? (
                  <div className="text-[11px] text-muted">{turn.commands.more}</div>
                ) : null}
              </div>
            ) : null}

            {turn.subtasks.rows.length > 0 ? (
              <div className="mt-1.5">
                <div className="text-[11px] text-muted">{turn.subtasks.label}</div>
                <ul className="m-0 mt-0.5 grid list-none gap-0.5 p-0">
                  {turn.subtasks.rows.map((subtask) => (
                    <SubtaskRow key={subtask.key} subtask={subtask} onOpenSession={onOpenSession} />
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="m-0 mt-2 text-[11.5px] text-text-2">{model.commitNote}</p>
      {model.notes.length > 0 ? (
        <ul className="m-0 mt-1 pl-4 text-[11px] text-muted">
          {model.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
