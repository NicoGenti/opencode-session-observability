export interface HasId {
  id: string;
}

/**
 * Merges a page into the already loaded rows. Pages can arrive backwards
 * (older rows prepended) or forwards (newer rows appended); duplicate ids are
 * dropped and recorded order is restored.
 */
export function mergePages<T extends HasId>(
  existing: readonly T[],
  incoming: readonly T[],
  direction: "backward" | "forward",
  orderKey: (item: T) => string,
): { items: T[]; added: number; addedBefore: number; addedAfter: number } {
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
 * Scroll anchor for prepending rows above the viewport. Returns the new
 * scrollTop that keeps the same content under the user's eyes.
 */
export function preserveScrollAfterPrepend(
  scrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  const delta = Math.max(0, nextScrollHeight - previousScrollHeight);
  return Math.max(0, scrollTop + delta);
}

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
  const end = Math.min(count, start + visible);
  return { start, end };
}

export function pageSlice<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { items: T[]; hasMore: boolean; total: number } {
  const start = Math.max(0, Math.floor(offset));
  const end = Math.min(items.length, start + Math.max(1, Math.floor(limit)));
  return {
    items: items.slice(start, end),
    hasMore: end < items.length,
    total: items.length,
  };
}
