import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// @ts-expect-error - plain browser module without type declarations
import { REVEAL_COPY_WARNING, digestToastMessage } from "../src/ui/digestCopy.js";

async function appSource(): Promise<string> {
  return readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
}

/** Body of one top-level function, up to the next top-level declaration. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const next = source.indexOf("\nfunction ", start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("REVEAL_COPY_WARNING names the clipboard risk", () => {
  assert.equal(typeof REVEAL_COPY_WARNING.title, "string");
  assert.ok(REVEAL_COPY_WARNING.title.length > 0);
  assert.equal(typeof REVEAL_COPY_WARNING.message, "string");
  assert.match(REVEAL_COPY_WARNING.message, /clipboard/i);
  assert.match(REVEAL_COPY_WARNING.message, /credentials|secrets/i);
  assert.equal(typeof REVEAL_COPY_WARNING.acceptLabel, "string");
  assert.ok(REVEAL_COPY_WARNING.acceptLabel.length > 0);
});

test("digestToastMessage covers the four prompt and reveal combinations", () => {
  const digestRedacted = digestToastMessage(false, false);
  const promptRedacted = digestToastMessage(true, false);
  const digestUnredacted = digestToastMessage(false, true);
  const promptUnredacted = digestToastMessage(true, true);

  assert.equal(
    new Set([digestRedacted, promptRedacted, digestUnredacted, promptUnredacted])
      .size,
    4,
  );
  assert.match(digestRedacted, /session digest/i);
  assert.match(digestRedacted, /redacted/i);
  assert.doesNotMatch(digestRedacted, /unredacted/i);
  assert.match(promptRedacted, /review prompt/i);
  assert.match(promptRedacted, /redacted/i);
  assert.doesNotMatch(promptRedacted, /unredacted/i);
  assert.match(digestUnredacted, /session digest/i);
  assert.match(digestUnredacted, /unredacted/i);
  assert.match(promptUnredacted, /review prompt/i);
  assert.match(promptUnredacted, /unredacted/i);
});

test("the digest copy buttons live only in the Advanced statistics toolbar", async () => {
  const source = await appSource();

  // Basic mode must stay free of both actions.
  const basic = functionBody(source, "function renderStatisticsBasic()");
  assert.ok(!basic.includes('id="copy-review-prompt"'));
  assert.ok(!basic.includes('id="copy-digest"'));

  // In the Advanced renderer both buttons sit after the Basic early return.
  const advanced = functionBody(source, "function renderStatistics()");
  const earlyReturn = advanced.indexOf('if (state.viewMode === "basic")');
  assert.ok(earlyReturn >= 0, "renderStatistics must keep the Basic early return");
  const promptButton = advanced.indexOf('id="copy-review-prompt"');
  const digestButton = advanced.indexOf('id="copy-digest"');
  assert.ok(promptButton > earlyReturn);
  assert.ok(digestButton > earlyReturn);
});

test("the digest copy path reuses the shared export request helper", async () => {
  const source = await appSource();
  const start = source.indexOf("async function copyDigest(");
  const end = source.indexOf("async function toggleReveal(", start);
  assert.ok(start >= 0 && end > start, "copyDigest must stay in app.js");
  const copyDigest = source.slice(start, end);

  // Both the digest copy and the download resolve their target through the same
  // server-list helper, so the digest copy gets the same provenance guarantees
  // (no origin, no document location) and the two paths cannot drift.
  assert.match(copyDigest, /const target = await resolveExportTarget\(\);/);
  assert.match(copyDigest, /exportRequestPath\(target\.id, \{/);
  assert.match(copyDigest, /format: "digest"/);
  assert.doesNotMatch(copyDigest, /exportRequestPath\(state\.sessionID/);
  // The selected id survives only as the early no-op guard.
  assert.equal([...copyDigest.matchAll(/state\.sessionID/g)].length, 1);
  assert.match(copyDigest, /if \(!state\.sessionID\) return;/);
  assert.doesNotMatch(copyDigest, /new URL\(/);
  assert.doesNotMatch(copyDigest, /location\./);

  // The now-unused second URL builder stays deleted: this module owns only the
  // warning and toast copy.
  const digestModule = await readFile(
    new URL("../src/ui/digestCopy.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(digestModule, /digestExportUrl/);
  assert.doesNotMatch(digestModule, /new URL\(/);
});
