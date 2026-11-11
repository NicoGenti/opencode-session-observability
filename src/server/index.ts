import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createObservabilityServer } from "./http.ts";
import { generateToken } from "./auth.ts";
import {
  clearTokenFile,
  removeTokenFile,
  writeTokenFile,
} from "./token-file.ts";
import {
  DatabaseDiscoveryError,
  discoverDatabase,
} from "../core/adapters/paths.ts";
import {
  DatabaseBusyError,
  UnsupportedSchemaError,
} from "../core/adapters/sqlite.ts";

/**
 * Resolves the package version by walking up from this module to the nearest
 * package.json. Walking up (instead of a fixed relative path) keeps the lookup
 * correct in both layouts: `src/server/index.ts` during development and
 * `dist/server/index.js` after the build, in the checkout or installed from npm.
 */
function resolvePackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // No readable package.json here; continue towards the filesystem root.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not resolve the package version from package.json");
    }
    directory = parent;
  }
}

const VERSION = resolvePackageVersion();

const HELP = `opencode-session-observability ${VERSION}

Local, read-only Trajectory and Statistics views for OpenCode 2 sessions.

Usage:
  opencode-observability [options]

Options:
  --db <path>       Path to the OpenCode 2 SQLite database
                    (default: discover XDG/OpenCode 2 locations)
  --host <host>     Bind address (default: 127.0.0.1)
  --port <port>     Port (default: 4517; 0 picks a free port)
  --reveal          Allow the explicit "reveal secrets" mode
  --no-reveal       Keep reveal disabled (the default)
  --token           Generate a per-run access token (default) and print it
  --token=<value>   Use an explicit access token (at least 16 characters)
  --no-auth         Disable the access token (loopback only)
  --allow-remote    Allow a non-loopback --host; requires authentication
  --open            Open the browser after starting
  --help, -h        Show this help
  --version, -v     Print the version

The server is read-only: it opens the database with SQLITE_OPEN_READONLY and
PRAGMA query_only. It never writes sessions, messages or configuration.
`;

interface CliOptions {
  dbPath?: string;
  host: string;
  port: number;
  allowReveal: boolean;
  allowRemote: boolean;
  authToken?: string;
  generatedToken: boolean;
  noAuth: boolean;
  open: boolean;
  help: boolean;
  version: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    host: "127.0.0.1",
    port: 4517,
    allowReveal: false,
    allowRemote: false,
    generatedToken: false,
    noAuth: false,
    open: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg === "--reveal") {
      options.allowReveal = true;
    } else if (arg === "--no-reveal") {
      options.allowReveal = false;
    } else if (arg === "--allow-remote") {
      options.allowRemote = true;
    } else if (arg === "--token") {
      options.authToken = generateToken();
      options.generatedToken = true;
    } else if (arg.startsWith("--token=")) {
      const value = arg.slice("--token=".length).trim();
      if (value.length < 16) {
        throw new Error("--token must be at least 16 characters");
      }
      options.authToken = value;
      options.generatedToken = false;
    } else if (arg === "--no-auth") {
      options.noAuth = true;
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--db") {
      const value = argv[++index];
      if (!value) throw new Error("--db requires a path");
      options.dbPath = value;
    } else if (arg.startsWith("--db=")) {
      options.dbPath = arg.slice("--db=".length);
    } else if (arg === "--host") {
      const value = argv[++index];
      if (!value) throw new Error("--host requires a value");
      options.host = value;
    } else if (arg.startsWith("--host=")) {
      const value = arg.slice("--host=".length);
      if (!value) throw new Error("--host requires a value");
      options.host = value;
    } else if (arg === "--port") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      options.port = value;
    } else if (arg.startsWith("--port=")) {
      const value = Number(arg.slice("--port=".length));
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      options.port = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.noAuth && options.authToken !== undefined) {
    throw new Error("--token and --no-auth are mutually exclusive");
  }
  if (options.noAuth) {
    options.authToken = undefined;
    options.generatedToken = false;
  } else if (options.authToken === undefined) {
    options.authToken = generateToken();
    options.generatedToken = true;
  }
  return options;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Opening the browser is best-effort; the URL is printed either way.
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!isLoopback(options.host) && !options.allowRemote) {
    process.stderr.write(
      `Refusing to bind ${options.host}: the server is loopback-only by default.\n` +
        "Use --allow-remote to expose it on a non-loopback interface; authentication stays required.\n",
    );
    process.exitCode = 2;
    return;
  }
  if (!isLoopback(options.host) && options.authToken === undefined) {
    process.stderr.write(
      `Refusing to bind ${options.host} without authentication.\n` +
        "--no-auth is loopback-only. Remove it or bind to a loopback address.\n",
    );
    process.exitCode = 2;
    return;
  }

  let dbPath = options.dbPath;
  if (!dbPath) {
    try {
      dbPath = discoverDatabase().path;
    } catch (error) {
      if (error instanceof DatabaseDiscoveryError) {
        process.stderr.write(`${error.message}\n\nCandidates:\n`);
        for (const candidate of error.candidates) {
          process.stderr.write(
            `  [${candidate.exists ? candidate.schema : "missing"}] ${candidate.path}\n`,
          );
        }
        process.stderr.write(
          "\nStart OpenCode 2 once, or pass --db <path> to an OpenCode 2 database.\n",
        );
      } else if (error instanceof UnsupportedSchemaError) {
        process.stderr.write(`${error.message}\n`);
      } else {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      process.exitCode = 1;
      return;
    }
  }

  let running;
  try {
    running = await createObservabilityServer({
      dbPath,
      host: options.host,
      port: options.port,
      allowReveal: options.allowReveal,
      authToken: options.authToken,
    });
  } catch (error) {
    if (error instanceof UnsupportedSchemaError || error instanceof DatabaseBusyError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${options.port} is already in use. Try --port 0 or another port.\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  let tokenFile: string | null = null;
  if (options.authToken && options.generatedToken) {
    try {
      tokenFile = await writeTokenFile(running.port, options.authToken);
    } catch (error) {
      process.stderr.write(
        `Warning: could not write the token file: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  } else {
    // An explicit token is not persisted; remove any stale file so the TUI
    // does not present a token that belongs to a previous run.
    await clearTokenFile(running.port);
  }

  const uiUrl = options.authToken
    ? `${running.url}/#/?token=${encodeURIComponent(options.authToken)}`
    : running.url;
  process.stdout.write(
    [
      "OpenCode Session Observability",
      `Database: ${running.dbPath}`,
      `Bind:     ${running.host}:${running.port}`,
      `URL:      ${uiUrl}`,
      "Mode:     read-only (SQLITE_OPEN_READONLY, PRAGMA query_only)",
      options.allowReveal
        ? "Secrets:  redacted by default; explicit reveal is allowed"
        : "Secrets:  redacted; reveal is disabled (use --reveal to allow)",
      options.authToken
        ? `Auth:     token required (${
            options.generatedToken ? "generated" : "explicit"
          }); do not share this URL`
        : "Auth:     disabled (--no-auth; loopback only)",
      ...(tokenFile ? [`Token:    ${tokenFile} (read by the TUI)`] : []),
      ...(isLoopback(options.host)
        ? []
        : ["Warning:  non-loopback bind; access requires the run token."]),
      "Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );

  if (options.open) openBrowser(uiUrl);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await running.close();
    } finally {
      if (tokenFile && options.authToken) {
        await removeTokenFile(running.port, options.authToken);
      }
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
