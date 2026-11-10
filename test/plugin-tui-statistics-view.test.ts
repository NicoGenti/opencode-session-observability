import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { bridgeFocus } from "../src/plugin/tui.ts";

/**
 * The view module is JSX-only, so this suite covers its pure contract: the
 * focus normalization shared with the keymap gate, plus the source-level
 * wiring that `node:test` cannot render. JSX smoke stays with typecheck:tui,
 * build:tui and manual host verification.
 */

async function viewSource(): Promise<string> {
  return readFile(
    new URL("../src/plugin/tui/statistics/StatisticsView.tsx", import.meta.url),
    "utf8",
  );
}

test("bridgeFocus trusts only a host-reported boolean", () => {
  assert.equal(bridgeFocus(true), true);
  assert.equal(bridgeFocus(false), false);
  assert.equal(bridgeFocus(undefined), null);
  assert.equal(bridgeFocus(null), null);
  assert.equal(bridgeFocus("false"), null);
  assert.equal(bridgeFocus(0), null);
});

test("StatisticsView mirrors the slot input's focus into the keyboard bridge", async () => {
  const source = await viewSource();

  assert.match(source, /focused=\{input\.focused\}/);
  assert.match(
    source,
    /props\.keyboard\.focused = bridgeFocus\(props\.focused\)/,
  );
  assert.match(source, /props\.keyboard\.focused = null/);
});

test("StatisticsView keeps the documented loading, error and empty states", async () => {
  const source = await viewSource();

  assert.match(source, /Loading…/);
  assert.match(source, /Reopen the panel to retry\./);
  assert.match(source, /No turns for this session\./);
  assert.match(source, /Preparing…/);
});

test("StatisticsView is the panel slot body the host claims by name", async () => {
  const source = await viewSource();

  assert.match(source, /export function statisticsPanelElement\(/);
  assert.match(source, /themePalette\(context\)/);
  assert.match(source, /formatHeader\(props\.layout\.columns\)/);
  assert.match(source, /formatStepRow\(step, props\.layout\.width\)/);
});
