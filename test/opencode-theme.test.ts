import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateCliConfigPaths,
  readOpenCodeTheme,
} from "../src/server/opencode-theme.ts";

function withConfig(content: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "opencode-theme-"));
  const path = join(dir, "cli.json");
  try {
    writeFileSync(path, content, "utf8");
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reads the object theme shape used by OpenCode 2", () => {
  withConfig(
    JSON.stringify({ theme: { name: "nightowl", mode: "dark" } }),
    (configPath) => {
      assert.deepEqual(readOpenCodeTheme({ configPath }), {
        name: "nightowl",
        mode: "dark",
      });
    },
  );
});

test("reads the legacy string theme shape", () => {
  withConfig(JSON.stringify({ theme: "tokyonight" }), (configPath) => {
    assert.deepEqual(readOpenCodeTheme({ configPath }), { name: "tokyonight" });
  });
});

test("malformed or missing configs are ignored", () => {
  withConfig("{ not json", (configPath) => {
    assert.equal(readOpenCodeTheme({ configPath }), null);
  });
  assert.equal(
    readOpenCodeTheme({ configPath: join(tmpdir(), "does-not-exist-cli.json") }),
    null,
  );
});

test("candidate paths include the isolated OpenCode 2 profile", () => {
  const paths = candidateCliConfigPaths({
    home: "C:/Users/test",
    platform: "win32",
    env: {},
  });
  assert.ok(
    paths.some((path) =>
      /[\\/]\.opencode2[\\/]config[\\/]opencode[\\/]cli\.json$/i.test(path),
    ),
  );
});
