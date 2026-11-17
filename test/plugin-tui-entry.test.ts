import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

type ExportTarget = string | {
  import?: string;
  types?: string;
  require?: string;
  default?: string;
};

type PackageJson = {
  version?: string;
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
    import: "./dist-tui/tui.mjs",
    types: "./src/plugin/tui.ts",
    require: "./dist-tui/tui.mjs",
    default: "./dist-tui/tui.mjs",
  });
});

test("OpenTUI and solid-js peers are declared optional", async () => {
  const pkg = await readJson<PackageJson>("../package.json");
  assert.equal(pkg.peerDependenciesMeta?.["@opentui/core"]?.optional, true);
  assert.equal(pkg.peerDependenciesMeta?.["@opentui/solid"]?.optional, true);
  assert.equal(pkg.peerDependenciesMeta?.["solid-js"]?.optional, true);
});

test("the CLI version literal stays in sync with the package version", async () => {
  const pkg = await readJson<PackageJson>("../package.json");
  const source = await readFile(
    new URL("../src/server/index.ts", import.meta.url),
    "utf8",
  );
  const declared = /^const VERSION = "([^"]+)";$/m.exec(source);
  assert.ok(declared, "src/server/index.ts declares `const VERSION = \"...\"`");
  assert.equal(declared[1], pkg.version);
});

test("tsconfig.tui.json type-checks the sidecar with Solid JSX", async () => {
  const tsconfig = await readJson<Tsconfig>("../tsconfig.tui.json");
  assert.equal(tsconfig.compilerOptions?.jsx, "preserve");
  assert.equal(tsconfig.compilerOptions?.jsxImportSource, "@opentui/solid");
  assert.ok(tsconfig.include?.includes("src/**/*.tsx"));
  assert.ok(tsconfig.include?.includes("src/plugin/tui.ts"));
});
