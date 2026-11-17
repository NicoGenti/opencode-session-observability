// Best-effort native OpenCode 2 host validation for a packed tarball.
//
// Installs the artifact into an isolated temp prefix (never the repo
// `node_modules`), writes a throwaway OpenCode config that points the `plugins`
// entry at that installed package, then drives the host headlessly:
//
//   opencode serve --hostname 127.0.0.1 --port <free> --print-logs --log-level info
//
// and asks the host to boot a location, so it loads the server plugins for that
// directory. The decisive checks are:
//
//   1. the host resolved the package's `exports["."]` entry and logged
//      `msg="loading plugin" ... /src/plugin/index.ts` for our package;
//   2. no "failed to load plugin" line mentions our package;
//   3. `GET /api/plugin` lists our plugin with `state.status === "active"`;
//   4. `POST /api/rpc/session-observability/health` answers
//      `{"output":{"ok":true,"version":"<package.json version>", ...}}`.
//
// (1) and (4) together are the empirical answer to the packaging question this
// phase owns: `exports["."]` ships TypeScript source and the host is Bun-based,
// so it type-strips the entry at import time. A plain-Node consumer cannot do
// that, which is exactly why `bin/opencode-observability.mjs` prefers the
// prebuilt `dist-server/server.mjs`. If this script reports FAIL, publication is
// blocked and the follow-up issue compiles the `.` entry instead of shipping it
// as source.
//
// Usage: node scripts/host-smoke.mjs --tarball ./<name>-<version>.tgz
//
// Host binary: `OPENCODE_BIN` when set, otherwise `opencode` on PATH. A host
// that is not OpenCode 2 (today's PATH `opencode` is the 1.x CLI) cannot be
// driven this way, so the script exits 2 (MANUAL-REQUIRED) instead of guessing.
// Budget: `HOST_SMOKE_TIMEOUT_MS` (default 45000, clamped to 5000..600000).
//
// Exit codes: 0 PASS, 1 FAIL (a real failure, blocks publication), 2
// MANUAL-REQUIRED (host absent/not v2, or its config isolation could not be
// proven here; the maintainer checklist below is then the gate).
//
// Zero runtime dependencies: Node built-ins only. The server password the
// script sets is never printed (and `server password ...` output is redacted
// defensively). Temp prefixes are removed; the repository `node_modules` and
// the developer's real OpenCode config/profile are never touched: every XDG
// directory, HOME and USERPROFILE point inside the temp prefix and the config
// is passed explicitly through OPENCODE_CONFIG.

// ---------------------------------------------------------------------------
// Maintainer checklist — copied verbatim into docs/RELEASE.md (Phase 7).
//
// BEGIN Phase 7 manual checklist (authoritative; blocking for publication)
//
// Native host validation (executed by a maintainer, results recorded in the
// release notes; `node scripts/host-smoke.mjs --tarball <tgz>` is the scripted
// best-effort half of this gate):
//
// 1. Install the real tarball into a scratch prefix (never a repo checkout):
//      npm install --prefix <scratch> ./opencode-session-observability-<version>.tgz --omit=dev
// 2. Point the OpenCode config at that installed package path:
//      { "plugins": [ { "package": "<scratch>/node_modules/opencode-session-observability",
//                       "options": { "autoStart": false } } ] }
// 3. Restart the host (or POST /api/location/reload) so the plugin loads fresh.
// 4. In the TUI: `/statistics`, `/trajectory` and `/observability` open the
//    native panels, and the `prompt.footer.status` badge shows cost and cache
//    hit rate (`n/a` when the local UI is offline).
// 5. Auto-start spawns `dist-server/server.mjs` — the bundled entry from
//    `src/plugin/tui-warmup.ts` `BUNDLED_ENTRY_SEGMENTS = ["dist-server", "server.mjs"]`.
// 6. Token-file auth works: `npm start` writes the per-port token file, the TUI
//    reads it, and a missing/wrong token produces the documented hint instead
//    of opening an unauthenticated page.
// 7. No "failed to load plugin" message or toast for
//    `opencode-session-observability`.
// 8. Record the host version(s) tested: 2.3.0 in use locally; the repo pins
//    `@opencode/*` 2.2.7.
//
// This phase resolves the `exports["."]` question empirically: the host is
// Bun-based and type-strips TypeScript. If host validation fails, publication is
// blocked and a follow-up issue compiles the `.` entry to JavaScript.
//
// END Phase 7 manual checklist
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";

const PACKAGE_NAME = "opencode-session-observability";
const PLUGIN_ENTRY_SEGMENTS = ["src", "plugin", "index.ts"];
const RPC_NAMESPACE = "session-observability";
const RPC_METHOD = "health";

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_BUDGET_MS = 45 * 1000;
const MIN_BUDGET_MS = 5 * 1000;
const MAX_BUDGET_MS = 600 * 1000;
const POLL_INTERVAL_MS = 500;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The auth scheme the OpenCode 2.3.0 server accepts: HTTP Basic with the fixed
 * username `opencode` and the server password (its `ServerAuthConfig` default).
 * Verified empirically against 2.3.0; a host that answers 401 makes the RPC and
 * plugin steps SKIP rather than pretending the plugin failed.
 */
