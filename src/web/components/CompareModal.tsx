import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import type { ApiFn } from "../lib/api.ts";
import type { EpisodeComparison } from "../../core/episodeCompare.ts";
import type { DiagnosticEpisode } from "../../core/episodes.ts";
import type { SessionFamily, SessionMeta } from "../../core/types.ts";
import {
  COMPARE_BANNER,
  COMPARE_CARD_WIDTH,
  COMPARE_KEYS_HINT,
  COMPARE_LOADING,
  COMPARE_NO_ALIGNMENT,
  COMPARE_TITLE,
  alignmentRows,
  compareApiPath,
  compareIdentityRows,
  compareKeyIntent,
  compareMetricRows,
  compareReady,
  compareSessionOptions,
  compareSessionTotalRows,
  compareStatusMessages,
  compareTokenRows,
  compareTurnRows,
  episodeLabel,
  episodeSelectState,
  isTypingTarget,
  metricCell,
  nextCompareSelection,
  tokenIncompleteNote,
  tokenLabel,
  turnCaption,
  type CompareSessionOption,
  type CompareSide,
  type MetricCellModel,
} from "../lib/compare.ts";

const EMPTY_SIDE = Object.freeze({
  sessionID: null,
  episodes: [] as DiagnosticEpisode[],
  episodeID: null,
  error: null,
  loading: false,
});

type SideState = {
  sessionID: string | null;
  episodes: DiagnosticEpisode[];
  episodeID: string | null;
  error: string | null;
  loading: boolean;
};

type Sides = { left: SideState; right: SideState };

const EMPTY_SIDES: Sides = {
  left: { ...EMPTY_SIDE },
  right: { ...EMPTY_SIDE },
};

export interface CompareModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  api: ApiFn;
  /** The route's session: the left side's default and the picker's "current". */
  sessionID: string | null;
  /** Focus restoration target, run from Radix's `onCloseAutoFocus`. */
  onRestoreFocus?(): void;
  /** Surfaces a request failure in the global error banner. */
  onError?(message: string): void;
}

const SELECT =
  "w-full rounded-sm border border-border-strong bg-surface px-1.5 py-1 text-[12px] text-text";
const LABEL = "text-[11px] text-muted";
const HEAD = "border-b border-border bg-surface-2 px-2 py-1 text-left text-[11px] text-text-2";
const CELL = "border-b border-grid px-2 py-1 align-top text-[11.5px]";

function MetricText({ cell }: { cell: MetricCellModel }) {
  return (
    <span title={cell.title ?? undefined} className={cell.available ? undefined : "text-muted"}>
      {cell.text}
      {cell.mark ? (
        <sup className="ml-px align-super text-[10px] text-muted">{cell.mark}</sup>
      ) : null}
    </span>
  );
}

/**
 * The compare modal (`app.js:3711-3992`, `docs/UI.md:229-237`).
 *
 * The card is a deliberate 960 px exception to the 520 px modal standard
 * (`docs/UI.md:333`): two side-by-side episode columns do not fit 520 px. Radix
 * owns the focus trap, `Esc` and the opener restoration; the arrow keys are the
 * modal's own model — ↑/↓ move the alignment selection with wraparound and
 * ←/→ move between the selected row's inputs — and both consume the key press so
 * the page never scrolls. Native select/input behaviour is left alone.
 *
 * Every difference is `left − right` and descriptive. No attempt is designated
 * as better, and unavailable inputs keep their comparability flag instead of a
 * guessed similarity.
 */
