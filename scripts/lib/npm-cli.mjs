// Shared npm-CLI resolver for the smoke scripts (scripts/host-smoke.mjs and
// scripts/consumer-smoke.mjs). Node built-ins only: no dependencies, and no
// command line is ever handed to a shell.
//
// Why this exists: `npm`/`npx` are `.cmd` batch shims on Windows that Node
// refuses to spawn without the `shell` option enabled, and building a command
// line for cmd.exe is the injection surface these scripts must not have. The
// shims are thin wrappers around the npm CLI scripts (`npm-cli.js` /
// `npx-cli.js`), so the script is located on disk and handed to the current
// Node binary as an argument array: no shell, no quoting, same entry point. Both
// scripts import this module, so the two copies cannot drift (error texts
// included).
//
// Resolution order, mirroring the shim instead of guessing one install:
//
//   1. `NPM_CONFIG_PREFIX` / `npm_config_prefix`, probed with the global-prefix
//      layouts (Windows `<prefix>/node_modules/npm/bin`, POSIX
//      `<prefix>/lib/node_modules/npm/bin`);
//   2. every `PATH` directory, probed with every known layout, so the npm a
//      shell would find first is the one a consumer would actually run;
//   3. the bundled-with-node layouts around `process.execPath`, as the final
//      fallback, so the actions/setup-node tarball layout keeps working when
//      `PATH` does not expose it.
//
// The search plan travels with the result, so a miss can name every layout and
// every base directory that was searched (plus the npm version next to it)
// instead of pointing at a single misleading path.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const isWindows = process.platform === "win32";
const VERSION_TIMEOUT_MS = 30 * 1000;

/**
 * The npm CLI script behind each shim. A Map (not a plain object) so a command
 * value such as `constructor` or `__proto__` can never fall into the npm branch.
 */
const NPM_CLI_FILES = new Map([
  ["npm", "npm-cli.js"],
  ["npx", "npx-cli.js"],
]);

/**
 * Layouts around a directory that carries the `node`/`npm` shims: the Node
 * install root itself (nvm on Windows), a POSIX `bin` directory
 * (`<bin>/../lib/node_modules/npm/bin`, actions/setup-node and /usr/local),
 * Homebrew's `libexec`, and the Debian/Ubuntu distro package, where
 * `/usr/bin/npm` is a shim for `/usr/share/nodejs/npm/bin/npm-cli.js`.
 */
const SHIM_LAYOUTS = isWindows
  ? [
      ["<base>/node_modules/npm/bin", (base) => join(base, "node_modules", "npm", "bin")],
      ["<base>/../lib/node_modules/npm/bin", (base) => join(resolve(base, ".."), "lib", "node_modules", "npm", "bin")],
      ["<base>/../libexec/lib/node_modules/npm/bin", (base) => join(resolve(base, ".."), "libexec", "lib", "node_modules", "npm", "bin")],
      ["<base>/../share/nodejs/npm/bin", (base) => join(resolve(base, ".."), "share", "nodejs", "npm", "bin")],
    ]
  : [
      ["<base>/../lib/node_modules/npm/bin", (base) => join(resolve(base, ".."), "lib", "node_modules", "npm", "bin")],
      ["<base>/node_modules/npm/bin", (base) => join(base, "node_modules", "npm", "bin")],
      ["<base>/../libexec/lib/node_modules/npm/bin", (base) => join(resolve(base, ".."), "libexec", "lib", "node_modules", "npm", "bin")],
      ["<base>/../share/nodejs/npm/bin", (base) => join(resolve(base, ".."), "share", "nodejs", "npm", "bin")],
    ];

/**
 * Layouts around a global npm prefix (`NPM_CONFIG_PREFIX`), which holds
 * `node_modules` directly instead of a `bin` directory. The platform's own
 * layout is probed first; the others are tolerated because a prefix can be
 * shared across platforms (nvm-windows writes `<prefix>/node_modules/npm`).
 */
const PREFIX_LAYOUTS = isWindows
  ? [
      ["<prefix>/node_modules/npm/bin", (prefix) => join(prefix, "node_modules", "npm", "bin")],
      ["<prefix>/lib/node_modules/npm/bin", (prefix) => join(prefix, "lib", "node_modules", "npm", "bin")],
      ["<prefix>/libexec/lib/node_modules/npm/bin", (prefix) => join(prefix, "libexec", "lib", "node_modules", "npm", "bin")],
      ["<prefix>/share/nodejs/npm/bin", (prefix) => join(prefix, "share", "nodejs", "npm", "bin")],
    ]
  : [
      ["<prefix>/lib/node_modules/npm/bin", (prefix) => join(prefix, "lib", "node_modules", "npm", "bin")],
      ["<prefix>/node_modules/npm/bin", (prefix) => join(prefix, "node_modules", "npm", "bin")],
      ["<prefix>/libexec/lib/node_modules/npm/bin", (prefix) => join(prefix, "libexec", "lib", "node_modules", "npm", "bin")],
      ["<prefix>/share/nodejs/npm/bin", (prefix) => join(prefix, "share", "nodejs", "npm", "bin")],
    ];

