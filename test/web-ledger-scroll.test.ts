import test from "node:test";
import assert from "node:assert/strict";
import {
  changedAboveAnchor,
  clampScrollTop,
  consumeLedgerScroll,
  forgetLedgerScroll,
  pendingLedgerScroll,
  rememberLedgerScroll,
} from "../src/web/lib/ledger-scroll.ts";

/* The legacy ledger kept `state.scrollTop` outside the render and put it back
   after every rebuild (`app.js:172,1801-1808,638`). These pin the reduced
   React model: one record, restored across a re-mount, dropped on a session
   switch, and never in the way of an `?event=` deep link. */

test("ledger scroll: the reader is pure and the caller consumes once", () => {
  forgetLedgerScroll();
  assert.equal(pendingLedgerScroll("ses_1", null), null);

  rememberLedgerScroll("ses_1", 512);
  // Pure: repeated reads during render return the same offset.
  assert.equal(pendingLedgerScroll("ses_1", null), 512);
  assert.equal(pendingLedgerScroll("ses_1", null), 512);

  consumeLedgerScroll();
  assert.equal(pendingLedgerScroll("ses_1", null), null);

  rememberLedgerScroll("ses_1", 0);
  assert.equal(pendingLedgerScroll("ses_1", null), 0);
});

test("ledger scroll: a different session does not hand out the stale record", () => {
  forgetLedgerScroll();
  rememberLedgerScroll("ses_1", 900);

  // A session switch starts from the newest page, like `state.scrollTop = 0`;
  // the caller then consumes the stale record so it cannot resurrect.
  assert.equal(pendingLedgerScroll("ses_2", null), null);
  assert.equal(pendingLedgerScroll("ses_1", null), 900);
  consumeLedgerScroll();
  assert.equal(pendingLedgerScroll("ses_1", null), null);
});

test("ledger scroll: a deep link wins and leaves nothing to restore", () => {
  forgetLedgerScroll();
  rememberLedgerScroll("ses_1", 640);

  assert.equal(pendingLedgerScroll("ses_1", "evt_42"), null);
  // `ensureEventLoaded` owns the position; the caller consumes it here.
  consumeLedgerScroll();
  assert.equal(pendingLedgerScroll("ses_1", null), null);
});

test("ledger scroll: non-finite or negative offsets are ignored", () => {
  forgetLedgerScroll();
  rememberLedgerScroll("ses_1", 300);

  rememberLedgerScroll("ses_1", Number.NaN);
  rememberLedgerScroll("ses_1", -20);
  assert.equal(pendingLedgerScroll("ses_1", null), 300);
});

test("ledger scroll: only changes above the viewport anchor need compensation", () => {
  const base = ["event:a", "event:b", "event:c"];
  // A prepended page shifts every key; the anchor sits at b or later.
  assert.equal(
    changedAboveAnchor(base, ["event:0", ...base], 1),
    true,
  );
  // An appended page and a measurement-only commit leave the anchor alone.
  assert.equal(changedAboveAnchor(base, [...base, "event:d"], 1), false);
  assert.deepEqual(base, ["event:a", "event:b", "event:c"]);
  // A header inserted below the first visible row does not move the view.
  assert.equal(
    changedAboveAnchor(base, ["event:a", "event:b", "step:s", "event:c"], 1),
    false,
  );
  // The same insert above it does.
  assert.equal(
    changedAboveAnchor(base, ["step:s", "event:a", "event:b", "event:c"], 1),
    true,
  );
  assert.equal(changedAboveAnchor([], ["event:a"], 0), false);
});

test("ledger scroll: the anchor key (not an index) decides compensation", () => {
  const base = ["event:a", "event:b", "event:c"];
  // A prepend while the reader is within the first overscan rows: `anchor` is
  // 0, so the row that used to be at 0 now sits below the fold. The old index
  // comparison missed this; the key comparison restores the legacy behaviour.
  assert.equal(changedAboveAnchor(base, ["event:0", ...base], 0), true);
  // A header inserted exactly at the anchor moves its key at any depth.
  assert.equal(changedAboveAnchor(base, ["step:s", ...base], 0), true);
  assert.equal(
    changedAboveAnchor(base, [base[0]!, "step:s", ...base.slice(1)], 1),
    true,
  );
  // Append-only growth never compensates, even at the last row.
  assert.equal(changedAboveAnchor(base, [...base, "event:d"], 0), false);
  assert.equal(changedAboveAnchor(base, [...base, "event:d"], 2), false);
  // A re-measurement keeps every key in place.
  assert.equal(changedAboveAnchor(base, [...base], 1), false);
  // Duplicate-free keys are the invariant; an empty previous row set has no
  // anchor row to have moved.
  assert.equal(changedAboveAnchor([], ["event:a"], 0), false);
});

test("ledger scroll: a deep-link restore survives an appended page", () => {
  // `?event=` opens on one event; the first commit has no previous anchor row,
  // and the page that follows appends below it, so the restored position is
  // never treated as a prepend.
  assert.equal(changedAboveAnchor([], ["event:42"], 0), false);
  assert.equal(
    changedAboveAnchor(["event:42"], ["event:42", "event:43"], 0),
    false,
  );
});

test("ledger scroll: the restore clamps to the produced canvas", () => {
  // Within the scrollable range.
  assert.equal(clampScrollTop(400, 2_000, 500), 400);
  // Past the end: the last full viewport, never a blank overscroll.
  assert.equal(clampScrollTop(9_999, 2_000, 500), 1_500);
  // Nothing scrollable yet: the top.
  assert.equal(clampScrollTop(120, 300, 500), 0);
  assert.equal(clampScrollTop(120, 0, 500), 0);
  // Hostile inputs never produce a negative offset.
  assert.equal(clampScrollTop(-10, 2_000, 500), 0);
  assert.equal(clampScrollTop(100, 2_000, -5), 100);
});