const AUTH_USERNAME = "opencode";

const STEPS = [
  ["tarball", "tarball path resolves to an existing .tgz file"],
  ["install", "npm install --prefix <temp> <tarball> (production, no scripts)"],
  ["config", "temp OpenCode config points plugins[].package at the installed package"],
  ["host-bin", "OpenCode 2 binary found (OPENCODE_BIN or PATH) and drives `serve`"],
  ["isolation", "host config discovery resolves only to the temp config"],
  ["spawn", "host `serve` starts and announces its loopback URL"],
  ["location", "host boots a location for the temp working directory"],
  ["entry", "host resolved the package entry (src/plugin/index.ts) and attempted to load it"],
  ["rpc", "RPC session-observability.health answers over the host API"],
  ["plugin", "GET /api/plugin reports the plugin state as active"],
  ["logs", 'captured output has no "failed to load plugin" line for this package, and no config outside the temp prefix'],
  ["shutdown", "host process terminated"],
  ["cleanup", "temporary prefixes removed"],
];

const repoVersion = readJson(join(repoRoot, "package.json")).version;

const state = {
  tarballInput: null,
  tarball: null,
  prefix: null,
  packageRoot: null,
  configPath: null,
  workDirectory: null,
  hostBin: null,
  hostVersionLine: null,
  hostArgs: null,
  hostEnvKeys: [],
  port: null,
  baseUrl: null,
  child: null,
  capture: { stdout: "", stderr: "" },
  deadline: 0,
  budgetMs: DEFAULT_BUDGET_MS,
  hostExit: null,
  // Generated once per run, handed to the host through OPENCODE_SERVER_PASSWORD
  // (so it never prints a password) and redacted from everything this script
  // prints. It is not a credential for anything but this throwaway host.
  password: randomBytes(24).toString("base64url"),
};

// ---------------------------------------------------------------------------
// Output hygiene
// ---------------------------------------------------------------------------

function redact(text) {
  let out = String(text ?? "");
  if (state.password) out = out.split(state.password).join("[redacted-password]");
  // Defensive: if a host version ignores OPENCODE_SERVER_PASSWORD it prints the
  // generated password next to this label; never let that reach the console.
  out = out.replace(/(server password\s+)\S+/gi, "$1[redacted-password]");
  return out;
}

function tail(text, limit = 2000) {
  const value = String(text ?? "").trim();
  if (value.length <= limit) return value;
  return `...${value.slice(value.length - limit)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * `mkdtempSync` can hand back a Windows 8.3 (short) path while the host reports
 * the long form of the same directory, so containment checks accept either.
 */
function prefixForms() {
  const forms = new Set();
  if (state.prefix) forms.add(state.prefix.toLowerCase());
  try {
    // `realpathSync.native` expands Windows 8.3 names to the long form the host
    // reports; the JS implementation keeps whatever spelling it was given.
    const native = realpathSync.native ?? realpathSync;
    forms.add(native(state.prefix).toLowerCase());
  } catch {
    // The prefix is created in the install step; before that there is nothing to resolve.
  }
  return [...forms];
}

function isInsidePrefix(value) {
  const lower = String(value ?? "").toLowerCase();
  return prefixForms().some((form) => lower.startsWith(form));
}

function mentionsPrefix(value) {
  const lower = String(value ?? "").toLowerCase();
  return prefixForms().some((form) => lower.includes(form));
}

/** A step outcome that is not a plain pass; `status` is "fail", "skip" or "manual". */
class StepOutcome extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function skip(message) {
  return new StepOutcome("skip", message);
}

function manual(message) {
  return new StepOutcome("manual", message);
}

function fail(message) {
  return new StepOutcome("fail", message);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Quotes an argument for the cmd.exe command line npm and `.cmd` shims run under. */
function quoteArg(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.split('"').join('""')}"`;
}

/** True when the command has to go through cmd.exe on Windows. */
function needsShell(command) {
  if (!isWindows) return false;
  if (/[\\/]/u.test(command)) return /\.(cmd|bat)$/iu.test(command);
  // A bare name (npm, npx) resolves to a .cmd shim that Node cannot spawn directly.
  return true;
}

function describeFailure(result) {
  const stdout = tail(redact(result.stdout ?? ""));
  const stderr = tail(redact(result.stderr ?? ""));
  const parts = [`exit ${result.status}`];
  if (stderr !== "") parts.push(`stderr:\n${stderr}`);
  if (stdout !== "") parts.push(`stdout:\n${stdout}`);
  return parts.join("\n");
}

function runSync(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    timeout = COMMAND_TIMEOUT_MS,
  } = options;
  const common = {
    cwd,
    env,
    timeout,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  };
  if (needsShell(command)) {
    return spawnSync([command, ...args.map(quoteArg)].join(" "), {
      ...common,
      shell: true,
    });
  }
  return spawnSync(command, args, common);
}