/** The CLI script file name behind `command`, or null when it is not npm/npx. */
export function npmCliFile(command) {
  return NPM_CLI_FILES.get(command) ?? null;
}

function pathValue(env) {
  return env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
}

/** `NPM_CONFIG_PREFIX` (npm's primary spelling) or its `npm_config_prefix` alias. */
function prefixValue(env) {
  for (const key of ["NPM_CONFIG_PREFIX", "npm_config_prefix"]) {
    const value = env?.[key] ?? process.env[key];
    if (typeof value === "string" && value.trim() !== "") return resolve(value.trim());
  }
  return null;
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The ordered search plan: the npm prefix (when configured), every base
 * directory, and the de-duplicated roots they expand to. Windows paths are
 * compared case-insensitively, matching the file system.
 */
function searchPlan(env) {
  const key = (value) => (isWindows ? value.toLowerCase() : value);
  const prefix = prefixValue(env);
  const bases = [];
  const roots = [];
  const seenBase = new Set();
  const seenRoot = new Set();
  const addRoot = (root) => {
    const id = key(root);
    if (seenRoot.has(id)) return;
    seenRoot.add(id);
    roots.push(root);
  };
  const addBase = (directory) => {
    const id = key(directory);
    if (seenBase.has(id)) return;
    seenBase.add(id);
    bases.push(directory);
    for (const [, layout] of SHIM_LAYOUTS) addRoot(layout(directory));
  };

  if (prefix !== null) {
    for (const [, layout] of PREFIX_LAYOUTS) addRoot(layout(prefix));
  }
  for (const directory of pathValue(env).split(delimiter)) {
    if (directory === "") continue;
    addBase(directory);
  }
  // Final fallback: the npm bundled with the Node binary running this script.
  addBase(dirname(process.execPath));
  return { prefix, bases, roots };
}

/**
 * Resolves the npm CLI script behind `command` (`npm` or `npx`).
 *
 * Returns `{ command, file, script, roots, bases, prefix }`: `file` is the CLI
 * file name (null when `command` is not npm/npx), `script` is the absolute path
 * found (null on a miss) and the rest describes what was searched.
 */
export function resolveNpmCli(command, env = process.env) {
  const file = npmCliFile(command);
  if (file === null) {
    return { command, file: null, script: null, roots: [], bases: [], prefix: null };
  }
  const plan = searchPlan(env);
  for (const root of plan.roots) {
    const candidate = join(root, file);
    if (isFile(candidate)) {
      return { command, file, script: candidate, ...plan };
    }
  }
  return { command, file, script: null, ...plan };
}

/** The version an npm CLI script prints for `--version`, or null when it cannot run. */
export function npmCliVersion(script, env = process.env) {
  if (typeof script !== "string" || script === "") return null;
  const result = spawnSync(process.execPath, [script, "--version"], {
    env,
    timeout: VERSION_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  const line = String(result.stdout ?? "").trim().split(/\r?\n/u)[0] ?? "";
  return line === "" ? null : line;
}

/**
 * One line for a passing step: the resolved CLI script path and its version, so
 * an npm-version surprise is visible instead of implicit.
 */
export function describeNpmCli(resolution, env = process.env) {
  if (resolution.script === null) return `${resolution.command}: npm CLI script not found`;
  const version = npmCliVersion(resolution.script, env);
  return `${resolution.command} ${version ?? "version unknown"} (${resolution.script})`;
}

/**
 * The shared failure text for a miss: every layout and every base directory that
 * was searched, plus the npm version found next to them. Both smoke scripts
 * render this identically (the previous per-script copies had already drifted).
 */
export function npmCliMissMessage(command, resolution, env = process.env) {
  const { file, roots, bases, prefix } = resolution;
  // A missing `npx-cli.js` still has a known npm version: report it, because a
  // partial npm installation is the likeliest cause of the miss.
  const npm = file === "npm-cli.js" ? resolution : resolveNpmCli("npm", env);
  const npmVersion = npm.script === null
    ? `unavailable (${file === "npm-cli.js" ? "npm-cli.js was not found in any layout below" : "no npm-cli.js found either"})`
    : `${npmCliVersion(npm.script, env) ?? "version unknown"} (${npm.script})`;
  const lines = [
    `could not locate the \`${command}\` CLI script (${file}) for this Node installation`,
    `  npm version: ${npmVersion}`,
    `  searched ${roots.length} root(s) — each of these layouts, applied to every base directory below:`,
  ];
  for (const [label] of SHIM_LAYOUTS) lines.push(`    ${label}`);
  if (prefix !== null) {
    for (const [label] of PREFIX_LAYOUTS) lines.push(`    ${label}`);
  }
  lines.push(`  base directories (${bases.length}):`);
  for (const base of bases) lines.push(`    ${base}`);
  lines.push(`  npm prefix (NPM_CONFIG_PREFIX/npm_config_prefix): ${prefix ?? "not set"}`);
  lines.push(
    `  Node ${process.version} on ${process.platform}; this script runs the npm CLI script through the Node binary and never builds a command line for a shell, so a resolvable npm CLI script is required`,
  );
  return lines.join("\n");
}
