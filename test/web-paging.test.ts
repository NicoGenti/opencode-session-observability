import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_PAGE_LIMIT,
  LEDGER_OVERSCAN,
  mergePages,
  preserveScrollAfterPrepend,
  virtualRange,
} from "../src/web/lib/paging.ts";

interface Row {
  id: string;
  orderKey: string;
}

const row = (id: string, orderKey: string): Row => ({ id, orderKey });
const key = (item: Row): string => item.orderKey;

/* The four behaviours `test/paging.test.ts` pins for the core copy, re-pinned on
   the browser copy so the two modules cannot drift. */

test("web paging: backward pages are prepended, deduplicated and sorted", () => {
  const existing = [row("c", "3"), row("d", "4")];
  const incoming = [row("b", "2"), row("a", "1"), row("c", "3")];
  const merged = mergePages(existing, incoming, "backward", key);
  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(merged.added, 2);
  assert.equal(merged.addedBefore, 2);
  assert.equal(merged.addedAfter, 0);
});

test("web paging: forward pages are appended and deduplicated", () => {
  const existing = [row("a", "1"), row("b", "2")];
  const incoming = [row("b", "2"), row("c", "3")];
  const merged = mergePages(existing, incoming, "forward", key);
  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(merged.added, 1);
  assert.equal(merged.addedAfter, 1);
  assert.equal(merged.addedBefore, 0);
});

test("web paging: an unchanged page adds nothing", () => {
  const existing = [row("a", "1")];
  const merged = mergePages(existing, [row("a", "1")], "backward", key);
  assert.equal(merged.added, 0);
  assert.deepEqual(merged.items, existing);
});

test("web paging: scroll position is preserved when rows are prepended", () => {
  assert.equal(preserveScrollAfterPrepend(500, 4_000, 5_500), 2_000);
  assert.equal(preserveScrollAfterPrepend(0, 4_000, 4_000), 0);
  assert.equal(preserveScrollAfterPrepend(10, 5_000, 4_000), 10);
  // Never negative, even for a hostile pair.
  assert.equal(preserveScrollAfterPrepend(-50, 100, 200), 50);
});

test("web paging: virtual range keeps overscan and clamps at the end", () => {
  assert.deepEqual(virtualRange(0, 500, 50, 1_000, 2), { start: 0, end: 14 });
  assert.deepEqual(virtualRange(10_000, 500, 50, 100, 2), { start: 86, end: 100 });
  assert.deepEqual(virtualRange(0, 500, 0, 100), { start: 0, end: 0 });
  assert.deepEqual(virtualRange(0, 500, 50, 0), { start: 0, end: 0 });
  // The default overscan is the legacy six for the pure helper …
  assert.deepEqual(virtualRange(0, 500, 50, 1_000), { start: 0, end: 22 });
});

test("web paging: the live ledger keeps the legacy constants", () => {
  assert.equal(EVENT_PAGE_LIMIT, 240);
  assert.equal(LEDGER_OVERSCAN, 8);
});
