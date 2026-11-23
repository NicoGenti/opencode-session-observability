// Packaged-artifact integrity gate for `npm pack`.
//
// Runs `npm pack --dry-run --json` (no tarball is written and no lifecycle
// script runs) and asserts what a consumer would actually install: the files
// that must be present, the paths that must never leak into the tarball, the
// bin shebang and the packed-size budget.
//
// Zero runtime dependencies: Node built-ins only. Exits 1 on any violation.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const BIN_ENTRY = "bin/opencode-observability.mjs";
const BIN_SHEBANG = "#!/usr/bin/env node";

// Hard fail above 2 MB packed, warn above 750 KB (observed baseline ~627 KB).
const PACKED_SIZE_LIMIT = 2 * 1024 * 1024;
const PACKED_SIZE_WARN = 750 * 1024;

const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/opencode-observability.mjs",
  "src/plugin/index.ts",
  "src/plugin/tui.ts",
  "src/plugin/rpc.ts",
  "src/core/index.ts",
  "src/server/index.ts",
  "dist-tui/tui.mjs",
  "dist-server/server.mjs",
  "dist-ui/index.html",
  "docs/ARCHITECTURE.md",
  "docs/CHECKLIST.md",
  "docs/DATA-SOURCES.md",
  "docs/HEALTH.md",
  "docs/METRICS.md",
  "docs/UI.md",
  "opencode.jsonc.example",
  "cli.json.example",
];

const ABSENT_DIRECTORIES = [
  "test/",
  ".github/",
  ".context/",
  "plan/",
  ".opencode/",
  ".code-review-graph/",
  "node_modules/",
  "docs/audit/",
  "docs/screenshots/",
  "src/web/",
];

const ABSENT_FILES = [
  ".npmrc",
  "tsconfig.json",
  "tsconfig.tui.json",
  "tsconfig.ui.json",
  "vite.tui.config.ts",
  "vite.server.config.ts",
  "vite.ui.config.ts",
  "DESIGN.md",
  "CONTRIBUTING.md",
  "package-lock.json",
  "docs/audit-dashboard-avoid-ai-design.md",
];

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

const ABSENT_PATTERNS = [
  ["*.db", (path) => path.endsWith(".db")],
  ["*.db-journal", (path) => path.endsWith(".db-journal")],
  ["*.db-wal", (path) => path.endsWith(".db-wal")],
  [".env*", (path) => baseName(path).startsWith(".env")],
  ["*.log", (path) => path.endsWith(".log")],
  [".git*", (path) => !path.includes("/") && path.startsWith(".git")],
];

// Hashed assets the committed UI build must carry: one JS entry chunk and one
// CSS chunk. Exact filenames are content-hashed, so the rule counts matches.
const REQUIRED_PATTERNS = [
  ["dist-ui/assets/*.js", /^dist-ui\/assets\/[^/]+\.js$/u],
  ["dist-ui/assets/*.css", /^dist-ui\/assets\/[^/]+\.css$/u],
];

const UI_INDEX = "dist-ui/index.html";

