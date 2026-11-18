// Installed-consumer smoke gate for a packed tarball.
//
// Installs the artifact into an isolated temp prefix (never the repo
// `node_modules`), then drives it the way a consumer would: the CLI entry
// point, `npx` resolution from both an inherited and a scrubbed npm
// environment, and the installed server against a fixture database.
//
// This is the empirical proof behind several packaging claims:
//   - zero runtime dependencies (the installed manifest declares none),
//   - the shipped bin works outside the worktree (it resolves the prebuilt
//     `dist-server/server.mjs` bundle, not the TypeScript source),
//   - `--version` matches `package.json` (the version-drift guard also holds in
//     the shipped artifact),
//   - the server is read-only (database size/mtime unchanged across requests),
//   - redaction is on by default and `?reveal` is rejected with 403.
//
// Usage: node scripts/consumer-smoke.mjs --tarball ./<name>-<version>.tgz
//
// Zero runtime dependencies: Node built-ins only. Nothing is printed that
// could leak the run token or the fixture secrets. Exits 1 on any violation.
//
// Node: the fixture builder imports `node:sqlite`, so on Node 22 the
// `--experimental-sqlite` flag is required (CI sets it through NODE_OPTIONS).
// TypeScript sources are loaded directly; Node 22.18+/24.x type-strip them.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";

const PACKAGE_NAME = "opencode-session-observability";
const BIN_ENTRY = ["bin", "opencode-observability.mjs"];

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
const START_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Values seeded into the `ses_secrets` fixture. None of them may appear in a
// redacted API response, and none of them is ever printed by this script.
const FIXTURE_SECRETS = [
  "sk-supersecretvalue12345",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-abcdefghijklmnopqrstuvwxyz",
  "sk-testvalue1234567890",
  "hunter2",
];

const SECRET_SESSION_ID = "ses_secrets";
const REVEAL_DISABLED_MESSAGE =
  "Raw payload reveal is disabled by the server configuration.";

const STEPS = [
  ["tarball", "tarball path resolves to an existing .tgz file"],
  ["install", "npm install --prefix <temp> <tarball> (production, no scripts)"],
  ["nodeps", "installed manifest declares no runtime dependencies"],
  ["help", "installed bin --help prints a Usage section"],
  ["version", "installed bin --version matches package.json"],
  ["npx", "npx --no-install resolves the bin from the consumer prefix"],
  ["npx-clean", "npx --no-install still resolves with a scrubbed npm environment"],
  ["fixture", "secrets fixture database written to a temp directory"],
  ["db-before", "database size/mtime recorded before serving"],
  ["server", "installed server binds on 127.0.0.1 and prints its port"],
  ["health", "GET /api/health returns ok/readOnly/version"],
  ["redaction", "authenticated session and event payloads are redacted"],
  ["reveal", "?reveal is rejected with 403 reveal_disabled"],
  ["db-after", "database size/mtime unchanged after serving"],
  ["shutdown", "server exits after SIGTERM"],
  ["cleanup", "temporary prefixes removed"],
];

const repoVersion = readJson(join(repoRoot, "package.json")).version;

const results = new Map();
let state = {
  tarballInput: null,
  tarball: null,
  prefix: null,
  packageRoot: null,
  binPath: null,
  fixture: null,
  before: null,
  port: null,
  token: null,
  child: null,
  capture: { stdout: "", stderr: "" },
};

// ---------------------------------------------------------------------------
// Output hygiene
// ---------------------------------------------------------------------------

