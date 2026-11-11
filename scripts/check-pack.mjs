import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Exact paths the tarball must contain. The UI assets are shipped as `src/ui`
 * (the compiled server resolves them from the package root) and `dist/` is
 * emitted by the `prepack` build.
 */
const REQUIRED_PRESENT = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/opencode-observability.mjs",
  "src/core/index.ts",
  "src/plugin/index.ts",
  "src/plugin/tui.ts",
  "src/plugin/rpc.ts",
  "src/server/index.ts",
  "src/ui/index.html",
  "src/ui/styles.css",
  "dist/server/index.js",
  "dist/core/index.js",
  "dist/plugin/rpc.js",
  "dist-tui/tui.mjs",
  "opencode.jsonc.example",
  "cli.json.example",
  "docs/ARCHITECTURE.md",
  "docs/CHECKLIST.md",
  "docs/DATA-SOURCES.md",
  "docs/METRICS.md",
  "docs/UI.md",
  "docs/RELEASE.md",
];

const PACKED_UI_MJS = "dist-tui/tui.mjs";

/** Normalizes a packed path to forward slashes without a leading "./". */
function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Forbidden entries, expressed as tests over normalized paths. Each rule
 * returns true when the path must NOT be shipped.
 */
const FORBIDDEN_RULES = [
  { label: "test/", test: (path) => path === "test" || path.startsWith("test/") },
  { label: ".github/", test: (path) => path === ".github" || path.startsWith(".github/") },
  { label: ".npmrc", test: (path) => path === ".npmrc" },
  { label: "tsconfig*.json", test: (path) => /(^|\/)tsconfig[^/]*\.json$/.test(path) },
  { label: "vite.tui.config.ts", test: (path) => path === "vite.tui.config.ts" },
  { label: "DESIGN.md", test: (path) => path === "DESIGN.md" },
  { label: "CONTRIBUTING.md", test: (path) => path === "CONTRIBUTING.md" },
  { label: "package-lock.json", test: (path) => path === "package-lock.json" },
  { label: "node_modules/", test: (path) => path === "node_modules" || path.startsWith("node_modules/") },
  { label: "*.db / *.db-shm / *.db-wal", test: (path) => /\.db(-shm|-wal)?$/.test(path) },
  { label: ".env*", test: (path) => path.split("/").pop().startsWith(".env") },
  { label: "*.log", test: (path) => path.endsWith(".log") },
  { label: "docs/audit/", test: (path) => path === "docs/audit" || path.startsWith("docs/audit/") },
  { label: "docs/*design*", test: (path) => path.startsWith("docs/") && /design/i.test(path.split("/").pop()) },
  { label: ".git / .gitignore", test: (path) => path === ".git" || path.startsWith(".git/") || path === ".gitignore" },
];

function distTuiExtra(path) {
  return path.startsWith("dist-tui/") && path !== PACKED_UI_MJS;
}

/**
 * Pure assertion engine. Returns the violations for a packed-file list; it
 * performs no I/O so the selftest can reuse it on a synthetic list.
 */
function evaluate(packedPaths) {
  const present = new Set(packedPaths);
  const missing = REQUIRED_PRESENT.filter((path) => !present.has(path));
  const forbidden = [];
  for (const path of packedPaths) {
    const rule = FORBIDDEN_RULES.find((candidate) => candidate.test(path));
    if (rule) forbidden.push({ path, label: rule.label });
  }
  const extras = packedPaths.filter(distTuiExtra).map((path) => ({ path }));
  return { missing, forbidden, extras };
}

function report({ missing, forbidden, extras }, write = (line) => process.stderr.write(line)) {
  for (const path of missing) write(`MISSING: ${path}\n`);
  for (const { path, label } of forbidden) {
    write(`FORBIDDEN: ${path} (rule: ${label})\n`);
  }
  for (const { path } of extras) write(`DIST-TUI EXTRA: ${path}\n`);
}

function hasViolations(violations) {
  return violations.missing.length + violations.forbidden.length + violations.extras.length > 0;
}

/** Extracts the packed-file list from `npm pack --dry-run --json` stdout. */
function parsePackOutput(stdout) {
  const text = stdout.trim();
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("npm pack --json produced no JSON array on stdout");
    }
    entries = JSON.parse(text.slice(start, end + 1));
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("npm pack --json produced an empty result");
  }
  const result = entries[entries.length - 1];
  if (!result || !Array.isArray(result.files)) {
    throw new Error("npm pack --json result has no files array");
  }
  return result.files
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter((path) => typeof path === "string" && path.length > 0);
}

function runPack() {
  const npmCli = process.env.npm_execpath;
  const args = ["pack", "--dry-run", "--json"];
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: ROOT, encoding: "utf8" })
    : spawnSync("npm", args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`npm pack --dry-run --json exited with status ${result.status}`);
  }
  return parsePackOutput(result.stdout ?? "").map(normalizePath);
}

function runSelftest() {
  // One missing required entry and one forbidden entry, no file I/O.
  const missingRequired = REQUIRED_PRESENT[0];
  const synthetic = [
    ...REQUIRED_PRESENT.slice(1),
    "test/synthetic-pack-check.test.ts",
  ];
  const violations = evaluate(synthetic);
  report(violations, (line) => process.stdout.write(line));
  const detected =
    violations.missing.length === 1 &&
    violations.missing[0] === missingRequired &&
    violations.forbidden.some(({ path }) => path === "test/synthetic-pack-check.test.ts");
  if (!detected) {
    process.stderr.write("SELFTEST FAILED: the assertion engine did not reject the synthetic list\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `SELFTEST OK: synthetic list rejected (1 missing, ${violations.forbidden.length} forbidden)\n`,
  );
}

function main() {
  if (process.argv.includes("--selftest")) {
    runSelftest();
    return;
  }
  const packed = runPack();
  const violations = evaluate(packed);
  if (hasViolations(violations)) {
    report(violations);
    process.stderr.write(
      `FAILED: ${violations.missing.length} missing, ${violations.forbidden.length} forbidden, ` +
        `${violations.extras.length} dist-tui extras\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `OK: ${packed.length} files packed, ${REQUIRED_PRESENT.length} required paths present, no forbidden entries\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
