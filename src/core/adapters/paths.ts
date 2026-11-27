import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detectSchema, UnsupportedSchemaError } from "./sqlite.ts";
import type { SchemaKind } from "./sqlite.ts";

export interface DatabaseCandidate {
  path: string;
  exists: boolean;
  schema: SchemaKind;
  mtimeMs?: number;
  error?: string;
}

export interface DiscoveryOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

export class DatabaseDiscoveryError extends Error {
  readonly candidates: DatabaseCandidate[];
  constructor(message: string, candidates: DatabaseCandidate[]) {
    super(message);
    this.name = "DatabaseDiscoveryError";
    this.candidates = candidates;
  }
}

export function candidateDatabasePaths(options: DiscoveryOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const paths: string[] = [];
  const push = (value: string | undefined | null): void => {
    if (!value) return;
    const normalized = resolve(value);
    if (!paths.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      paths.push(normalized);
    }
  };

  push(options.explicitPath);
  push(env.OPENCODE_OBSERVABILITY_DB);
  push(env.OPENCODE_DB);
  if (env.XDG_DATA_HOME) push(join(env.XDG_DATA_HOME, "opencode", "opencode.db"));
  push(join(home, ".opencode2", "data", "opencode", "opencode.db"));
  push(join(home, ".local", "share", "opencode", "opencode.db"));
  if (platform === "win32") {
    if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, "opencode", "opencode.db"));
    if (env.APPDATA) push(join(env.APPDATA, "opencode", "opencode.db"));
  }
  if (platform === "darwin") {
    push(join(home, "Library", "Application Support", "opencode", "opencode.db"));
  }
  if (platform === "linux") {
    push(join(home, ".config", "opencode", "opencode.db"));
  }
  return paths;
}

export function inspectDatabase(path: string): DatabaseCandidate {
  if (!existsSync(path)) {
    return { path, exists: false, schema: "unknown" };
  }
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: false });
    // Same read-only discipline the long-lived adapter applies: the handle is
    // opened read-only and can never write even if a later caller tried.
    db.exec("PRAGMA query_only = ON");
    const schema = detectSchema(db);
    return { path, exists: true, schema, ...(mtimeMs !== undefined ? { mtimeMs } : {}) };
  } catch (error) {
    return {
      path,
      exists: true,
      schema: "unknown",
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Inspects every candidate database location and returns them all, in priority
 * order. Missing candidates are reported with `exists: false` and are never
 * opened; existing ones are read read-only through {@link inspectDatabase}.
 */
export function listDatabaseCandidates(
  options: DiscoveryOptions = {},
): DatabaseCandidate[] {
  return candidateDatabasePaths(options).map((path) => inspectDatabase(path));
}

/**
 * Derives a stable, opaque key from a database path. The path is canonicalized
 * with `resolve`/`normalize`, then hashed with SHA-256 and truncated to 12 hex
 * characters. Case is folded only where the platform treats case variants as
 * the same file (`win32`); on POSIX filesystems distinct spellings keep distinct
 * keys. `platform` defaults to the running process and exists so callers (and
 * tests) can pin the fold rule.
 */
export function candidateKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = normalize(resolve(path));
  const canonical = platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * Selects an OpenCode 2 database. An explicit path is authoritative. Otherwise
 * the first OpenCode 2 database in priority order wins: environment overrides,
 * XDG data home, the isolated ~/.opencode2 profile, then standard locations.
 * An OpenCode 1 database is reported clearly instead of being opened as if it
 * were compatible.
 */
export function discoverDatabase(options: DiscoveryOptions = {}): DatabaseCandidate {
  const paths = candidateDatabasePaths(options);
  const candidates = paths.map(inspectDatabase);

  if (options.explicitPath) {
    const explicit = candidates[0]!;
    if (!explicit.exists) {
      throw new DatabaseDiscoveryError(
        `Database not found: ${explicit.path}`,
        candidates,
      );
    }
    if (explicit.schema !== "v2") {
      throw new UnsupportedSchemaError(
        explicit.schema === "v1"
          ? `OpenCode 1 database detected at ${explicit.path}. This build reads OpenCode 2 (session_v2/session_message).`
          : `Unrecognized database at ${explicit.path}. Expected OpenCode 2 tables session_v2 and session_message.`,
      );
    }
    return explicit;
  }

  const v2 = candidates.find((candidate) => candidate.schema === "v2");
  if (v2) return v2;

  const v1 = candidates.filter((candidate) => candidate.schema === "v1");
  if (v1.length > 0) {
    throw new DatabaseDiscoveryError(
      `Only OpenCode 1 databases were found (${v1.map((candidate) => candidate.path).join(", ")}). This build requires OpenCode 2. Pass --db <path> if an OpenCode 2 database exists elsewhere.`,
      candidates,
    );
  }

  throw new DatabaseDiscoveryError(
    `No OpenCode 2 database found. Looked in: ${paths.join(", ")}. Start OpenCode 2 once or pass --db <path>.`,
    candidates,
  );
}
