import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * The three TUI modules migrated from Solid 1's `onMount`/`onCleanup` pair to
 * Solid 2's lifecycle. They are JSX-only, so `node:test` cannot mount them
 * without the host runtime: these source-shape guards are the regression net
 * that stops a future edit from reintroducing the 1.x lifecycle. Neither
 * typecheck lane catches that regression, because the host runtime still
 * declares the old imports.
 */

const VIEWS = [
  "../src/plugin/tui/statistics/StatisticsView.tsx",
  "../src/plugin/tui/trajectory/TrajectoryView.tsx",
] as const;

const BADGE = "../src/plugin/tui/statusBadge.tsx";

const LEGACY_MOUNT = /\bonMount\s*\(/;
const LEGACY_CLEANUP = /\bonCleanup\s*\(/;
const SETTLED = /\bonSettled\s*\(/;

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), "utf8");
}

test("the migrated TUI modules dropped the Solid 1 mount/cleanup pair", async () => {
  for (const file of [...VIEWS, BADGE]) {
    const source = await sourceOf(file);
    assert.doesNotMatch(source, LEGACY_MOUNT, `${file} calls onMount`);
    assert.doesNotMatch(source, LEGACY_CLEANUP, `${file} calls onCleanup`);
  }

  for (const file of VIEWS) {
    const source = await sourceOf(file);
    assert.match(source, SETTLED, `${file} lost its onSettled lifecycle`);
  }

  // The badge has no mount-time lifecycle to settle: its effect re-runs on a
  // session change, so the Solid 2 idiom there is the compute/apply pair.
  assert.match(
    await sourceOf(BADGE),
    /\(\)\s*=>\s*props\.input\.sessionID\b/,
    "statusBadge lost the effect's compute phase",
  );
});

test("statusBadge's effect returns the cleanup that fences stale writes", async () => {
  const source = await sourceOf(BADGE);

  assert.match(
    source,
    /return\s*\(\)\s*=>\s*\{[\s\S]*?active\s*=\s*false;/,
    "statusBadge no longer returns the cleanup that clears `active`",
  );
  // The cleanup only matters because the async write is guarded by the flag.
  assert.match(source, /if\s*\(active\)\s*setLine\(text\)/);
});