export function CompareModal({
  open,
  onOpenChange,
  api,
  sessionID,
  onRestoreFocus,
  onError,
}: CompareModalProps) {
  const [sides, setSides] = useState<Sides>(EMPTY_SIDES);
  const [options, setOptions] = useState<CompareSessionOption[]>([]);
  const [status, setStatus] = useState<{ message: string; error: boolean }>({
    message: "",
    error: false,
  });
  const [comparison, setComparison] = useState<EpisodeComparison | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [selection, setSelection] = useState(0);

  const sidesRef = useRef<Sides>(EMPTY_SIDES);
  const sideSeq = useRef<{ left: number; right: number }>({ left: 0, right: 0 });
  const compareSeq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const commitSides = useCallback((next: Sides) => {
    sidesRef.current = next;
    setSides(next);
  }, []);

  const setSide = useCallback(
    (side: CompareSide, next: SideState) => {
      commitSides({ ...sidesRef.current, [side]: next });
    },
    [commitSides],
  );

  const requestCompare = useCallback(async (): Promise<void> => {
    const current = sidesRef.current;
    if (!compareReady(current)) {
      compareSeq.current += 1;
      setComparison(null);
      setComparisonError(null);
      setLoadingComparison(false);
      return;
    }
    const ticket = ++compareSeq.current;
    setComparison(null);
    setComparisonError(null);
    setLoadingComparison(true);
    try {
      const data = await api<{ comparison?: EpisodeComparison }>(
        compareApiPath({
          leftSession: current.left.sessionID ?? "",
          leftEpisode: current.left.episodeID ?? "",
          rightSession: current.right.sessionID ?? "",
          rightEpisode: current.right.episodeID ?? "",
        }),
      );
      if (ticket !== compareSeq.current) return;
      setComparison(data.comparison ?? null);
      setSelection(0);
    } catch (failure) {
      if (ticket !== compareSeq.current) return;
      setComparison(null);
      setComparisonError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (ticket === compareSeq.current) setLoadingComparison(false);
    }
  }, [api]);

  const loadSide = useCallback(
    async (
      side: CompareSide,
      nextSessionID: string | null,
      autoSelect: boolean,
    ): Promise<void> => {
      const ticket = ++sideSeq.current[side];
      setSide(side, {
        sessionID: nextSessionID,
        episodes: [],
        episodeID: null,
        error: null,
        loading: Boolean(nextSessionID),
      });
      if (!nextSessionID) return;
      try {
        const payload = await api<{ episodes?: DiagnosticEpisode[] }>(
          `/api/sessions/${encodeURIComponent(nextSessionID)}/diagnostics`,
        );
        if (ticket !== sideSeq.current[side]) return;
        if (sidesRef.current[side].sessionID !== nextSessionID) return;
        const episodes = Array.isArray(payload.episodes) ? payload.episodes : [];
        let episodeID: string | null = null;
        if (autoSelect && episodes.length > 0) {
          // Same-session comparisons default the right side to a different
          // episode, so the modal never opens on an episode compared to itself.
          const taken =
            side === "right" && sidesRef.current.left.sessionID === nextSessionID
              ? sidesRef.current.left.episodeID
              : null;
          episodeID = (episodes.find((episode) => episode.id !== taken) ?? episodes[0]!).id;
        }
        const next: SideState = {
          sessionID: nextSessionID,
          episodes,
          episodeID,
          error: null,
          loading: false,
        };
        setSide(side, next);
        setStatus(compareStatusMessages({ ...sidesRef.current, [side]: next }));
      } catch (failure) {
        if (ticket !== sideSeq.current[side]) return;
        if (sidesRef.current[side].sessionID !== nextSessionID) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        const next: SideState = {
          sessionID: nextSessionID,
          episodes: [],
          episodeID: null,
          error: message,
          loading: false,
        };
        setSide(side, next);
        setStatus(compareStatusMessages({ ...sidesRef.current, [side]: next }));
      }
    },
    [api, setSide],
  );

  // Opening resolves the picker options once, then auto-selects both sides: the
  // current session on the left, a sibling on the right where one exists.
  useEffect(() => {
    if (!open) {
      compareSeq.current += 1;
      return;
    }
    let active = true;
    compareSeq.current += 1;
    sideSeq.current = { left: 0, right: 0 };
    commitSides({ left: { ...EMPTY_SIDE }, right: { ...EMPTY_SIDE } });
    setComparison(null);
    setComparisonError(null);
    setLoadingComparison(false);
    setSelection(0);
    setOptions([]);
    setStatus({ message: "", error: false });

    void (async () => {
      let session: SessionMeta | null = null;
      let family: SessionFamily | null = null;
      try {
        const data = await api<{ session?: SessionMeta; family?: SessionFamily }>(
          `/api/sessions/${encodeURIComponent(sessionID ?? "")}`,
        );
        session = data.session ?? null;
        family = data.family ?? null;
      } catch (failure) {
        if (!active) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        onError?.(message);
      }
      if (!active) return;
      const nextOptions = compareSessionOptions({
        session,
        family,
        currentSessionID: sessionID,
      });
      setOptions(nextOptions);
      const currentID = session?.id ?? sessionID;
      if (!currentID) return;
      const sibling = nextOptions.find((option) => option.id !== currentID);
      const rightID = sibling?.id ?? currentID;
      await loadSide("left", currentID, true);
      if (!active) return;
      await loadSide("right", rightID, true);
      if (!active) return;
      await requestCompare();
    })();

    return () => {
      active = false;
    };
  }, [api, commitSides, loadSide, onError, open, requestCompare, sessionID]);

  const rows = useMemo(() => alignmentRows(comparison), [comparison]);

  // Scroll the selected row into view without moving focus away from the dialog.
  useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (!body) return;
    body
      .querySelector<HTMLElement>(`[data-align-index="${selection}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, selection, rows.length]);

  const focusInput = useCallback((side: CompareSide): boolean => {
    const body = bodyRef.current;
    if (!body) return false;
    const input = body.querySelector<HTMLElement>(
      `[data-align-index="${selection}"] [data-input="${side}"]`,
    );
    if (!input) return false;
    input.focus();
    return true;
  }, [selection]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const intent = compareKeyIntent(event.key, {
        typing: isTypingTarget(event.target as unknown as { tagName?: string } | null),
        hasRows: rows.length > 0,
      });
      switch (intent.kind) {
        case "close":
          event.preventDefault();
          onOpenChange(false);
          return;
        case "move":
          event.preventDefault();
          setSelection((current) =>
            nextCompareSelection(current, rows.length, intent.delta),
          );
          return;
        case "focus-input":
          if (focusInput(intent.side)) event.preventDefault();
          return;
        case "trap-focus":
        case "native":
        case "ignore":
          return;
      }
    },
    [focusInput, onOpenChange, rows.length],
  );

  const onSessionChange = useCallback(
    async (side: CompareSide, nextSessionID: string) => {
      // A manual session change keeps the legacy no-auto-select behaviour
      // (`app.js:3742`): the picker waits for an explicit episode choice.
      await loadSide(side, nextSessionID, false);
      compareSeq.current += 1;
      setComparison(null);
      setSelection(0);
      await requestCompare();
    },
    [loadSide, requestCompare],
  );

  const onEpisodeChange = useCallback(
    (side: CompareSide, nextEpisodeID: string) => {
      setSide(side, { ...sidesRef.current[side], episodeID: nextEpisodeID || null });
      if (!compareReady(sidesRef.current)) {
        compareSeq.current += 1;
        setComparison(null);
        setSelection(0);
        return;
      }
      void requestCompare();
    },
    [requestCompare, setSide],
  );

  const totalRows = compareMetricRows(compareSessionTotalRows(), comparison?.totals);
  const turnRows = compareMetricRows(compareTurnRows(), comparison?.turn);
  const totalTokens = compareTokenRows(comparison?.totals);
  const turnTokens = compareTokenRows(comparison?.turn);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-page/70 frosted-scrim" />
        <Dialog.Content
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus?.();
        }}
        style={{ width: `min(${COMPARE_CARD_WIDTH}px, 94vw)` }}
        className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border floating-frost p-5 text-text shadow-float"
      >
        <Dialog.Title className="m-0 text-[14px] font-semibold">{COMPARE_TITLE}</Dialog.Title>
        <p className="m-0 mt-1 text-[12px] text-text-2">{COMPARE_BANNER}</p>

        <div className="mt-3 grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
          {(["left", "right"] as const).map((side) => {
            const data = sides[side];
            const state = episodeSelectState(data);
            return (
              <div key={side} className="grid gap-1">
                <label className="grid gap-0.5">
                  <span className={LABEL}>{`${tokenLabel(side)} session`}</span>
                  <select
                    value={data.sessionID ?? ""}
                    onChange={(event) => void onSessionChange(side, event.target.value)}
                    className={SELECT}
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-0.5">
                  <span className={LABEL}>{`${tokenLabel(side)} episode`}</span>
                  <select
                    value={data.episodeID ?? ""}
                    disabled={state.disabled}
                    onChange={(event) => onEpisodeChange(side, event.target.value)}
                    className={SELECT}
                  >
                    <option value="">{state.label}</option>
                    {data.episodes.map((episode) => (
                      <option key={episode.id} value={episode.id}>
                        {episodeLabel(episode)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
        </div>

        <div
          role="status"
          tabIndex={0}
          hidden={status.message.length === 0}
          className={clsx(
            "mt-2 text-[12px]",
            status.error ? "text-critical" : "text-text-2",
          )}
        >
          {status.message}
        </div>

        <div ref={bodyRef} className="mt-3 grid gap-2.5">
          {loadingComparison ? (
            <p className="m-0 text-[12px] text-muted">{COMPARE_LOADING}</p>
          ) : comparisonError ? (
            <p role="alert" tabIndex={0} className="m-0 text-[12px] text-critical">
              {comparisonError}
            </p>
          ) : comparison ? (
            <>
              <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
                {(["left", "right"] as const).map((side) => (
                  <div key={side} className="rounded-lg border border-border bg-surface-2 p-2.5">
                    <h3 className="m-0 text-[12.5px] font-semibold">{tokenLabel(side)}</h3>
                    <dl className="m-0 mt-1 grid grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11.5px]">
                      {compareIdentityRows(comparison[side]).map((row) => (
                        <div key={row.label} className="contents">
                          <dt className="text-muted">{row.label}</dt>
                          <dd className="m-0 break-words">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>

              <h3 className="m-0 text-[12.5px] font-semibold">Attempt alignment</h3>
              {rows.length === 0 ? (
                <p className="m-0 text-[11.5px] text-muted">{COMPARE_NO_ALIGNMENT}</p>
              ) : (
                <div className="overflow-auto rounded-lg border border-border">
                  <table className="w-full min-w-[760px] border-collapse">
                    <thead>
                      <tr>
                        {["#", "Kind", "Presence", "Left", "Right", "Duration Δ", "Input similarity"].map(
                          (label) => (
                            <th key={label} scope="col" className={HEAD}>
                              {label}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, position) => {
                        const selected = position === selection;
                        return (
                          <tr
                            key={row.index}
                            data-align-index={position}
                            aria-current={selected ? "true" : undefined}
                            className={clsx(
                              selected ? "bg-accent-weak" : "bg-surface",
                              "text-[11.5px] text-text-2",
                            )}
                          >
                            <td className={CELL}>
                              {selected ? (
                                <span className="mr-1 rounded-full border border-accent px-1 text-[10px] text-accent">
                                  Selected
                                </span>
                              ) : null}
                              {row.index}
                            </td>
                            <td className={CELL}>{row.kind}</td>
                            <td className={CELL}>{row.presence}</td>
                            <td className={CELL}>
                              <div className="grid gap-0.5">
                                <span className="text-text">{row.leftStatus ?? "—"}</span>
                                <span className="text-muted">{row.leftDuration}</span>
                                {row.leftFlag ? (
                                  <span className="text-[10.5px] text-text-2">{row.leftFlag}</span>
                                ) : null}
                                {row.leftInput !== null ? (
                                  <pre
                                    data-input="left"
                                    tabIndex={0}
                                    aria-label="Input as recorded on the left side"
                                    className="m-0 mt-0.5 max-h-[160px] overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-surface p-1.5 font-mono text-[11px]"
                                  >
                                    {row.leftInput}
                                  </pre>
                                ) : null}
                              </div>
                            </td>
                            <td className={CELL}>
                              <div className="grid gap-0.5">
                                <span className="text-text">{row.rightStatus ?? "—"}</span>
                                <span className="text-muted">{row.rightDuration}</span>
                                {row.rightFlag ? (
                                  <span className="text-[10.5px] text-text-2">{row.rightFlag}</span>
                                ) : null}
                                {row.rightInput !== null ? (
                                  <pre
                                    data-input="right"
                                    tabIndex={0}
                                    aria-label="Input as recorded on the right side"
                                    className="m-0 mt-0.5 max-h-[160px] overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-surface p-1.5 font-mono text-[11px]"
                                  >
                                    {row.rightInput}
                                  </pre>
                                ) : null}
                              </div>
                            </td>
                            <td className={clsx(CELL, "text-right tabular-nums")}>
                              {row.latencyDelta}
                            </td>
                            <td className={CELL}>
                              {row.similarity}
                              {row.overlap ? (
                                <span className="text-muted"> · {row.overlap}</span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <MetricTable caption="Session totals" rows={totalRows} />
              <MetricTable caption={turnCaption(comparison)} rows={turnRows} />
              <TokenTable
                caption="Session tokens"
                rows={totalTokens}
                note={tokenIncompleteNote(comparison.totals)}
              />
              <TokenTable
                caption="Turn tokens"
                rows={turnTokens}
                note={tokenIncompleteNote(comparison.turn)}
              />

              {Array.isArray(comparison.notes) && comparison.notes.length > 0 ? (
                <>
                  <h3 className="m-0 text-[12.5px] font-semibold">Notes</h3>
                  <ul className="m-0 grid list-none gap-0.5 p-0 text-[11.5px] text-text-2">
                    {comparison.notes.map((note) => (
                      <li key={note} className="border-l-2 border-border pl-2">
                        {note}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
        </div>

        <p className="m-0 mt-2 text-[11px] text-muted">{COMPARE_KEYS_HINT}</p>
      </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MetricTable({
  caption,
  rows,
}: {
  caption: string;
  rows: ReturnType<typeof compareMetricRows>;
}) {
  return (
    <div className="grid gap-1">
      <h3 className="m-0 text-[12.5px] font-semibold">{caption}</h3>
      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Metric", "Left", "Right", "Δ (left − right)"].map((label) => (
                <th key={label} scope="col" className={HEAD}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="text-[11.5px] text-text-2">
                <th scope="row" className={clsx(CELL, "text-left font-normal")}>
                  {row.label}
                </th>
                <td className={clsx(CELL, "text-right tabular-nums")}>
                  <MetricText cell={row.left} />
                </td>
                <td className={clsx(CELL, "text-right tabular-nums")}>
                  <MetricText cell={row.right} />
                </td>
                <td className={clsx(CELL, "text-right tabular-nums")}>
                  <MetricText cell={row.delta} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TokenTable({
  caption,
  rows,
  note,
}: {
  caption: string;
  rows: ReturnType<typeof compareTokenRows>;
  note: string;
}) {
  return (
    <div className="grid gap-1">
      <h3 className="m-0 text-[12.5px] font-semibold">{caption}</h3>
      {note ? <p className="m-0 text-[11.5px] text-muted">{note}</p> : null}
      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Metric", "Left", "Right", "Δ (left − right)"].map((label) => (
                <th key={label} scope="col" className={HEAD}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="text-[11.5px] text-text-2">
                <th scope="row" className={clsx(CELL, "text-left font-normal")}>
                  {row.label}
                </th>
                <td className={clsx(CELL, "text-right tabular-nums")}>{row.left}</td>
                <td className={clsx(CELL, "text-right tabular-nums")}>{row.right}</td>
                <td className={clsx(CELL, "text-right tabular-nums")}>{row.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
