/**
 * The paging primitives from `src/ui/paging.js`, ported to TypeScript.
 *
 * `test/paging.test.ts` already pins these behaviours on the core copy; this
 * module is the browser-side twin the Trajectory ledger uses, and
 * `test/web-paging.test.ts` mirrors the same table so the two can never drift.
 *
 * Nothing here touches the DOM or React: `useEvents` calls it, the tests import
 * it directly.
 */

/** The legacy page size for `GET /api/sessions/:id/events` (`app.js:513`). */
export const EVENT_PAGE_LIMIT = 240;

/** The legacy virtual-list overscan (`VirtualList` default, `app.js:1795`). */
export const LEDGER_OVERSCAN = 8;

export type PageDirection = "backward" | "forward";

export interface MergeResult<T> {
  items: T[];
  added: number;
  addedBefore: number;
  addedAfter: number;
}

/**
 * Deduplicates by `id` across pages and re-sorts by the stable order key.
 * `direction` only changes the counters, never the ordering rule.
 */
export function mergePages<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  direction: PageDirection,
  orderKey: (item: T) => string,
): MergeResult<T> {
  const map = new Map<string, T>();
  for (const item of existing) map.set(item.id, item);
  let addedBefore = 0;
  let addedAfter = 0;
  for (const item of incoming) {
    if (map.has(item.id)) continue;
    map.set(item.id, item);
    if (direction === "backward") addedBefore++;
    else addedAfter++;
  }
  const items = [...map.values()].sort((a, b) => {
    const left = orderKey(a);
    const right = orderKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { items, added: addedBefore + addedAfter, addedBefore, addedAfter };
}

/**
 * The scroll anchor after older rows are prepended: the viewport keeps showing
 * the row it showed before, so the reader never loses their place.
 */
export function preserveScrollAfterPrepend(
  scrollTop: number,
  previousHeight: number,
  nextHeight: number,
): number {
  return Math.max(0, scrollTop + Math.max(0, nextHeight - previousHeight));
}

/**
 * The pure window over a fixed-height row model, kept for the contract tests
 * and as documentation of the overscan rule. The live ledger delegates the same
 * maths to TanStack Virtual, which also measures variable heights.
 */
export function virtualRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = 6,
): { start: number; end: number } {
  if (rowHeight <= 0 || count <= 0) return { start: 0, end: 0 };
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const maxStart = Math.max(0, count - visible);
  const rawStart = Math.floor(scrollTop / rowHeight) - overscan;
  const start = Math.min(maxStart, Math.max(0, rawStart));
  return { start, end: Math.min(count, start + visible) };
}