function redact(text) {
  let out = String(text ?? "");
  if (state.token) out = out.split(state.token).join("[redacted-token]");
  for (const secret of FIXTURE_SECRETS) {
    out = out.split(secret).join("[redacted-secret]");
  }
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

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * `npm` and `npx` are `.cmd` batch shims on Windows that Node refuses to spawn
 * without a shell, and joining a command line for a shell is the injection
 * surface this script must not have. Both shims are thin wrappers around the
 * npm CLI scripts, so the script is located and handed to this Node binary as
 * an argument array: no shell, no quoting, same entry point.
 */
const NPM_CLI_FILES = { npm: "npm-cli.js", npx: "npx-cli.js" };

/** The npm CLI script behind `npm`/`npx`, or null when this Node installation has no npm. */
function npmCliScript(name, env) {
  const file = NPM_CLI_FILES[name];
  if (!file) return null;
  const pathValue = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const directories = new Set([dirname(process.execPath)]);
  for (const entry of pathValue.split(delimiter)) {
    if (entry !== "") directories.add(entry);
  }
  for (const directory of directories) {
    // <node>/node_modules/npm/bin (Windows, nvm), <prefix>/lib/node_modules/npm/bin
    // (POSIX, actions/setup-node) and <prefix>/libexec/lib/node_modules/npm/bin.
    const roots = [
      join(directory, "node_modules", "npm", "bin"),
      resolve(directory, "..", "lib", "node_modules", "npm", "bin"),
      resolve(directory, "..", "libexec", "lib", "node_modules", "npm", "bin"),
    ];
    for (const root of roots) {
      const candidate = join(root, file);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function describeFailure(result) {
  const stdout = tail(redact(result.stdout ?? ""));
  const stderr = tail(redact(result.stderr ?? ""));
  const parts = [`exit ${result.status}`];
  if (stderr !== "") parts.push(`stderr:\n${stderr}`);
  if (stdout !== "") parts.push(`stdout:\n${stdout}`);
  return parts.join("\n");
}

/**
 * Runs a command synchronously without a shell. `npm`/`npx` resolve to their
 * CLI script run by this Node binary; every other command is spawned as a
 * program with an argument array, so no argument is ever parsed by a shell.
 */
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
    shell: false,
  };
  if (NPM_CLI_FILES[command]) {
    const script = npmCliScript(command, env);
    if (!script) {
      throw new Error(
        `could not locate the \`${command}\` CLI script next to ${process.execPath}; ` +
          "this script never builds command lines for a shell, so the npm installation on PATH is required",
      );
    }
    return spawnSync(process.execPath, [script, ...args], common);
  }
  return spawnSync(command, args, common);
}

function mustSucceed(label, result) {
  if (result.error) {
    throw new Error(`${label} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed\n${describeFailure(result)}`);
  }
  return result;
}

/** An npm environment that inherits nothing from the developer's machine. */
function scrubbedEnvironment(cacheDirectory, userConfigFile) {
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
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.npm_config_cache = cacheDirectory;
  env.npm_config_userconfig = userConfigFile;
  env.npm_config_update_notifier = "false";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.NO_COLOR = "1";
  return env;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepTarball() {
  const input = state.tarballInput;
  if (!input) throw new Error("--tarball <path> is required");
  const absolute = resolve(process.cwd(), input);
  if (!absolute.toLowerCase().endsWith(".tgz")) {
    throw new Error(`tarball must be a .tgz file: ${absolute}`);
  }
  let info;
  try {
    info = statSync(absolute);
  } catch {
    throw new Error(`tarball does not exist: ${absolute}`);
  }
  if (!info.isFile()) throw new Error(`tarball is not a file: ${absolute}`);
  if (info.size === 0) throw new Error(`tarball is empty: ${absolute}`);
  state.tarball = absolute;
  return `${absolute} (${formatBytes(info.size)})`;
}

async function stepInstall() {
  state.prefix = mkdtempSync(
    join(tmpdir(), "opencode-consumer-smoke-"),
  );
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
  const installedRoot = join(state.prefix, "node_modules", PACKAGE_NAME);
  if (!existsSync(installedRoot)) {
    throw new Error(
      `npm install left no ${PACKAGE_NAME} in ${state.prefix}/node_modules\n${tail(
        redact(result.stdout ?? ""),
      )}`,
    );
  }
  return `installed into ${state.prefix}`;
}

async function stepNoDependencies() {
  if (!state.prefix) throw new Error("no consumer prefix (install step did not run)");
  const manifestPath = join(
    state.prefix,
    "node_modules",
    PACKAGE_NAME,
    "package.json",
  );
  if (!existsSync(manifestPath)) {
    throw new Error(`installed manifest is missing: ${manifestPath}`);
  }
  const installed = readJson(manifestPath);
  const dependencies = installed.dependencies ?? {};
  const names = Object.keys(dependencies);
  if (names.length > 0) {
    throw new Error(
      `installed package declares runtime dependencies: ${names.join(", ")}`,
    );
  }
  if (installed.name !== PACKAGE_NAME) {
    throw new Error(
      `installed package is ${JSON.stringify(installed.name)}, expected ${PACKAGE_NAME}`,
    );
  }
  const packageRoot = dirname(manifestPath);
  const binPath = join(packageRoot, ...BIN_ENTRY);
  if (!existsSync(binPath)) {
    throw new Error(`installed bin entry is missing: ${binPath}`);
  }
  state.packageRoot = packageRoot;
  state.binPath = binPath;
  return `no runtime dependencies; bin entry present`;
}

async function stepHelp() {
  const result = runSync(
    process.execPath,
    [state.binPath, "--help"],
    { cwd: state.packageRoot },
  );
  mustSucceed("installed bin --help", result);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!output.includes("Usage:")) {
    throw new Error(
      `--help printed no "Usage:" section\n${tail(redact(output))}`,
    );
  }
  const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
  return `Usage section present (${lines.length} non-empty lines)`;
}

async function stepVersion() {
  const result = runSync(
    process.execPath,
    [state.binPath, "--version"],
    { cwd: state.packageRoot },
  );
  mustSucceed("installed bin --version", result);
  const printed = String(result.stdout ?? "").trim();
  if (printed !== repoVersion) {
    throw new Error(
      `--version printed ${JSON.stringify(printed)}, expected ${JSON.stringify(repoVersion)}`,
    );
  }
  return `prints ${printed} (matches package.json)`;
}

async function stepNpx() {
  const result = runSync(
    "npx",
    ["--no-install", PACKAGE_NAME, "--version"],
    { cwd: state.prefix, timeout: COMMAND_TIMEOUT_MS },
  );
  mustSucceed("npx --no-install", result);
  const printed = String(result.stdout ?? "").trim();
  if (printed !== repoVersion) {
    throw new Error(
      `npx printed ${JSON.stringify(printed)}, expected ${JSON.stringify(repoVersion)}`,
    );
  }
  return `npx resolved the bin offline and printed ${printed}`;
}

async function stepNpxCleanEnvironment() {
  const scrubDirectory = join(state.prefix, "clean-environment");
  const cacheDirectory = join(scrubDirectory, "npm-cache");
  const userConfigFile = join(scrubDirectory, "npmrc");
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(userConfigFile, "", "utf8");

  const result = runSync(
    "npx",
    [
      "--no-install",
      "--cache",
      cacheDirectory,
      "--userconfig",
      userConfigFile,
      PACKAGE_NAME,
      "--version",
    ],
    {
      cwd: state.prefix,
      env: scrubbedEnvironment(cacheDirectory, userConfigFile),
      timeout: COMMAND_TIMEOUT_MS,
    },
  );
  mustSucceed("npx --no-install (scrubbed environment)", result);
  const printed = String(result.stdout ?? "").trim();
  if (printed !== repoVersion) {
    throw new Error(
      `scrubbed npx printed ${JSON.stringify(printed)}, expected ${JSON.stringify(repoVersion)}`,
    );
  }
  return `resolved with an empty userconfig and a fresh cache; printed ${printed}`;
}

async function stepFixture() {
  const fixtures = await import(
    new URL("../test/fixtures/build.ts", import.meta.url).href
  );
  if (typeof fixtures.secretsFixture !== "function") {
    throw new Error("test/fixtures/build.ts exports no secretsFixture()");
  }
  if (typeof fixtures.writeFixtureDb !== "function") {
    throw new Error("test/fixtures/build.ts exports no writeFixtureDb()");
  }
  const fixture = fixtures.writeFixtureDb(fixtures.secretsFixture());
  if (!fixture?.path || !existsSync(fixture.path)) {
    throw new Error("writeFixtureDb() did not produce a database file");
  }
  state.fixture = fixture;
  return `fixture with ${SECRET_SESSION_ID} written to ${fixture.path}`;
}

function statDatabase() {
  const info = statSync(state.fixture.path);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

async function stepDatabaseBefore() {
  state.before = statDatabase();
  return `${state.before.size} bytes, mtime ${state.before.mtimeMs}`;
}

function waitForBind(child, timeoutMs) {
  return new Promise((resolvePort, rejectPort) => {
    let buffer = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPort(error);
    };
    const onStdout = (chunk) => {
      buffer += chunk.toString();
      const match = /^Bind:\s+(\S+):(\d+)\s*$/m.exec(buffer);
      if (!match) return;
      settled = true;
      cleanup();
      resolvePort({ port: Number(match[2]), host: match[1] });
    };
    const onExit = (code, signal) => {
      fail(
        new Error(
          `server exited before printing a Bind line (code=${code}, signal=${signal})\n${tail(
            redact(`${state.capture.stdout}\n${state.capture.stderr}`),
          )}`,
        ),
      );
    };
    const onError = (error) => {
      fail(new Error(`server process error: ${redact(error.message)}`));
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `server printed no Bind line within ${timeoutMs}ms\n${tail(
            redact(`${state.capture.stdout}\n${state.capture.stderr}`),
          )}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stepServer() {
  state.token = randomBytes(32).toString("hex");
  const child = spawn(
    process.execPath,
    [
      state.binPath,
      "--db",
      state.fixture.path,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      `--token=${state.token}`,
    ],
    {
      cwd: state.packageRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  state.child = child;
  state.capture = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    state.capture.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    state.capture.stderr += chunk.toString();
  });

  const bound = await waitForBind(child, START_TIMEOUT_MS);
  state.port = bound.port;
  return `bound ${bound.host}:${bound.port} (explicit token, reveal disabled)`;
}

function apiUrl(path) {
  return `http://127.0.0.1:${state.port}${path}`;
}

async function getJson(path, { authenticated = true } = {}) {
  const headers = authenticated
    ? { authorization: `Bearer ${state.token}` }
    : {};
  const response = await fetch(apiUrl(path), {
    headers,
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, text, body };
}

function assertNoSecrets(label, text) {
  const leaks = FIXTURE_SECRETS.filter((secret) => text.includes(secret));
  if (leaks.length > 0) {
    // Count only: the values themselves must never reach the console.
    throw new Error(`${label} leaked ${leaks.length} fixture secret value(s)`);
  }
}

async function stepHealth() {
  const response = await getJson("/api/health", { authenticated: false });
  if (response.status !== 200) {
    throw new Error(
      `/api/health returned ${response.status}\n${tail(redact(response.text))}`,
    );
  }
  const body = response.body;
  if (body?.ok !== true) throw new Error("/api/health did not report ok:true");
  if (body?.readOnly !== true) {
    throw new Error("/api/health did not report readOnly:true");
  }
  if (typeof body?.version !== "string" || body.version === "") {
    throw new Error("/api/health reported no version");
  }
  if (body.version !== repoVersion) {
    throw new Error(
      `/api/health reported version ${JSON.stringify(body.version)}, expected ${JSON.stringify(repoVersion)}`,
    );
  }
  if (body.authRequired !== true) {
    throw new Error("/api/health did not report authRequired:true");
  }
  if (body.revealAllowed !== false) {
    throw new Error("/api/health did not report revealAllowed:false");
  }
  return `ok:true, readOnly:true, version ${body.version}, authRequired:true, revealAllowed:false`;
}

async function stepRedaction() {
  const detail = await getJson(`/api/sessions/${SECRET_SESSION_ID}`);
  if (detail.status !== 200) {
    throw new Error(
      `/api/sessions/${SECRET_SESSION_ID} returned ${detail.status}\n${tail(
        redact(detail.text),
      )}`,
    );
  }
  if (detail.body?.session?.id !== SECRET_SESSION_ID) {
    throw new Error(
      `session detail did not return ${SECRET_SESSION_ID}\n${tail(redact(detail.text))}`,
    );
  }
  assertNoSecrets(`/api/sessions/${SECRET_SESSION_ID}`, detail.text);

  // The event page carries the message payloads, which is where the fixture's
  // secrets actually live; redaction must still hold there.
  const events = await getJson(`/api/sessions/${SECRET_SESSION_ID}/events?limit=50`);
  if (events.status !== 200) {
    throw new Error(
      `/api/sessions/${SECRET_SESSION_ID}/events returned ${events.status}\n${tail(
        redact(events.text),
      )}`,
    );
  }
  assertNoSecrets(`/api/sessions/${SECRET_SESSION_ID}/events`, events.text);
  if (!events.text.includes("[REDACTED")) {
    throw new Error("event payloads carry no [REDACTED marker");
  }
  return "session detail and event payloads contain no fixture secret; [REDACTED present";
}

async function stepReveal() {
  const response = await getJson(
    `/api/sessions/${SECRET_SESSION_ID}?reveal=1`,
  );
  if (response.status !== 403) {
    throw new Error(
      `?reveal returned ${response.status}, expected 403\n${tail(
        redact(response.text),
      )}`,
    );
  }
  if (response.body?.error !== "reveal_disabled") {
    throw new Error(
      `?reveal error code is ${JSON.stringify(response.body?.error)}, expected "reveal_disabled"`,
    );
  }
  if (response.body?.message !== REVEAL_DISABLED_MESSAGE) {
    throw new Error(
      `?reveal message is ${JSON.stringify(response.body?.message)}, expected the fixed reveal-disabled message`,
    );
  }
  return `403 {"error":"reveal_disabled","message":${JSON.stringify(
    response.body.message,
  )}}`;
}

async function stepDatabaseAfter() {
  const after = statDatabase();
  if (after.size !== state.before.size) {
    throw new Error(
      `database size changed: ${state.before.size} -> ${after.size} bytes`,
    );
  }
  if (after.mtimeMs !== state.before.mtimeMs) {
    throw new Error(
      `database mtime changed: ${state.before.mtimeMs} -> ${after.mtimeMs}`,
    );
  }
  return `unchanged (${after.size} bytes, mtime ${after.mtimeMs})`;
}

async function stepShutdown() {
  const child = state.child;
  if (!child) throw new Error("no server process was started");
  if (child.exitCode !== null || child.signalCode !== null) {
    state.child = null;
    return `server had already exited (code=${child.exitCode}, signal=${child.signalCode})`;
  }

  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  child.kill("SIGTERM");

  let timer = null;
  const timedOut = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), SHUTDOWN_TIMEOUT_MS);
  });
  const outcome = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);

  if (outcome === "timeout") {
    child.kill("SIGKILL");
    throw new Error(
      `server did not exit within ${SHUTDOWN_TIMEOUT_MS}ms after SIGTERM (SIGKILL sent)\n${tail(
        redact(`${state.capture.stdout}\n${state.capture.stderr}`),
      )}`,
    );
  }

  state.child = null;
  if (outcome.code !== 0 && !isWindows) {
    throw new Error(
      `server exited with code ${outcome.code} (signal ${outcome.signal})\n${tail(
        redact(state.capture.stderr),
      )}`,
    );
  }
  return `exited (code=${outcome.code}, signal=${outcome.signal ?? "none"})`;
}

async function stepCleanup() {
  if (state.child) {
    state.child.kill("SIGKILL");
    state.child = null;
  }
  const targets = [state.prefix, state.fixture?.directory].filter(Boolean);
  const failures = [];
  for (const target of targets) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      failures.push(`${target}: ${redact(error.message)}`);
    }
    if (existsSync(target)) failures.push(`${target} still exists`);
  }
  if (failures.length > 0) {
    throw new Error(`temp cleanup failed:\n${failures.join("\n")}`);
  }
  return `removed ${targets.length} temp dir(s)`;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const RUNNERS = {
  tarball: stepTarball,
  install: stepInstall,
  nodeps: stepNoDependencies,
  help: stepHelp,
  version: stepVersion,
  npx: stepNpx,
  "npx-clean": stepNpxCleanEnvironment,
  fixture: stepFixture,
  "db-before": stepDatabaseBefore,
  server: stepServer,
  health: stepHealth,
  redaction: stepRedaction,
  reveal: stepReveal,
  "db-after": stepDatabaseAfter,
  shutdown: stepShutdown,
  cleanup: stepCleanup,
};

