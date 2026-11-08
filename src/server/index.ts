import { spawn } from "node:child_process";
import { createObservabilityServer } from "./http.ts";
import {
  DatabaseDiscoveryError,
  discoverDatabase,
} from "../core/adapters/paths.ts";
import {
  DatabaseBusyError,
  UnsupportedSchemaError,
} from "../core/adapters/sqlite.ts";

const VERSION = "0.1.0";

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
  --allow-remote    Allow a non-loopback --host (unauthenticated LAN exposure)
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
      `Refusing to bind ${options.host}: the server has no authentication.\n` +
        "Use --allow-remote to expose it on a non-loopback interface.\n",
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

  process.stdout.write(
    [
      "OpenCode Session Observability",
      `Database: ${running.dbPath}`,
      `Bind:     ${running.host}:${running.port}`,
      `URL:      ${running.url}`,
      "Mode:     read-only (SQLITE_OPEN_READONLY, PRAGMA query_only)",
      options.allowReveal
        ? "Secrets:  redacted by default; explicit reveal is allowed"
        : "Secrets:  redacted; reveal is disabled (use --reveal to allow)",
      ...(isLoopback(options.host)
        ? []
        : ["Warning:  non-loopback bind; the API has no authentication."]),
      "Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );

  if (options.open) openBrowser(running.url);

  const shutdown = async (): Promise<void> => {
    await running.close();
    process.exit(0);
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