// Every `/ui/assets/...` the committed index references must be a packed file:
// a stale index pointing at a dropped chunk would install a broken UI.
function uiIndexAssets() {
  let text;
  try {
    text = readFileSync(join(repoRoot, UI_INDEX), "utf8");
  } catch {
    return null;
  }
  const assets = new Set();
  for (const match of text.matchAll(/\/ui\/(assets\/[^"'?#\s>]+)/gu)) {
    assets.add(`dist-ui/${match[1]}`);
  }
  return [...assets];
}

const ABSENT_RULES = [
  ...ABSENT_DIRECTORIES.map((directory) => ({
    label: directory,
    matches: (path) => path.startsWith(directory),
  })),
  ...ABSENT_FILES.map((file) => ({
    label: file,
    matches: (path) => path === file,
  })),
  ...ABSENT_PATTERNS.map(([label, matches]) => ({ label, matches })),
];

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

function parsePackJson(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") throw new Error("`npm pack --dry-run --json` produced no output");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Defensive: tolerate a non-JSON preamble by slicing the outermost array.
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) {
      throw new Error(
        `could not parse \`npm pack --dry-run --json\` output: ${text.slice(0, 200)}`,
      );
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }

  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (record === null || typeof record !== "object") {
    throw new Error(
      "unexpected `npm pack --dry-run --json` shape: expected an object or a one-object array",
    );
  }

  const files = Array.isArray(record.files) ? record.files : [];
  const paths = files
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter((path) => typeof path === "string" && path !== "");
  if (paths.length === 0) throw new Error("`npm pack --dry-run --json` reported no files");

  const summedSize = files.reduce(
    (total, entry) => total + (typeof entry?.size === "number" ? entry.size : 0),
    0,
  );
  const packedSize = typeof record.size === "number" ? record.size : summedSize;
  const packedSizeEstimated = typeof record.size !== "number";
  const unpackedSize = typeof record.unpackedSize === "number" ? record.unpackedSize : summedSize;
  const entryCount = typeof record.entryCount === "number" ? record.entryCount : paths.length;

  return {
    name: typeof record.name === "string" ? record.name : "(unknown)",
    version: typeof record.version === "string" ? record.version : "(unknown)",
    filename: typeof record.filename === "string" ? record.filename : "(unknown)",
    paths,
    entryCount,
    packedSize,
    packedSizeEstimated,
    unpackedSize,
  };
}

function readPackDryRun() {
  const command = "npm pack --dry-run --json";
  let raw;
  try {
    raw = execSync(command, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    if (stdout === "") {
      const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
      throw new Error(
        `\`${command}\` failed: ${stderr !== "" ? stderr : (error?.message ?? String(error))}`,
      );
    }
    raw = stdout;
  }
  return parsePackJson(raw);
}

function checkShebang() {
  const absolute = join(repoRoot, BIN_ENTRY);
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    return { ok: false, detail: `cannot read ${BIN_ENTRY}` };
  }

  const firstLine = text.split(/\r?\n/u, 1)[0];
  if (firstLine !== BIN_SHEBANG) {
    return {
      ok: false,
      detail: `first line is ${JSON.stringify(firstLine)}, expected ${JSON.stringify(BIN_SHEBANG)}`,
    };
  }
  return { ok: true, detail: `shebang is ${JSON.stringify(BIN_SHEBANG)}` };
}

function main() {
  const pack = readPackDryRun();
  const present = new Set(pack.paths);
  const problems = [];
  const warnings = [];
  const lines = [];

  lines.push(`check-pack: ${pack.name}@${pack.version}`);
  lines.push(`  tarball  ${pack.filename}`);
  lines.push(`  entries  ${pack.entryCount}`);
  lines.push(
    `  packed   ${formatBytes(pack.packedSize)}${pack.packedSizeEstimated ? " (estimated from entry sizes)" : ""}`,
  );
  lines.push(`  unpacked ${formatBytes(pack.unpackedSize)}`);

  lines.push("");
  lines.push(`required present (${REQUIRED_FILES.length})`);
  for (const required of REQUIRED_FILES) {
    const ok = present.has(required);
    if (!ok) problems.push(`missing required file: ${required}`);
    lines.push(`  ${ok ? "ok  " : "FAIL"} ${required}`);
  }

  lines.push("");
  lines.push(`required patterns (${REQUIRED_PATTERNS.length})`);
  for (const [label, pattern] of REQUIRED_PATTERNS) {
    const matches = pack.paths.filter((path) => pattern.test(path));
    if (matches.length === 0) problems.push(`missing required asset: ${label}`);
    lines.push(`  ${matches.length > 0 ? "ok  " : "FAIL"} ${label} (${matches.length} match(es))`);
  }

  lines.push("");
  const indexAssets = uiIndexAssets();
  if (indexAssets === null) {
    problems.push(`cannot read ${UI_INDEX}`);
    lines.push(`  FAIL ${UI_INDEX} is missing`);
  } else if (indexAssets.length === 0) {
    problems.push(`${UI_INDEX} references no /ui/assets/* file`);
    lines.push("  FAIL no /ui/assets/* reference found");
  } else {
    lines.push(`index.html assets (${indexAssets.length})`);
    for (const asset of indexAssets) {
      const ok = present.has(asset);
      if (!ok) problems.push(`index references a missing packed asset: ${asset}`);
      lines.push(`  ${ok ? "ok  " : "FAIL"} ${asset}`);
    }
  }

  lines.push("");
  lines.push(`required absent (${ABSENT_RULES.length} rules)`);
  for (const rule of ABSENT_RULES) {
    const leaks = pack.paths.filter(rule.matches);
    if (leaks.length > 0) {
      problems.push(
        `packed path must not ship: ${rule.label} (${leaks.length} match(es): ${leaks
          .slice(0, 5)
          .join(", ")}${leaks.length > 5 ? ", ..." : ""})`,
      );
    }
    lines.push(`  ${leaks.length === 0 ? "ok  " : "FAIL"} ${rule.label}`);
  }

  lines.push("");
  lines.push("bin entry");
  const shebang = checkShebang();
  if (!shebang.ok) problems.push(`bin shebang: ${shebang.detail}`);
  lines.push(`  ${shebang.ok ? "ok  " : "FAIL"} ${BIN_ENTRY}: ${shebang.detail}`);

  lines.push("");
  lines.push("size budget");
  if (pack.packedSize > PACKED_SIZE_LIMIT) {
    problems.push(
      `packed size ${formatBytes(pack.packedSize)} exceeds the ${formatBytes(PACKED_SIZE_LIMIT)} hard limit`,
    );
    lines.push(`  FAIL ${formatBytes(pack.packedSize)} packed`);
  } else if (pack.packedSize > PACKED_SIZE_WARN) {
    warnings.push(
      `packed size ${formatBytes(pack.packedSize)} is above the ${formatBytes(PACKED_SIZE_WARN)} warning threshold`,
    );
    lines.push(`  warn ${formatBytes(pack.packedSize)} packed`);
  } else {
    lines.push(
      `  ok   ${formatBytes(pack.packedSize)} packed (warn above ${formatBytes(PACKED_SIZE_WARN)}, fail above ${formatBytes(PACKED_SIZE_LIMIT)})`,
    );
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("warnings");
    for (const warning of warnings) lines.push(`  warn ${warning}`);
  }

  console.log(lines.join("\n"));

  if (problems.length > 0) {
    console.error("");
    console.error(`FAIL check-pack: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`PASS check-pack: ${pack.entryCount} entries, ${formatBytes(pack.packedSize)} packed`);
}

try {
  main();
} catch (error) {
  console.error("");
  console.error(`FAIL check-pack: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