function record(id, ok, detail) {
  results.set(id, { ok, detail: redact(detail) });
}

async function check(id, runner) {
  try {
    const detail = await runner();
    record(id, true, detail ?? "");
    return true;
  } catch (error) {
    const message = error?.message ?? String(error);
    record(id, false, message);
    return false;
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
  return true;
}

function printSummary() {
  const lines = [];
  lines.push(
    `consumer-smoke: ${PACKAGE_NAME}@${repoVersion} on Node ${process.version} (${process.platform})`,
  );
  if (state.tarball) lines.push(`  tarball  ${state.tarball}`);
  if (state.prefix) lines.push(`  prefix   ${state.prefix}`);
  lines.push("");

  for (const [id, label] of STEPS) {
    const result = results.get(id);
    if (!result) {
      lines.push(`  SKIP ${label}`);
      continue;
    }
    lines.push(`  ${result.ok ? "PASS" : "FAIL"} ${label}`);
    if (result.detail) {
      const detailLines = String(result.detail).split(/\r?\n/u);
      for (const detailLine of detailLines) {
        lines.push(`       ${detailLine}`);
      }
    }
  }

  console.log(lines.join("\n"));

  const failed = [...results.entries()].filter(([, entry]) => !entry.ok);
  if (failed.length > 0) {
    console.error("");
    console.error(`FAIL consumer-smoke: ${failed.length} failed step(s)`);
    for (const [id] of failed) console.error(`  - ${id}`);
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log(
    `PASS consumer-smoke: ${[...results.values()].filter((entry) => entry.ok).length} checks against the packed artifact`,
  );
}

const USAGE = `Usage: node scripts/consumer-smoke.mjs --tarball <path-to.tgz>

Installs the packed artifact into an isolated temp prefix and proves it works
as a real consumer dependency: CLI --help/--version, npx resolution from an
inherited and a scrubbed environment, and the read-only server against a
fixture database (health, redaction, reveal rejection, DB immutability).

Create a tarball first with \`npm pack\`. Nothing is published or installed
into the repository.`;

async function main() {
  let shouldRun;
  try {
    shouldRun = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL consumer-smoke: ${error.message}`);
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
      const succeeded = await check(id, RUNNERS[id]);
      if (!succeeded) break;
    }
  } finally {
    await check("cleanup", RUNNERS.cleanup);
  }

  printSummary();
}

await main();
