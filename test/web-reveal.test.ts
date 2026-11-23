import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createApiClient, requestTarget } from "../src/web/lib/api.ts";
import { REVEAL_BANNER, REVEAL_CONFIRM, TOAST } from "../src/web/lib/export.ts";

interface Call {
  url: string;
  init?: RequestInit;
}

function client(options: {
  revealAllowed: boolean;
  reveal: boolean;
}): { api: ReturnType<typeof createApiClient>; calls: Call[] } {
  const calls: Call[] = [];
  const api = createApiClient({
    fetch: async (input, init) => {
      calls.push({ url: input, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    token: () => "tok",
    revealAllowed: () => options.revealAllowed,
    reveal: () => options.reveal,
    requestToken: async () => null,
  });
  return { api, calls };
}

test("reveal=1 is added only while reveal is allowed and on", async () => {
  const off = client({ revealAllowed: true, reveal: false });
  await off.api("/api/sessions/ses_1/analysis");
  assert.equal(off.calls[0]?.url, "/api/sessions/ses_1/analysis");
  assert.deepEqual(off.calls[0]?.init?.headers, {
    Accept: "application/json",
    Authorization: "Bearer tok",
  });

  const on = client({ revealAllowed: true, reveal: true });
  await on.api("/api/sessions/ses_1/analysis", { fromSeq: 1 });
  assert.equal(on.calls[0]?.url, "/api/sessions/ses_1/analysis?fromSeq=1&reveal=1");

  // The server refused reveal for this launch: the flag alone is not enough.
  const forbidden = client({ revealAllowed: false, reveal: true });
  await forbidden.api("/api/sessions/ses_1/events", { kind: "tool" });
  assert.equal(forbidden.calls[0]?.url, "/api/sessions/ses_1/events?kind=tool");

  // A call may opt out (downloads), and the reveal state follows the ref the
  // caller reads, so flipping it takes effect on the very next request.
  const state = { revealAllowed: true, reveal: true };
  const live = client(state);
  await live.api("/api/sessions/ses_1/analysis", {}, { noReveal: true });
  assert.equal(live.calls[0]?.url, "/api/sessions/ses_1/analysis");
  state.reveal = false;
  await live.api("/api/sessions/ses_1/analysis");
  assert.equal(live.calls[1]?.url, "/api/sessions/ses_1/analysis");
});

test("the reveal parameter appends to a path that already has a query", () => {
  assert.equal(
    requestTarget("/api/sessions/ses_1/export?format=json", {}, { reveal: true }),
    "/api/sessions/ses_1/export?format=json&reveal=1",
  );
  assert.equal(
    requestTarget("/api/sessions/ses_1/export?format=json", {}, { reveal: false }),
    "/api/sessions/ses_1/export?format=json",
  );
});

test("the reveal copy is the documented copy", () => {
  assert.equal(REVEAL_CONFIRM.title, "Reveal raw payloads?");
  assert.equal(
    REVEAL_CONFIRM.message,
    "API keys, tokens and credentials may appear on screen and in exports. Turn reveal off when you are finished.",
  );
  assert.equal(REVEAL_CONFIRM.acceptLabel, "Reveal secrets");
  assert.equal(REVEAL_BANNER, "Secrets are visible. Do not share this screen or its exports.");
  assert.equal(TOAST.revealDisabled, "Reveal is disabled by the server (start it with --reveal).");
});

/* ------------------------------------------------------- wiring contract */

async function source(relative: string): Promise<string> {
  return readFile(new URL(`../src/web/${relative}`, import.meta.url), "utf8");
}

test("turning reveal on asks for confirmation before the first re-request", async () => {
  const reveal = await source("hooks/useReveal.ts");
  const confirmAt = reveal.indexOf("await confirm.request(");
  const flipAt = reveal.indexOf("reveal: !stateRef.current.reveal");
  assert.ok(confirmAt >= 0, "the confirmation is requested");
  assert.ok(flipAt > confirmAt, "the flag flips only after the confirmation resolves");
  assert.match(reveal, /REVEAL_CONFIRM/);
  // A refused reveal resets both flags and tells the user why.
  assert.match(reveal, /write\(\{ allowed: false, reveal: false \}\)/);
  assert.match(reveal, /TOAST\.revealDisabled/);
  // The confirmation is inside the on-branch only: turning it off asks nothing.
  const onBranch = reveal.indexOf("if (!stateRef.current.reveal)");
  assert.ok(onBranch >= 0 && onBranch < confirmAt, "the confirmation sits in the on-branch");
  assert.equal((reveal.match(/confirm\.request\(/g) ?? []).length, 1);
  assert.match(reveal, /changedRef\.current\(\)/);
});

test("the app wires reveal into the api client and the banner", async () => {
  const app = await source("App.tsx");
  assert.match(app, /revealAllowed: \(\) => revealRef\.current\.allowed/);
  assert.match(app, /reveal: \(\) => revealRef\.current\.reveal/);
  assert.match(app, /<RevealBanner reveal=\{reveal\.reveal\} \/>/);
  // One shared sink recovers from `reveal_disabled` on every request, and one
  // payload sink keeps the allowed flag live.
  assert.match(app, /error\.code === "reveal_disabled"/);
  assert.match(app, /revealSink\.current\?\.forbid\(\)/);
  assert.match(app, /onError: handleRequestError/);
  assert.match(app, /onRevealAllowed:/);
  // Exports read the live reveal value at click time.
  assert.match(app, /reveal: \(\) => revealRef\.current\.reveal/);
});

test("a not-allowed payload disarms reveal through the forbid path", async () => {
  const reveal = await source("hooks/useReveal.ts");
  // `revealAllowed:false` is the same recovery as a refused request: the false
  // branch delegates to `forbid()`, so both flags go off and the exact same
  // `changedRef` re-request runs. `write` stays in one place, so the payload
  // path cannot fork the recovery.
  assert.match(
    reveal,
    /const syncAllowed = useCallback\([\s\S]*?if \(!allowed\) \{\s*forbid\(\);\s*return;\s*\}/,
  );
  assert.equal(
    (reveal.match(/write\(\{ allowed: false, reveal: false \}\)/g) ?? []).length,
    1,
  );
  // `true` only enables the toggle; it never turns reveal on by itself.
  const sync = reveal.slice(reveal.indexOf("const syncAllowed"));
  const body = sync.slice(0, sync.indexOf("const toggle"));
  assert.match(body, /write\(\{ \.\.\.stateRef\.current, allowed \}\)/);
  assert.doesNotMatch(body, /reveal: true/);

  // The boot health probe is the second payload entry point and must not fork the
  // policy: `revealAllowed:false` while reveal is on is exactly one
  // `{allowed:false, reveal:false}` write plus the one `changedRef` re-request
  // (both inherited from `forbid`), and `true` with reveal off never enables it.
  const probe = reveal.slice(reveal.indexOf('"/api/health"'), reveal.indexOf("const toggle"));
  assert.match(probe, /syncAllowed\(data\.revealAllowed\)/);
  assert.doesNotMatch(probe, /write\(/);
  assert.doesNotMatch(probe, /changedRef\.current\(\)/);
  assert.doesNotMatch(probe, /allowed: data\.revealAllowed/);
  assert.equal((reveal.match(/const syncAllowed = useCallback\(/g) ?? []).length, 1);
  assert.equal(
    (reveal.match(/if \(!allowed\) \{\s*forbid\(\);\s*return;\s*\}/g) ?? []).length,
    1,
  );
  assert.match(reveal, /write\(\{ allowed: false, reveal: false \}\);\s*changedRef\.current\(\);/);
});

test("the reveal health probe is no-reveal and feeds the boot theme sync", async () => {
  const reveal = await source("hooks/useReveal.ts");
  assert.match(reveal, /"\/api\/health", \{\}, \{ noReveal: true \}/);
  assert.match(reveal, /onServerTheme/);
  assert.match(reveal, /theme\?\.name/);
});

test("the topbar reveal toggle reflects the policy and the state in text", async () => {
  const topbar = await source("components/Topbar.tsx");
  assert.match(topbar, /aria-pressed=\{reveal\}/);
  assert.match(topbar, /disabled=\{!revealAllowed\}/);
  assert.match(topbar, /reveal \? "Hide secrets" : "Reveal secrets"/);
  assert.match(topbar, /"Reveal is disabled by the server"/);
  // The banner body is ink, never warning-coloured text.
  const banner = await source("components/RevealBanner.tsx");
  assert.match(banner, /text-\[12px\] text-text/);
  assert.doesNotMatch(banner, /text-warning/);
});
