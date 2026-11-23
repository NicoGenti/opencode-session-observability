import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
} from "react";
import {
  rowHeight,
  rowKey,
  type LedgerRow,
} from "../lib/ledger.ts";
import {
  changedAboveAnchor,
  clampScrollTop,
  rememberLedgerScroll,
} from "../lib/ledger-scroll.ts";
import { preserveScrollAfterPrepend } from "../lib/paging.ts";
import { useVirtualLedger } from "../hooks/useVirtualLedger.ts";
import { LedgerRowView } from "./LedgerRow.tsx";

export interface LedgerHandle {
  /** Scrolls to an event row; returns false when it is not in the page. */
  scrollToEvent(eventID: string): boolean;
  scrollToIndex(index: number): void;
  /** Scrolls to a row and moves DOM focus onto it (keyboard cursor). */
  focusIndex(index: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

export interface LedgerProps {
  sessionID: string;
  rows: readonly LedgerRow[];
  selectedEventID: string | null;
  cursorEventID: string | null;
  highlightedEventIDs: ReadonlySet<string>;
  revision: number;
  status: "loading" | "ready" | "error";
  error: string | null;
  controller: MutableRefObject<LedgerHandle | null>;
  onOpen(eventID: string): void;
  /**
   * Offset to put back once the first page has height. Set only when this
   * ledger is a re-mount of a scroller the user had already scrolled (reveal
   * epoch, live heavy pass); consumed once.
   */
  restoreScrollTop?: number | null;
}

function firstByEventID(id: string): HTMLElement | null {
  const scroller = document.getElementById("ledger-scroll");
  if (!scroller) return null;
  const rows = scroller.querySelectorAll<HTMLElement>("[data-event-id]");
  for (const row of rows) {
    if (row.dataset.eventId === id) return row;
  }
  return null;
}

/**
 * The TanStack Virtual ledger.
 *
 * There is no fixed row height anywhere: each wrapper is translated to
 * `item.start` and measured with `virtualizer.measureElement`, so a wrapped
 * preview simply makes its own row taller. The estimate from
 * `lib/ledger.ts#rowHeight` only positions rows before their first measurement.
 *
 * The ledger owns its scroll anchoring in one place. TanStack's own item-size
 * compensation is disabled in `useVirtualLedger`, and this component keeps the
 * anchor explicit: it remembers the row key (`rowKey`) at the first rendered
 * row — `virtualizer.range.startIndex`, which includes the overscan and so is
 * usually a row above the viewport, not the first visible one — and applies the
 * legacy `preserveScrollAfterPrepend` maths when that key has moved. A
 * prepended page or a late header insert above it therefore keeps the reader in
 * place, including at the top of the loaded window; rows appended below the
 * anchor, header inserts below it and measurement growth never move the view.
 * The offset also survives a view re-mount: it is put back once the first page
 * has height (`restoreScrollTop`, fed from `lib/ledger-scroll.ts`).
 */
export function Ledger({
  sessionID,
  rows,
  selectedEventID,
  cursorEventID,
  highlightedEventIDs,
  revision,
  status,
  error,
  controller,
  onOpen,
  restoreScrollTop,
}: LedgerProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const estimateSize = useCallback((index: number): number => {
    const row = rowsRef.current[index];
    return row ? rowHeight(row) : 0;
  }, []);
  const getItemKey = useCallback((index: number): string => {
    const row = rowsRef.current[index];
    return row ? rowKey(row) : String(index);
  }, []);

  const { virtualizer, scrollToIndex, scrollToTop, scrollToBottom } = useVirtualLedger({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize,
    getItemKey,
  });

  const seen = useRef<{
    revision: number;
    scrollTop: number;
    total: number;
    keys: string[];
  }>({ revision, scrollTop: 0, total: 0, keys: [] });
  // One-shot: the offset the destroyed scroller had before this re-mount.
  const pendingRestore = useRef<number | null>(restoreScrollTop ?? null);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const onScroll = (): void => {
      seen.current = { ...seen.current, scrollTop: element.scrollTop };
      // Mirrors the legacy `state.scrollTop` writer (`app.js:1809-1815`): the
      // value a later re-mount reads is always the last rendered position.
      rememberLedgerScroll(sessionID, element.scrollTop);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [sessionID]);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const total = virtualizer.getTotalSize();
    // A re-mounted view restores the user's place as soon as the first page
    // gives the canvas height, before any reset/`earlier` decision below.
    if (pendingRestore.current !== null) {
      if (total <= 0) return;
      element.scrollTop = clampScrollTop(
        pendingRestore.current,
        total,
        element.clientHeight,
      );
      pendingRestore.current = null;
      seen.current = {
        revision,
        scrollTop: element.scrollTop,
        total,
        keys: rowsRef.current.map(rowKey),
      };
      rememberLedgerScroll(sessionID, element.scrollTop);
      return;
    }
    // The anchor is the key at the first rendered row (overscan included). A
    // prepended page or a late header insert above it replaces that key, so the
    // reader needs compensating; growth below it, a re-measurement or an
    // appended page leaves the key in place.
    const keys = rowsRef.current.map(rowKey);
    const anchor = virtualizer.range?.startIndex ?? 0;
    if (changedAboveAnchor(seen.current.keys, keys, anchor)) {
      element.scrollTop = preserveScrollAfterPrepend(
        seen.current.scrollTop,
        seen.current.total,
        total,
      );
    }
    seen.current = {
      revision,
      scrollTop: element.scrollTop,
      total,
      keys,
    };
  }, [revision, rows, sessionID, virtualizer]);

  const handle = useMemo<LedgerHandle>(
    () => ({
      scrollToEvent(eventID: string): boolean {
        const index = rowsRef.current.findIndex(
          (row) => row.type === "event" && row.eventID === eventID,
        );
        if (index < 0) return false;
        scrollToIndex(index);
        return true;
      },
      scrollToIndex,
      focusIndex(index: number): void {
        const row = rowsRef.current[index];
        scrollToIndex(index);
        if (!row || row.type !== "event") return;
        // The row is normally inside the overscan window, so focus it in the
        // same task; a far jump retries once the virtual window has painted.
        const target = firstByEventID(row.eventID);
        if (target) {
          target.focus();
          return;
        }
        requestAnimationFrame(() => {
          firstByEventID(row.eventID)?.focus();
        });
      },
      scrollToTop,
      scrollToBottom,
    }),
    [scrollToBottom, scrollToIndex, scrollToTop],
  );

  // The handle must exist before the parent's reset-landing layout effect runs
  // (child layout effects fire first).
  useLayoutEffect(() => {
    controller.current = handle;
  }, [controller, handle]);

  useLayoutEffect(
    () => () => {
      controller.current = null;
    },
    [controller],
  );

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollerRef}
      id="ledger-scroll"
      tabIndex={-1}
      aria-busy={status === "loading" ? "true" : undefined}
      aria-label="Event ledger"
      className="relative min-h-0 flex-1 overflow-auto border-x border-t border-border bg-surface"
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {items.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const isEvent = row.type === "event";
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <LedgerRowView
                row={row}
                selected={isEvent && row.eventID === selectedEventID}
                cursor={isEvent && row.eventID === cursorEventID}
                highlighted={isEvent && highlightedEventIDs.has(row.eventID)}
                onOpen={onOpen}
              />
            </div>
          );
        })}
      </div>
      {status === "loading" && rows.length === 0 ? (
        <p className="m-0 p-3 text-[12px] text-text-2">Loading events…</p>
      ) : null}
      {status === "error" ? (
        <p role="status" className="m-0 p-3 text-[12px] text-text-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
