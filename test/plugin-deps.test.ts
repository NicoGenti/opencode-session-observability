import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const SDK_IMPORT =
  /import\s+(?!type\b)[^;]*?from\s+["'](@opencode\/plugin(?:\/[^"']*)?)["']/g;
const SDK_DYNAMIC_IMPORT = /import\(\s*["']@opencode\/plugin(?:\/[^"']*)?["']\s*\)/;
const SDK_REQUIRE = /require\(\s*["']@opencode\/plugin(?:\/[^"']*)?["']\s*\)/;
const TUI_IMPORT =
  /import\s+(?!type\b)[^;]*?from\s+["'](@opentui\/[^"']*)["']/g;
const TUI_DYNAMIC_IMPORT = /import\(\s*["']@opentui\/[^"']*["']\s*\)/;
const TUI_REQUIRE = /require\(\s*["']@opentui\/[^"']*["']\s*\)/;
const CLIENT_IMPORT =
  /import\s+(?!type\b)[^;]*?from\s+["'](@opencode\/client(?:\/[^"']*)?)["']/g;
const CLIENT_DYNAMIC_IMPORT =
  /import\(\s*["']@opencode\/client(?:\/[^"']*)?["']\s*\)/;
const CLIENT_REQUIRE =
  /require\(\s*["']@opencode\/client(?:\/[^"']*)?["']\s*\)/;
const CORE_IMPORT =
  /import\s+(?!type\b)[^;]*?from\s+["'](@opentui\/core(?:\/[^"']*)?)["']/g;
const CORE_DYNAMIC_IMPORT =
  /import\(\s*["']@opentui\/core(?:\/[^"']*)?["']\s*\)/;
const CORE_REQUIRE =
  /require\(\s*["']@opentui\/core(?:\/[^"']*)?["']\s*\)/;

test("plugin sources keep the OpenCode SDK and OpenTUI type-only", async () => {
  const directory = new URL("../src/plugin/", import.meta.url);
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    const source = await readFile(new URL(entry, directory), "utf8");
    for (const match of source.matchAll(SDK_IMPORT)) {
      assert.fail(`${entry} imports ${match[1]} at runtime`);
    }
    assert.doesNotMatch(source, SDK_DYNAMIC_IMPORT, `${entry} dynamically imports the SDK`);
    assert.doesNotMatch(source, SDK_REQUIRE, `${entry} requires the SDK at runtime`);
    for (const match of source.matchAll(TUI_IMPORT)) {
      assert.fail(`${entry} imports ${match[1]} at runtime`);
    }
    assert.doesNotMatch(source, TUI_DYNAMIC_IMPORT, `${entry} dynamically imports OpenTUI`);
    assert.doesNotMatch(source, TUI_REQUIRE, `${entry} requires OpenTUI at runtime`);
  }
});

/**
 * Pin the two packages the Node-loadable entry points must never value-import:
 * `@opencode/client` (the statistics/trajectory state type-only import) and
 * `@opentui/core` (the JSX sidecar's host runtime). The scan stays
 * non-recursive on purpose: the JSX lane under `src/plugin/tui/**`
 * value-imports host-provided `solid-js` and OpenTUI, which is expected.
 */
test("the plugin entry points keep @opencode/client and @opentui/core type-only", async () => {
  const directory = new URL("../src/plugin/", import.meta.url);
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    const source = await readFile(new URL(entry, directory), "utf8");
    for (const match of source.matchAll(CLIENT_IMPORT)) {
      assert.fail(`${entry} imports ${match[1]} at runtime`);
    }
    assert.doesNotMatch(
      source,
      CLIENT_DYNAMIC_IMPORT,
      `${entry} dynamically imports @opencode/client`,
    );
    assert.doesNotMatch(
      source,
      CLIENT_REQUIRE,
      `${entry} requires @opencode/client at runtime`,
    );
    for (const match of source.matchAll(CORE_IMPORT)) {
      assert.fail(`${entry} imports ${match[1]} at runtime`);
    }
    assert.doesNotMatch(
      source,
      CORE_DYNAMIC_IMPORT,
      `${entry} dynamically imports @opentui/core`,
    );
    assert.doesNotMatch(
      source,
      CORE_REQUIRE,
      `${entry} requires @opentui/core at runtime`,
    );
  }
});
