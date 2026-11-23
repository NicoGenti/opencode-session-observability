import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The review-fix wiring contract. These behaviours live in React components and
 * hooks, so they are pinned at the source level: the pure halves they call are
 * covered by the focused suites (`web-api`, `web-theme`, `web-shell`,
 * `web-ledger-scroll`, `web-markdown`).
 */

async function source(relative: string): Promise<string> {
  return readFile(new URL(`../src/web/${relative}`, import.meta.url), "utf8");
}

test("P1-2: Refresh reloads the list and forces exactly the next analysis", async () => {
  const app = await source("App.tsx");
  // One mechanism: an epoch bump plus a one-shot force flag.
  assert.match(app, /const forcePending = useRef\(false\)/);
  assert.match(app, /setDataEpoch\(\(epoch\) => epoch \+ 1\)/);
  assert.match(
    app,
    /manualRefresh[\s\S]*?forcePending\.current =[\s\S]*?sessionsReload\(\);[\s\S]*?bumpData\(\)/,
  );
  assert.match(app, /onRefresh=\{manualRefresh\}/);
  assert.match(app, /forceRefresh=\{forcePending\.current\}/);
  assert.match(app, /onForceConsumed=\{consumeForce\}/);
  // NEW-P2-2: a new session-data load starts from a clean banner, the legacy
  // `clearError()` at the top of the load (`app.js:458`); it is not sticky.
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*setNotice\(null\);\s*\}, \[route\.sessionID, dataEpoch\]\)/,
  );

  const trajectory = await source("components/TrajectoryView.tsx");
  assert.match(trajectory, /refresh: forceRefresh/);
  const statistics = await source("components/StatisticsView.tsx");
  assert.match(statistics, /refresh: forceRefresh/);
  const events = await source("hooks/useEvents.ts");
  assert.match(events, /withRefresh\(paramsRef\.current, force\)/);
  // `reload` is gone: the epoch is the single re-request mechanism.
  assert.doesNotMatch(events, /const reload = useCallback/);
});

test("P2-2/P2-3: the poller pauses on session data and the heavy pass reloads the list", async () => {
  const app = await source("App.tsx");
  assert.match(app, /paused: dataLoading \|\| sessions\.status === "loading"/);
  assert.match(app, /heavyRefresh[\s\S]*?sessionsReload\(\);[\s\S]*?bumpData\(\)/);
  assert.match(app, /onHeavyRefresh: heavyRefresh/);

  const view = await source("components/TrajectoryView.tsx");
  assert.match(view, /analysis\.status === "loading" \|\| events\.status === "loading"/);
  const stats = await source("components/StatisticsView.tsx");
  assert.match(stats, /onDataLoading\?\.\(analysis\.status === "loading"\)/);
});

test("P1-3: the health payload feeds the theme provider without a user override", async () => {
  const provider = await source("providers/ThemeProvider.tsx");
  assert.match(provider, /selectServerTheme\(name, current\)/);
  assert.match(provider, /previous\.themeUserSet \|\| previous\.linkedTheme/);
  assert.match(provider, /applyServerTheme/);
  const app = await source("App.tsx");
  assert.match(app, /onServerTheme: theme\.applyServerTheme/);
});

test("P2-1: a deep link clears filters before the around load", async () => {
  const view = await source("components/TrajectoryView.tsx");
  const clear = view.indexOf("if (override) onFiltersChange(override);");
  const load = view.indexOf("await events.loadAround(eventID, override)");
  assert.ok(clear >= 0 && load > clear, "filters clear before the around request");
  assert.doesNotMatch(view, /if \(!found\) return;\s*if \(override\) onFiltersChange/);
});

test("P2-4: every programmatic dialog restores its opener", async () => {
  for (const file of [
    "components/SettingsDialog.tsx",
    "components/ShortcutsDialog.tsx",
    "components/ConfirmDialog.tsx",
  ]) {
    const dialog = await source(file);
    assert.match(dialog, /activeElement/, file);
    assert.match(dialog, /onCloseAutoFocus=/, file);
    // A detached opener (its row was re-rendered away) is skipped, like the
    // drawer path in TrajectoryView.
    assert.match(
      dialog,
      /const target = opener\.current;\s*opener\.current = null;\s*if \(target\?\.isConnected\) target\.focus\(\);/,
      file,
    );
    assert.doesNotMatch(dialog, /opener\.current\?\.focus\(\)/, file);
  }
});

test("P2-5/P2-20: guardrails disclosure persists and keeps its live region", async () => {
  const provider = await source("providers/SettingsProvider.tsx");
  assert.match(provider, /get\("guardrailsExpanded"\) === true \|\| get\("guardrailsCollapsed"\) === false/);
  assert.match(provider, /set\("guardrailsExpanded", value\);\s*set\("guardrailsCollapsed", !value\)/);
  assert.match(provider, /guardrailsExpanded: value,\s*guardrailsCollapsed: !value/);
  const section = await source("components/GuardrailsSection.tsx");
  assert.match(section, /role="status"/);
  assert.match(section, /aria-live="polite"/);
  assert.match(section, /useState\(settings\.guardrailsExpanded\)/);
  assert.match(section, /setGuardrailsExpanded\(expanded\)/);
});