function mustSucceed(label, result) {
  if (result.error) throw fail(`${label} could not run: ${redact(result.error.message)}`);
  if (result.status !== 0) throw fail(`${label} failed\n${describeFailure(result)}`);
  return result;
}

/** Locates `name` on PATH without a shell, honouring Windows executable extensions. */
function findOnPath(name) {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const directories = pathValue.split(delimiter).filter((entry) => entry !== "");
  // Native executables first, then cmd.exe shims, then an extensionless entry
  // (a Git-Bash style wrapper that Node cannot spawn directly on Windows).
  const suffixes = isWindows ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      if (!existsSync(candidate)) continue;
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

/**
 * A scrubbed, isolated host environment: nothing inherited that could point the
 * host at the developer's real profile, config, database, cache or credentials.
 */
function isolatedEnvironment(configPath) {
  const keep = [
    "PATH",
    "Path",
    "PATHEXT",
    "Pathext",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "LANG",
    "LC_ALL",
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const home = join(state.prefix, "home");
  const scratch = join(state.prefix, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  // The host's own scratch root follows the platform temp directory; pointing it
  // inside the prefix keeps every file it writes inside the run's temp tree.
  env.TEMP = scratch;
  env.TMP = scratch;
  env.TMPDIR = scratch;
  env.XDG_CONFIG_HOME = join(state.prefix, "xdg", "config");
  env.XDG_DATA_HOME = join(state.prefix, "xdg", "data");
  env.XDG_STATE_HOME = join(state.prefix, "xdg", "state");
  env.XDG_CACHE_HOME = join(state.prefix, "xdg", "cache");
  env.OPENCODE_CONFIG = configPath;
  // Keep the repository's own `.opencode/` config out of the run, even though
  // the temp working directory is already outside it.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  // No third-party network: the host must not fetch model metadata here.
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  // A known password means the host never prints one, and the script can talk
  // to it. The value is generated per run, kept in memory and redacted.
  env.OPENCODE_SERVER_PASSWORD = state.password;
  env.NO_COLOR = "1";
  state.hostEnvKeys = Object.keys(env).sort();
  return env;
}

function authHeaders() {
  const basic = Buffer.from(`${AUTH_USERNAME}:${state.password}`, "utf8").toString("base64");
  return { authorization: `Basic ${basic}` };
}

function locationQuery() {
  return `location%5Bdirectory%5D=${encodeURIComponent(state.workDirectory)}`;
}

function remainingBudget() {
  return Math.max(0, state.deadline - Date.now());
}

async function hostFetch(path, init = {}) {
  const headers = { ...(init.headers ?? {}), ...authHeaders() };
  const timeout = Math.min(15 * 1000, Math.max(1000, remainingBudget()));
  try {
    const response = await fetch(`${state.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    return { status: 0, text: redact(error?.message ?? String(error)) };
  }
}

function sleep(ms) {
  // Deliberately not unref'd: every wait here must keep the process alive until
  // the host has answered or been terminated.
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function captured() {
  return `${state.capture.stdout}\n${state.capture.stderr}`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepTarball() {
  const input = state.tarballInput;
  if (!input) throw fail("--tarball <path> is required");
  const absolute = resolve(process.cwd(), input);
  if (!absolute.toLowerCase().endsWith(".tgz")) {
    throw fail(`tarball must be a .tgz file: ${absolute}`);
  }
  let info;
  try {
    info = statSync(absolute);
  } catch {
    throw fail(`tarball does not exist: ${absolute} (create one with \`npm pack\`)`);
  }
  if (!info.isFile()) throw fail(`tarball is not a file: ${absolute}`);
  if (info.size === 0) throw fail(`tarball is empty: ${absolute}`);
  state.tarball = absolute;
  return `${absolute} (${formatBytes(info.size)})`;
}

async function stepInstall() {
  state.prefix = mkdtempSync(join(tmpdir(), "opencode-host-smoke-"));
  const result = runSync(
    "npm",
    [
      "install",
      "--prefix",
      state.prefix,
      state.tarball,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    { cwd: state.prefix, timeout: INSTALL_TIMEOUT_MS },
  );
  mustSucceed("npm install", result);
  const packageRoot = join(state.prefix, "node_modules", PACKAGE_NAME);
  if (!existsSync(packageRoot)) {
    throw fail(
      `npm install left no ${PACKAGE_NAME} in ${state.prefix}/node_modules\n${tail(
        redact(result.stdout ?? ""),
      )}`,
    );
  }
  const installed = readJson(join(packageRoot, "package.json"));
  if (installed.name !== PACKAGE_NAME) {
    throw fail(
      `installed package is ${JSON.stringify(installed.name)}, expected ${PACKAGE_NAME}`,
    );
  }
  if (installed.version !== repoVersion) {
    throw fail(
      `installed version is ${JSON.stringify(installed.version)}, expected ${JSON.stringify(repoVersion)} from package.json`,
    );
  }
  state.packageRoot = packageRoot;
  return `installed ${PACKAGE_NAME}@${installed.version} into ${state.prefix}`;
}

async function stepConfig() {
  if (!state.prefix) throw fail("no temp prefix (install step did not run)");
  const configDirectory = join(state.prefix, "xdg", "config", "opencode");
  const workDirectory = join(state.prefix, "work");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(workDirectory, { recursive: true });
  const configPath = join(configDirectory, "opencode.jsonc");
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package: state.packageRoot,
        options: { autoStart: false },
      },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const written = readJson(configPath);
  const entry = written.plugins?.[0];
  if (entry?.package !== state.packageRoot) {
    throw fail(`temp config does not carry the installed package path: ${configPath}`);
  }
  if (entry?.options?.autoStart !== false) {
    throw fail(`temp config does not disable autoStart: ${configPath}`);
  }
  state.configPath = configPath;
  state.workDirectory = workDirectory;
  return `${configPath} -> plugins[0].package = ${state.packageRoot}`;
}

async function stepHostBinary() {
  const override = process.env.OPENCODE_BIN;
  const command = override && override.trim() !== "" ? resolve(process.env.OPENCODE_BIN) : findOnPath("opencode");
  if (!command) {
    throw manual(
      "no OpenCode 2 binary: `OPENCODE_BIN` is unset and no `opencode` was found on PATH. " +
        "Set OPENCODE_BIN to the OpenCode 2 CLI (for example %USERPROFILE%\\.opencode2\\node_modules\\@opencode\\cli\\bin\\opencode.exe) " +
        "and re-run; until then the native host validation is the manual checklist at the top of this file.",
    );
  }
  if (!existsSync(command)) {
    throw manual(
      `OPENCODE_BIN points at a missing file: ${command}. Fix the path or unset it to use PATH; the manual checklist then applies.`,
    );
  }
  state.hostBin = command;

  const version = runSync(command, ["--version"], { timeout: COMMAND_TIMEOUT_MS });
  if (version.error) {
    throw manual(
      `the host binary could not be executed (${redact(version.error.message)}): ${command}. The manual checklist then applies.`,
    );
  }
  if (version.status !== 0) {
    throw manual(
      `\`${command} --version\` exited ${version.status}:\n${tail(
        redact(`${version.stdout ?? ""}\n${version.stderr ?? ""}`),
      )}`,
    );
  }
  const versionLine = String(version.stdout ?? "").trim().split(/\r?\n/u)[0] ?? "";
  state.hostVersionLine = versionLine;
  const versionMatch = /(\d+)\.(\d+)\.(\d+)/u.exec(versionLine);
  const major = versionMatch ? Number(versionMatch[1]) : null;
  if (major === null) {
    throw manual(
      `could not read a version from \`${command} --version\` (printed ${JSON.stringify(
        versionLine,
      )}); the manual checklist then applies.`,
    );
  }
  if (major < 2) {
    throw manual(
      `the host at ${command} is OpenCode ${versionLine}, not OpenCode 2 ` +
        "(the 1.x CLI has no plugin host, no `serve` command and no plugin RPC). " +
        "Point OPENCODE_BIN at the OpenCode 2 binary; until then the manual checklist is the gate.",
    );
  }

  const help = runSync(command, ["--help"], { timeout: COMMAND_TIMEOUT_MS });
  if (help.error || help.status !== 0) {
    throw manual(
      `\`${command} --help\` failed, so the headless launch cannot be verified:\n${tail(
        redact(`${help.stdout ?? ""}\n${help.stderr ?? ""}`),
      )}`,
    );
  }
  const helpText = String(help.stdout ?? "");
  if (!/^\s+serve\b/mu.test(helpText)) {
    throw manual(
      `${versionLine} exposes no \`serve\` subcommand, so it cannot be driven headlessly by this script; the manual checklist is the gate.`,
    );
  }
  return `${command} (${versionLine}); \`serve\` subcommand available`;
}

async function stepIsolation() {
  if (!state.configPath || !state.workDirectory) {
    throw fail("no temp config (config step did not run)");
  }
  const env = isolatedEnvironment(state.configPath);
  // `debug paths` reports the profile roots the host would use. It needs no
  // server (unlike `debug config`, which resolves a service connection), so it
  // is the safe way to prove this run cannot reach the developer's profile.
  const result = runSync(state.hostBin, ["debug", "paths"], {
    cwd: state.workDirectory,
    env,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) {
    throw manual(
      `\`debug paths\` could not run (${redact(result.error.message)}); config isolation stays unproven, so the host is not launched. The manual checklist applies.`,
    );
  }
  if (result.status !== 0) {
    throw manual(
      `\`debug paths\` exited ${result.status} on ${state.hostVersionLine}, so isolation cannot be proven here:\n${tail(
        redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
      )}`,
    );
  }
  const reported = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => /^\s*([a-z]+)\s+(.+?)\s*$/u.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ key: match[1], path: match[2] }));
  if (reported.length === 0) {
    throw manual(
      `\`debug paths\` printed no path table, so isolation cannot be proven. Nothing was launched; the manual checklist applies.`,
    );
  }
  const foreign = reported.filter((entry) => !isInsidePrefix(entry.path));
  if (foreign.length > 0) {
    throw manual(
      `refusing to launch: the host would use paths outside the temp prefix:\n  ${foreign
        .map((entry) => `${entry.key} ${entry.path}`)
        .join("\n  ")}\nNothing was launched; the manual checklist applies.`,
    );
  }
  const hasConfigRoot = reported.some(
    (entry) => entry.key === "config" && isInsidePrefix(entry.path),
  );
  if (!hasConfigRoot) {
    throw manual(
      "refusing to launch: the host reported no config root inside the temp prefix. The manual checklist applies.",
    );
  }
  return `${reported.length} host path(s) (home/data/cache/config/state/db) all inside the temp prefix; config passed explicitly through OPENCODE_CONFIG with OPENCODE_DISABLE_PROJECT_CONFIG=1`;
}

async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function stepSpawn() {
  if (!state.hostBin) throw fail("no host binary (host-bin step did not run)");
  const env = isolatedEnvironment(state.configPath);
  state.port = await freePort();
  state.baseUrl = `http://127.0.0.1:${state.port}`;
  state.deadline = Date.now() + state.budgetMs;
  const args = [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(state.port),
    "--print-logs",
    "--log-level",
    "info",
  ];
  state.hostArgs = args;

  const options = {
    cwd: state.workDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
  const child = needsShell(state.hostBin)
    ? spawn([state.hostBin, ...args.map(quoteArg)].join(" "), { ...options, shell: true })
    : spawn(state.hostBin, args, options);
  state.child = child;
  state.capture = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    state.capture.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    state.capture.stderr += chunk.toString();
  });
  child.once("exit", (code, signal) => {
    state.hostExit = { code, signal };
  });
  child.once("error", (error) => {
    state.hostExit = { code: null, signal: null, error: redact(error.message) };
  });

  while (Date.now() < state.deadline) {
    const match = /server listening on (\S+)/u.exec(state.capture.stdout);
    if (match) {
      return `listening on ${match[1]} (pid ${child.pid ?? "unknown"})`;
    }
    if (state.hostExit) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (state.hostExit) {
    const output = captured();
    if (/unrecognized flag|unknown flag|unexpected argument/iu.test(output)) {
      throw manual(
        `this host rejected the headless flags the script uses (${state.hostArgs.join(
          " ",
        )}):\n${tail(
          redact(output),
        )}\nThe CLI shape differs on ${state.hostVersionLine}, so the manual checklist is the gate.`,
      );
    }
    throw fail(
      `host exited before announcing a listening URL (code=${state.hostExit.code}, signal=${
        state.hostExit.signal ?? "none"
      }${state.hostExit.error ? `, error=${state.hostExit.error}` : ""})\n${tail(redact(output))}`,
    );
  }
  throw fail(
    `host announced no listening URL within ${state.budgetMs}ms\n${tail(redact(captured()))}`,
  );
}

async function stepLocation() {
  if (!state.child) throw fail("no host process (spawn step did not run)");
  let last = null;
  while (Date.now() < state.deadline) {
    const response = await hostFetch(`/api/location?${locationQuery()}`);
    if (response.status === 200) {
      return `location booted for ${state.workDirectory}`;
    }
    last = response;
    if (response.status === 401) {
      throw manual(
        `the host rejected the scripted credentials (HTTP 401). This host version authenticates differently, so it cannot be driven headlessly by this script; the manual checklist is the gate. Tried: Basic auth with username "${AUTH_USERNAME}" and the OPENCODE_SERVER_PASSWORD value.`,
      );
    }
    if (response.status === 404) {
      throw manual(
        `this host exposes no /api/location route (HTTP 404 on ${state.hostVersionLine}); drive the manual checklist instead.`,
      );
    }
    if (state.hostExit) break;
    await sleep(POLL_INTERVAL_MS);
  }
  if (state.hostExit) {
    throw fail(
      `host exited before booting a location (code=${state.hostExit.code}, signal=${
        state.hostExit.signal ?? "none"
      })\n${tail(redact(captured()))}`,
    );
  }
  throw fail(
    `host never booted a location within ${state.budgetMs}ms (last HTTP ${
      last ? last.status : "none"
    }: ${tail(redact(last?.text ?? ""), 400)})\n${tail(redact(captured()))}`,
  );
}

function pluginLogLines() {
  return captured()
    .split(/\r?\n/u)
    .filter((line) => line.toLowerCase().includes(PACKAGE_NAME.toLowerCase()));
}

/** A short, redacted read of the host's plugin table, used in failure messages. */
async function pluginStateSummary() {
  const response = await hostFetch(`/api/plugin?${locationQuery()}`);
  if (response.status !== 200) {
    return `plugin state unavailable (GET /api/plugin -> HTTP ${response.status})`;
  }
  let body = null;
  try {
    body = JSON.parse(response.text);
  } catch {
    return "plugin state response was not JSON";
  }
  const plugins = Array.isArray(body?.data) ? body.data : [];
  const ours = plugins.filter(
    (plugin) =>
      plugin?.id === PACKAGE_NAME ||
      (plugin?.source?.path !== undefined && isInsidePrefix(plugin.source.path)),
  );
  if (ours.length === 0) {
    return `the host lists ${plugins.length} server plugin(s) and none of them is ${PACKAGE_NAME}`;
  }
  const entry = ours[0];
  const error = entry?.state?.error ? `: ${tail(redact(entry.state.error), 600)}` : "";
  return `plugin state ${JSON.stringify(entry?.state?.status)}${error}`;
}

function pluginLogTail(limit = 12) {
  const lines = pluginLogLines();
  if (lines.length === 0) return "";
  return tail(redact(lines.slice(-limit).join("\n")), 2000);
}

async function stepEntry() {
  const entryNeedle = PLUGIN_ENTRY_SEGMENTS.join("/").toLowerCase();
  while (Date.now() < state.deadline) {
    const loaded = pluginLogLines().filter(
      (line) =>
        /loading plugin/iu.test(line) &&
        line.toLowerCase().includes(entryNeedle),
    );
    if (loaded.length > 0) {
      return `host resolved the package entry ${PLUGIN_ENTRY_SEGMENTS.join("/")} and attempted to load it`;
    }
    if (state.hostExit) break;
    await sleep(POLL_INTERVAL_MS);
  }
  const mentioned = pluginLogTail();
  throw fail(
    `the host never logged a plugin load for ${PACKAGE_NAME} / ${PLUGIN_ENTRY_SEGMENTS.join(
      "/",
    )}. This is the exports["."] gate: a failure here blocks publication.\n` +
      (mentioned !== ""
        ? `lines mentioning the package:\n${mentioned}`
        : `captured output:\n${tail(redact(captured()))}`),
  );
}

async function stepRpc() {
  let last = null;
  while (Date.now() < state.deadline) {
    const response = await hostFetch(
      `/api/rpc/${RPC_NAMESPACE}/${RPC_METHOD}?${locationQuery()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
      },
    );
    last = response;
    if (response.status === 200) {
      let body = null;
      try {
        body = JSON.parse(response.text);
      } catch {
        body = null;
      }
      const output = body?.output;
      if (!output || output.ok !== true) {
        throw fail(
          `RPC ${RPC_NAMESPACE}.${RPC_METHOD} answered without ok:true\n${tail(
            redact(response.text),
            800,
          )}`,
        );
      }
      if (output.version !== repoVersion) {
        throw fail(
          `RPC health reported version ${JSON.stringify(output.version)}, expected ${JSON.stringify(
            repoVersion,
          )}`,
        );
      }
      if (output.readOnly !== true) {
        throw fail("RPC health did not report readOnly:true");
      }
      if (output.revealAllowed !== false) {
        throw fail("RPC health did not report revealAllowed:false for the default config");
      }
      return `POST /api/rpc/${RPC_NAMESPACE}/${RPC_METHOD} -> ok:true, version ${output.version}, source ${JSON.stringify(
        output.source,
      )}, readOnly:true, revealAllowed:false`;
    }
    if (response.status === 401) {
      throw skip(
        "the host rejected the scripted credentials (HTTP 401); the RPC probe is skipped and the manual checklist covers it.",
      );
    }
    if (response.status === 404) {
      throw skip(
        `this host exposes no /api/rpc route (HTTP 404 on ${state.hostVersionLine}); the RPC probe is skipped and the manual checklist covers it.`,
      );
    }
    if (state.hostExit) break;
    await sleep(POLL_INTERVAL_MS);
  }
  if (state.hostExit) {
    throw fail(
      `host exited before the RPC namespace answered (code=${state.hostExit.code}, signal=${
        state.hostExit.signal ?? "none"
      })\n${tail(redact(captured()))}`,
    );
  }
  const detail = last ? `${last.status} ${tail(redact(last.text), 400)}` : "no response";
  const stateSnapshot = await pluginStateSummary();
  const logTail = pluginLogTail();
  throw fail(
    `RPC ${RPC_NAMESPACE}.${RPC_METHOD} never answered within ${state.budgetMs}ms (last: ${detail}). ` +
      "The host is present but the plugin's server part did not register: publication is blocked.\n" +
      `${stateSnapshot}\n` +
      (logTail === "" ? "" : `package log lines:\n${logTail}\n`),
  );
}

async function stepPluginState() {
  const response = await hostFetch(`/api/plugin?${locationQuery()}`);
  if (response.status === 401) {
    throw skip(
      "the host rejected the scripted credentials (HTTP 401); the plugin-state probe is skipped and the manual checklist covers it.",
    );
  }
  if (response.status === 404) {
    throw skip(
      `this host exposes no /api/plugin route (HTTP 404 on ${state.hostVersionLine}); the plugin-state probe is skipped and the manual checklist covers it.`,
    );
  }
  if (response.status !== 200) {
    throw fail(
      `GET /api/plugin returned ${response.status}\n${tail(redact(response.text), 800)}`,
    );
  }
  let body = null;
  try {
    body = JSON.parse(response.text);
  } catch {
    throw fail(`GET /api/plugin returned non-JSON\n${tail(redact(response.text), 800)}`);
  }
  const plugins = Array.isArray(body?.data) ? body.data : null;
  if (!plugins) {
    throw fail(`GET /api/plugin returned an unexpected shape\n${tail(redact(response.text), 800)}`);
  }
  const ours = plugins.filter(
    (plugin) =>
      plugin?.id === PACKAGE_NAME ||
      (plugin?.source?.path !== undefined && isInsidePrefix(plugin.source.path)),
  );
  if (ours.length === 0) {
    throw fail(
      `the host lists ${plugins.length} server plugin(s) but not ${PACKAGE_NAME}; the package never became a host plugin.\n` +
        tail(redact(captured())),
    );
  }
  const entry = ours[0];
  const status = entry?.state?.status;
  if (status !== "active") {
    const reason = entry?.state?.error ? `\n  error: ${tail(redact(entry.state.error), 800)}` : "";
    throw fail(
      `plugin state is ${JSON.stringify(status)}, expected "active"${reason}\n${tail(
        redact(captured()),
      )}`,
    );
  }
  const features = entry?.features ?? {};
  return `id ${entry.id}, source ${entry?.source?.type ?? "unknown"}, features ${JSON.stringify(
    features,
  )}, state active`;
}

async function stepLogs() {
  const needle = PACKAGE_NAME.toLowerCase();
  const lines = captured().split(/\r?\n/u);
  const offending = lines.filter(
    (line) =>
      line.toLowerCase().includes("failed to load plugin") &&
      line.toLowerCase().includes(needle),
  );
  if (offending.length > 0) {
    throw fail(
      `captured output reports a plugin load failure:\n${tail(redact(offending.join("\n")), 1200)}`,
    );
  }
  // Post-launch isolation check: the host must never have touched a `.opencode`
  // directory outside the temp prefix (that would be the developer's profile or
  // the repository config).
  const foreignConfig = lines.filter((line) => {
    const lower = line.toLowerCase();
    return lower.includes(".opencode") && !mentionsPrefix(line);
  });
  if (foreignConfig.length > 0) {
    throw fail(
      `the host referenced config outside the temp prefix, so this run proves nothing:\n${tail(
        redact(foreignConfig.join("\n")),
        1200,
      )}`,
    );
  }
  const seen = pluginLogLines().length;
  return `no "failed to load plugin" line for ${PACKAGE_NAME} (${seen} package log line(s)) and no .opencode path outside the temp prefix`;
}

async function stepShutdown() {
  const child = state.child;
  if (!child) return "no host process was started";
  if (state.hostExit || child.exitCode !== null || child.signalCode !== null) {
    state.child = null;
    return `host had already exited (code=${child.exitCode ?? state.hostExit?.code}, signal=${
      child.signalCode ?? state.hostExit?.signal ?? "none"
    })`;
  }
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  child.kill("SIGTERM");
  const timedOut = new Promise((resolveTimeout) => {
    setTimeout(() => resolveTimeout("timeout"), SHUTDOWN_TIMEOUT_MS);
  });
  const outcome = await Promise.race([exited, timedOut]);
  if (outcome === "timeout") {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(2000)]);
  }
  state.child = null;
  return `host terminated (SIG${outcome === "timeout" ? "KILL after SIGTERM" : "TERM"})`;
}

async function stepCleanup() {
  if (state.child) {
    state.child.kill("SIGKILL");
    state.child = null;
  }
  if (!state.prefix) return "no temp prefix was created";
  const target = state.prefix;
  const attempts = 5;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    } catch (error) {
      lastError = error;
    }
    if (!existsSync(target)) return `removed ${target}`;
    await sleep(400);
  }
  throw fail(
    `temp cleanup failed for ${target}${lastError ? `: ${redact(lastError.message)}` : ""} (a host child process may still hold a handle)`,
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const RUNNERS = {
  tarball: stepTarball,
  install: stepInstall,
  config: stepConfig,
  "host-bin": stepHostBinary,
  isolation: stepIsolation,
  spawn: stepSpawn,
  location: stepLocation,
  entry: stepEntry,
  rpc: stepRpc,
  plugin: stepPluginState,
  logs: stepLogs,
  shutdown: stepShutdown,
  cleanup: stepCleanup,
};

const results = new Map();

function record(id, status, detail) {
  results.set(id, { status, detail: redact(detail) });
}

async function check(id, runner) {
  try {
    const detail = await runner();
    record(id, "pass", detail ?? "");
    return "pass";
  } catch (error) {
    const status =
      error instanceof StepOutcome
        ? error.status
        : "fail";
    record(id, status, error?.message ?? String(error));
    return status;
  }
}

function parseArguments(argv) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--tarball") {
      const value = argv[++index];
      if (!value) throw new Error("--tarball requires a path");
      state.tarballInput = value;
    } else if (arg.startsWith("--tarball=")) {
      const value = arg.slice("--tarball=".length);
      if (value === "") throw new Error("--tarball requires a path");
      state.tarballInput = value;
    } else if (arg === "--help" || arg === "-h") {
      return false;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  state.budgetMs = budgetFromEnvironment();
  return true;
}

function budgetFromEnvironment() {
  const raw = process.env.HOST_SMOKE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_BUDGET_MS;
  return Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.round(parsed)));
}

const MARKERS = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
  manual: "MANUAL-REQUIRED",
};

function printSummary() {
  const lines = [];
  lines.push(
    `host-smoke: ${PACKAGE_NAME}@${repoVersion} on Node ${process.version} (${process.platform})`,
  );
  if (state.tarball) lines.push(`  tarball   ${state.tarball}`);
  if (state.prefix) lines.push(`  prefix    ${state.prefix}`);
  if (state.configPath) lines.push(`  config    ${state.configPath}`);
  if (state.hostBin) {
    lines.push(
      `  host      ${state.hostBin} (${state.hostVersionLine ?? "version unknown"})`,
    );
  }
  if (state.hostArgs) {
    lines.push(`  command   ${[state.hostBin, ...state.hostArgs].join(" ")}`);
  }
  if (state.hostEnvKeys.length > 0) {
    lines.push(`  env       ${state.hostEnvKeys.join(" ")}`);
  }
  lines.push(`  budget    ${state.budgetMs}ms (HOST_SMOKE_TIMEOUT_MS)`);
  lines.push("");

  for (const [id, label] of STEPS) {
    const result = results.get(id);
    if (!result) {
      lines.push(`  ${MARKERS.skip.padEnd(16)} ${label}`);
      continue;
    }
    lines.push(`  ${MARKERS[result.status].padEnd(16)} ${label}`);
    if (result.detail) {
      for (const detailLine of String(result.detail).split(/\r?\n/u)) {
        lines.push(`                   ${detailLine}`);
      }
    }
  }

  console.log(lines.join("\n"));

  const all = [...results.values()];
  const failed = all.filter((entry) => entry.status === "fail");
  const manualResults = all.filter((entry) => entry.status === "manual");
  const skipped = all.filter((entry) => entry.status === "skip");

  if (failed.length > 0) {
    console.error("");
    console.error(`FAIL host-smoke: ${failed.length} failed check(s) — publication is blocked`);
    for (const [id, result] of results) {
      if (result.status === "fail") console.error(`  - ${id}`);
    }
    process.exitCode = 1;
    return;
  }
  if (manualResults.length > 0) {
    console.log("");
    console.log(
      `MANUAL-REQUIRED host-smoke: ${manualResults.length} check(s) need a real host session — the maintainer checklist is the gate`,
    );
    for (const [id, result] of results) {
      if (result.status === "manual") console.log(`  - ${id}: ${result.detail.split(/\r?\n/u)[0]}`);
    }
    console.log(
      "  checklist: the comment block at the top of scripts/host-smoke.mjs (copied to docs/RELEASE.md)",
    );
    process.exitCode = 2;
    return;
  }
  if (skipped.length > 0) {
    console.log("");
    console.log(
      `PASS host-smoke: ${all.length - skipped.length} automated check(s) against the packed artifact; ${skipped.length} probe(s) skipped`,
    );
    for (const [id, result] of results) {
      if (result.status === "skip") console.log(`  - ${id}: ${result.detail.split(/\r?\n/u)[0]}`);
    }
    return;
  }
  console.log("");
  console.log(
    `PASS host-smoke: ${all.length} check(s) — the packed artifact loads and answers in a real OpenCode host`,
  );
}

const USAGE = `Usage: node scripts/host-smoke.mjs --tarball <path-to.tgz>

Installs the packed artifact into an isolated temp prefix, writes a throwaway
OpenCode config that points \`plugins[].package\` at the installed package, and
drives an OpenCode 2 host headlessly (\`opencode serve\` plus the plugin RPC
route) to prove the packed package loads in a real host.

Host binary: OPENCODE_BIN when set, otherwise \`opencode\` from PATH.
Budget:      HOST_SMOKE_TIMEOUT_MS (default 45000, clamped to 5000..600000).

Exit codes: 0 PASS, 1 FAIL (blocks publication), 2 MANUAL-REQUIRED (no drivable
OpenCode 2 host here — the maintainer checklist at the top of the script is
then the gate).

Create a tarball first with \`npm pack\`. Nothing is published, nothing is
installed into the repository, and the developer's own OpenCode config and
profile are never touched.`;

async function main() {
  let shouldRun;
  try {
    shouldRun = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL host-smoke: ${error.message}`);
    console.error("");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!shouldRun) {
    console.log(USAGE);
    return;
  }

  try {
    for (const [id] of STEPS) {
      if (id === "cleanup") continue;
      const status = await check(id, RUNNERS[id]);
      if (status === "skip") continue;
      if (status !== "pass") break;
    }
  } finally {
    await check("cleanup", RUNNERS.cleanup);
  }

  printSummary();
}

await main();
