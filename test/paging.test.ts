import test from "node:test";
import assert from "node:assert/strict";
import {
  mergePages,
  pageSlice,
  preserveScrollAfterPrepend,
  virtualRange,
} from "../src/core/paging.ts";

interface Row {
  id: string;
  orderKey: string;
}

const row = (id: string, orderKey: string): Row => ({ id, orderKey });
const key = (item: Row): string => item.orderKey;

test("backward pages are prepended, deduplicated and sorted", () => {
  const existing = [row("c", "3"), row("d", "4")];
  const incoming = [row("a", "1"), row("b", "2"), row("c", "3")];
  const merged = mergePages(existing, incoming, "backward", key);
  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(merged.added, 2);
  assert.equal(merged.addedBefore, 2);
  assert.equal(merged.addedAfter, 0);
});

test("forward pages are appended and deduplicated", () => {
  const existing = [row("a", "1"), row("b", "2")];
  const incoming = [row("b", "2"), row("c", "3")];
  const merged = mergePages(existing, incoming, "forward", key);
  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(merged.added, 1);
  assert.equal(merged.addedAfter, 1);
});

test("scroll position is preserved when rows are prepended", () => {
  assert.equal(preserveScrollAfterPrepend(500, 4_000, 5_500), 2_000);
  assert.equal(preserveScrollAfterPrepend(0, 4_000, 4_000), 0);
  assert.equal(preserveScrollAfterPrepend(10, 5_000, 4_000), 10);
});

test("virtual range keeps overscan and clamps at the end", () => {
  assert.deepEqual(virtualRange(0, 500, 50, 1_000, 2), { start: 0, end: 14 });
  assert.deepEqual(virtualRange(10_000, 500, 50, 100, 2), { start: 86, end: 100 });
  assert.deepEqual(virtualRange(0, 500, 0, 100), { start: 0, end: 0 });
});

test("page slices report whether more rows exist", () => {
  const page = pageSlice([1, 2, 3, 4, 5], 2, 2);
  assert.deepEqual(page.items, [3, 4]);
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 5);
  const last = pageSlice([1, 2, 3], 2, 2);
  assert.deepEqual(last.items, [3]);
  assert.equal(last.hasMore, false);
});
