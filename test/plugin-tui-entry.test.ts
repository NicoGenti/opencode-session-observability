import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

type ExportTarget = string | { types?: string; import?: string; default?: string };

type PackageJson = {
  exports?: Record<string, ExportTarget>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type Tsconfig = {
  compilerOptions?: { jsx?: string; jsxImportSource?: string };
  include?: string[];
};

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, import.meta.url), "utf8")) as T;
}

test("the ./tui export points at the prebuilt bundle typed by the ts sidecar", async () => {
  const pkg = await readJson<PackageJson>("../package.json");
  assert.deepEqual(pkg.exports?.["./tui"], {
    types: "./src/plugin/tui.ts",
    import: "./dist-tui/tui.mjs",
  });
});

test("the standalone core and rpc exports resolve the compiled dist targets", async () => {
  const pkg = await readJson<PackageJson>("../package.json");
  assert.deepEqual(pkg.exports?.["./core"], {
    types: "./src/core/index.ts",
    default: "./dist/core/index.js",
  });
  assert.deepEqual(pkg.exports?.["./rpc"], {
    types: "./src/plugin/rpc.ts",
    default: "./dist/plugin/rpc.js",
  });
});

test("OpenTUI and solid-js peers are declared optional", async () => {
  const pkg = await readJson<PackageJson>("../package.json");
  assert.equal(pkg.peerDependenciesMeta?.["@opentui/core"]?.optional, true);
  assert.equal(pkg.peerDependenciesMeta?.["@opentui/solid"]?.optional, true);
  assert.equal(pkg.peerDependenciesMeta?.["solid-js"]?.optional, true);
});

test("tsconfig.tui.json type-checks the sidecar with Solid JSX", async () => {
  const tsconfig = await readJson<Tsconfig>("../tsconfig.tui.json");
  assert.equal(tsconfig.compilerOptions?.jsx, "preserve");
  assert.equal(tsconfig.compilerOptions?.jsxImportSource, "@opentui/solid");
  assert.ok(tsconfig.include?.includes("src/**/*.tsx"));
  assert.ok(tsconfig.include?.includes("src/plugin/tui.ts"));
});
