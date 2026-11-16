import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// @ts-expect-error - plain browser module without type declarations
import { REVEAL_COPY_WARNING, digestExportUrl, digestToastMessage } from "../src/ui/digestCopy.js";

const ORIGIN = "http://127.0.0.1:4517";

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

test("digestExportUrl targets the digest export and omits event flags", () => {
  const url = digestExportUrl(ORIGIN, "ses_abc", {});
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/api/sessions/ses_abc/export");
  assert.equal(url.searchParams.get("format"), "digest");
  assert.equal(url.searchParams.get("includeEvents"), null);
  assert.equal(url.searchParams.get("prompt"), null);
  assert.equal(url.searchParams.get("reveal"), null);
});

test("digestExportUrl adds prompt and reveal only when requested", () => {
  const prompt = digestExportUrl(ORIGIN, "ses_abc", { prompt: true });
  assert.equal(prompt.searchParams.get("format"), "digest");
  assert.equal(prompt.searchParams.get("prompt"), "1");
  assert.equal(prompt.searchParams.get("reveal"), null);

  const revealed = digestExportUrl(ORIGIN, "ses_abc", { reveal: true });
  assert.equal(revealed.searchParams.get("prompt"), null);
  assert.equal(revealed.searchParams.get("reveal"), "1");

  const both = digestExportUrl(ORIGIN, "ses_abc", {
    prompt: true,
    reveal: true,
  });
  assert.equal(both.searchParams.get("prompt"), "1");
  assert.equal(both.searchParams.get("reveal"), "1");
});

test("digestExportUrl encodes the session id in the path", () => {
  const url = digestExportUrl(ORIGIN, "ses/../../x y", {});
  assert.equal(
    url.pathname,
    "/api/sessions/ses%2F..%2F..%2Fx%20y/export",
  );
  assert.ok(!url.pathname.includes("/../"));
});

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
