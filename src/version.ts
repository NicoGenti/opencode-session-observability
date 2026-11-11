import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walks up from this module to the nearest package.json, so the lookup is
 * correct in both layouts: `src` during development and `dist` after the
 * build (in the checkout or installed from npm).
 */
function findPackageJson(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Could not resolve the package root from ${import.meta.url}`,
      );
    }
    directory = parent;
  }
}

const PACKAGE_JSON = findPackageJson();
const MANIFEST = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
  name?: unknown;
  version?: unknown;
};
if (typeof MANIFEST.name !== "string" || typeof MANIFEST.version !== "string") {
  throw new Error("The package.json resolved for this module is incomplete");
}

/** Repository/package root, one level above the resolved package.json. */
export const PACKAGE_ROOT = dirname(PACKAGE_JSON);

/** The package version, read from the package's own package.json. */
export const PACKAGE_VERSION = MANIFEST.version;

/** Export generator string, composed once from the package identity. */
export const GENERATOR = `${MANIFEST.name}/${MANIFEST.version}`;