test("P2-11: a settings reset clears the in-memory disclosure sets", async () => {
  const sessions = await source("hooks/useSessions.ts");
  assert.match(sessions, /onSettingsReset\(/);
  assert.match(sessions, /projectsRef\.current = new Set\(\)/);
  assert.match(sessions, /parentsRef\.current = new Set\(\)/);
  assert.match(sessions, /setExpandedProjects\(new Set\(\)\)/);
  assert.match(sessions, /setExpandedParents\(new Set\(\)\)/);
});

test("P2-12/P1-5: ledger scroll is pure and the ledger owns the anchor", async () => {
  const scroll = await source("lib/ledger-scroll.ts");
  assert.match(scroll, /export function changedAboveAnchor/);
  assert.match(scroll, /export function consumeLedgerScroll/);
  // `pendingLedgerScroll` no longer writes the module record.
  const pending = scroll.slice(scroll.indexOf("export function pendingLedgerScroll"));
  assert.doesNotMatch(pending.slice(0, pending.indexOf("}")), /record = null/);

  const hook = await source("hooks/useVirtualLedger.ts");
  assert.match(hook, /shouldAdjustScrollPositionOnItemSizeChange = \(\) => false/);
  // The cleanup restores the predicate it captured, not `undefined`.
  assert.match(
    hook,
    /const previous = virtualizer\.shouldAdjustScrollPositionOnItemSizeChange;[\s\S]*?shouldAdjustScrollPositionOnItemSizeChange = previous;/,
  );
  assert.doesNotMatch(
    hook,
    /shouldAdjustScrollPositionOnItemSizeChange = undefined/,
  );
  const ledger = await source("components/Ledger.tsx");
  assert.match(ledger, /changedAboveAnchor\(seen\.current\.keys, keys, anchor\)/);
  assert.match(ledger, /virtualizer\.range\?\.startIndex/);
  assert.doesNotMatch(ledger, /total > seen\.current\.total/);
});

test("P2-13/P2-14: reset landing is laid out before paint and a failure disarms it", async () => {
  const view = await source("components/TrajectoryView.tsx");
  assert.match(view, /useLayoutEffect\(\(\) => \{\s*if \(events\.revision === lastRevision\.current\)/);
  assert.match(view, /if \(events\.status === "error"\) jumpBottom\.current = false/);
});

test("P2-15: a manual compare session change does not auto-select an episode", async () => {
  const compare = await source("components/CompareModal.tsx");
  assert.match(compare, /loadSide\(side, nextSessionID, false\)/);
});

test("P2-19: the event row has no aria-label duplicating visible text", async () => {
  const row = await source("components/LedgerRow.tsx");
  assert.doesNotMatch(row, /aria-label=\{ledgerRowLabel/);
  assert.doesNotMatch(row, /ledgerRowLabel/);
});

test("P2-21: the raw sidebar search text is sent", async () => {
  const sessions = await source("hooks/useSessions.ts");
  assert.match(sessions, /\{ q: nextQuery \|\| undefined, limit: SESSION_LIMIT \}/);
  assert.doesNotMatch(sessions, /q: nextQuery\.trim\(\)/);
});

test("P2-18: the dead placeholder rule is gone", async () => {
  const css = await source("styles.css");
  assert.doesNotMatch(css, /\.placeholder/);
});

test("SEC-L1: every inner-HTML sink is fed by renderMarkdown", async () => {
  const root = fileURLToPath(new URL("../src/web/", import.meta.url));
  const files: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), `${relative}/`);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(relative);
      }
    }
  }
  await walk(root, "");

  const sinks: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8");
    text.split("\n").forEach((line, index) => {
      if (line.includes("dangerouslySetInnerHTML")) {
        sinks.push({ file, line: index + 1, text: line.trim() });
      }
    });
  }

  // No other component may carry the token; the invariant names exactly two.
  assert.ok(sinks.length > 0, "the sink scan found nothing");
  for (const sink of sinks) {
    assert.ok(
      sink.file === "components/EventDrawer.tsx" ||
        sink.file === "components/StatsTable.tsx",
      `${sink.file}:${sink.line} carries an inner-HTML sink`,
    );
  }

  // The actual JSX sinks are three, and their props are rendered Markdown.
  const attributes = sinks.filter((sink) =>
    /dangerouslySetInnerHTML=/.test(sink.text),
  );
  assert.equal(attributes.length, 3);
  const stats = await source("components/StatsTable.tsx");
  assert.match(
    stats,
    /const detail = buildStepDetail\(row\.turn, row\.step, responseLimit\)/,
  );
  assert.match(stats, /dangerouslySetInnerHTML=\{\{ __html: detail\.html \}\}/);
  assert.match(
    stats,
    /dangerouslySetInnerHTML=\{\{ __html: detail\.reasoningHtml \}\}/,
  );
  const statistics = await source("lib/statistics.ts");
  assert.match(statistics, /const response = renderMarkdown\(/);
  assert.match(statistics, /renderMarkdown\(step\.reasoningText, \{/);
  const drawer = await source("components/EventDrawer.tsx");
  assert.match(
    drawer,
    /dangerouslySetInnerHTML=\{\{ __html: markdown\.html \}\}/,
  );
});

test("P2-9/P2-10/P2-7: pack and CI gates pin the artifact", async () => {
  const pack = await readFile(
    new URL("../scripts/check-pack.mjs", import.meta.url),
    "utf8",
  );
  assert.match(pack, /~627 KB/);
  assert.match(pack, /uiIndexAssets/);
  assert.match(pack, /index references a missing packed asset/);
  const ci = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(ci, /git ls-files --others --exclude-standard -- dist-ui\//);
  assert.match(ci, /npm run pack:check/);
});
