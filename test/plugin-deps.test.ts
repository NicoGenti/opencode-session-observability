import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const SDK_IMPORT =
  /import\s+(?!type\b)[^;]*?from\s+["'](@opencode\/plugin(?:\/[^"']*)?)["']/g;
const SDK_DYNAMIC_IMPORT = /import\(\s*["']@opencode\/plugin(?:\/[^"']*)?["']\s*\)/;
const SDK_REQUIRE = /require\(\s*["']@opencode\/plugin(?:\/[^"']*)?["']\s*\)/;

test("plugin sources keep the OpenCode SDK type-only", async () => {
  const directory = new URL("../src/plugin/", import.meta.url);
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".ts")) continue;
    const source = await readFile(new URL(entry, directory), "utf8");
    for (const match of source.matchAll(SDK_IMPORT)) {
      assert.fail(`${entry} imports ${match[1]} at runtime`);
    }
    assert.doesNotMatch(source, SDK_DYNAMIC_IMPORT, `${entry} dynamically imports the SDK`);
    assert.doesNotMatch(source, SDK_REQUIRE, `${entry} requires the SDK at runtime`);
  }
});
