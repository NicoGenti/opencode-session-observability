/**
 * The ledger scroll offset that has to survive a view re-mount.
 *
 * The Trajectory view is keyed by `session:dataEpoch` (`App.tsx`), so a reveal
 * toggle and a live heavy pass both unmount the view together with its DOM
 * scroller. The legacy app kept the offset outside the render — `state.scrollTop`
 * (`app.js:172`), written on every scroll (`app.js:1809-1815`) — and put it back
 * after each rebuild (`renderTrajectory`, `app.js:1801-1808`) and, explicitly,
 * after a live refresh (`refreshCurrent`, `app.js:605-638`). This module is that
 * single module-level record in the React tree: it outlives the re-mount the
 * same way the legacy `state` object outlived `innerHTML` rewrites.
 *
 * Only one record is kept, exactly like the legacy scalar: a session switch
 * starts from nothing (the legacy `state.scrollTop = 0`, `app.js:431`) and the
 * next session's first page lands on the newest events as before.
 *
 * Nothing here touches the DOM, so the decisions are pure and testable.
 */

export interface LedgerScrollRecord {
  sessionID: string;
  top: number;
}

let record: LedgerScrollRecord | null = null;

/** Records the current offset, called from the ledger's scroll listener. */
export function rememberLedgerScroll(sessionID: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return;
  record = { sessionID, top };
}

/** Drops the record (tests, and the end of a session's route). */
export function forgetLedgerScroll(): void {
  record = null;
}

/**
 * Drops the record once its reader has taken it. The caller consumes it from a
 * lazy initializer, so this module never mutates during a child render.
 */
export function consumeLedgerScroll(): void {
  record = null;
}

/**
 * The offset a mounting view may restore, or `null` to keep the default
 * "newest page" landing. Pure: it never drops the record.
 *
 * - A record from another session is not this view's to restore.
 * - A `?event=` deep link owns the first paint (`ensureEventLoaded` scrolls the
 *   row into view, `app.js:491-495`), so it wins over any remembered offset.
 */
export function pendingLedgerScroll(
  sessionID: string,
  eventID: string | null,
): number | null {
  if (eventID) return null;
  if (record === null || record.sessionID !== sessionID) return null;
  return record.top;
}

/**
 * Whether the row that sat at the viewport anchor moved. Rows are keyed by
 * stable ids, so comparing the key at the anchor index (rather than the index
 * of a changed row) restores the legacy prepend compensation at the top of the
 * loaded window (`anchor === 0`) and for an insert at the anchor, while an
 * appended page and a measurement-only commit leave the anchor key in place.
 * A first page has no previous row at the anchor, so it never compensates.
 */
export function changedAboveAnchor(
  previous: readonly string[],
  next: readonly string[],
  anchor: number,
): boolean {
  const previousAnchor = previous[anchor];
  if (previousAnchor === undefined) return false;
  return next[anchor] !== previousAnchor;
}

/**
 * Clamps a remembered offset to the canvas the first page actually produced.
 * The legacy assignment relied on the browser's own clamp; the virtualizer's
 * total is an estimate until rows are measured, so the bound is applied here.
 */
export function clampScrollTop(
  top: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  const limit = Math.max(0, scrollHeight - Math.max(0, viewportHeight));
  return Math.min(Math.max(0, top), limit);
}
