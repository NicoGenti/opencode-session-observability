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
