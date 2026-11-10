import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

type PackageJson = {
  exports?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type Tsconfig = {
  compilerOptions?: { jsx?: string; jsxImportSource?: string };
  include?: string[];
};

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, import.meta.url), "utf8")) as T;
}

test("the ./tui export points at the typed tsx sidecar", async () => {
  const pkg = await readJson<PackageJson>("../package.json");
  assert.equal(pkg.exports?.["./tui"], "./src/plugin/tui.tsx");
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
