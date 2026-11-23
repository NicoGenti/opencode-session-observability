import { useCallback, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LEDGER_OVERSCAN } from "../lib/paging.ts";

export interface UseVirtualLedgerOptions {
  count: number;
  getScrollElement(): HTMLElement | null;
  estimateSize(index: number): number;
  getItemKey(index: number): string | number;
  overscan?: number;
}

/**
 * The TanStack Virtual ledger engine.
 *
 * Why this is not the legacy `VirtualList`:
 *
 * - Rows are measured (`virtualizer.measureElement`), so a preview that wraps to
 *   two, three or four lines grows its own row. `estimateSize` is only the
 *   pre-measurement guess from the pure height model, and an under-estimate can
 *   delay a row's final offset but can never clip it, because the row element is
 *   not height-constrained: it sits in normal flow at a translated start.
 * - `getItemKey` is the stable row key (`event:<id>`, `step:…`, `turn:…`), so
 *   measurements survive a prepended page instead of shifting to a new index.
 * - Overscan matches the legacy eight rows.
 * - Its item-size compensation is disabled: the ledger owns the scroll anchor
 *   in one place (`Ledger.tsx`). v3.14 removed the option from
 *   `VirtualizerOptions`; the instance still honours the public predicate, so
 *   the documented `false` is installed here before any async measurement.
 *
 * The scroll helpers reproduce `VirtualList.scrollToEvent`'s 25% alignment.
 */
export function useVirtualLedger(options: UseVirtualLedgerOptions) {
  const virtualizer = useVirtualizer({
    count: options.count,
    getScrollElement: options.getScrollElement,
    estimateSize: options.estimateSize,
    getItemKey: options.getItemKey,
    overscan: options.overscan ?? LEDGER_OVERSCAN,
  });

  useLayoutEffect(() => {
    const previous = virtualizer.shouldAdjustScrollPositionOnItemSizeChange;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = previous;
    };
  }, [virtualizer]);

  const scrollToIndex = useCallback(
    (index: number, align = "start" as const): void => {
      const element = virtualizer.scrollElement;
      if (!element) return;
      const target = virtualizer.getOffsetForIndex(index, align);
      if (!target) return;
      element.scrollTop = Math.max(
        0,
        target[0] - Math.floor(element.clientHeight * 0.25),
      );
    },
    [virtualizer],
  );

  const scrollToTop = useCallback((): void => {
    const element = virtualizer.scrollElement;
    if (element) element.scrollTop = 0;
  }, [virtualizer]);

  const scrollToBottom = useCallback((): void => {
    const element = virtualizer.scrollElement;
    if (!element) return;
    element.scrollTop = Math.max(0, virtualizer.getTotalSize() - element.clientHeight);
  }, [virtualizer]);

  return { virtualizer, scrollToIndex, scrollToTop, scrollToBottom };
}
