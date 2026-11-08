export function mergePages(existing, incoming, direction, orderKey) {
  const map = new Map();
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

export function preserveScrollAfterPrepend(scrollTop, previousHeight, nextHeight) {
  return Math.max(0, scrollTop + Math.max(0, nextHeight - previousHeight));
}

export function virtualRange(scrollTop, viewportHeight, rowHeight, count, overscan = 6) {
  if (rowHeight <= 0 || count <= 0) return { start: 0, end: 0 };
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const maxStart = Math.max(0, count - visible);
  const rawStart = Math.floor(scrollTop / rowHeight) - overscan;
  const start = Math.min(maxStart, Math.max(0, rawStart));
  return { start, end: Math.min(count, start + visible) };
}
