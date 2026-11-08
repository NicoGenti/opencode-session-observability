import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TokenRecord {
  version: 1;
  port: number;
  token: string;
  createdAt: string;
  pid: number;
}

/** Tests and portable installs can override the directory. */
export function tokenDirectory(): string {
  const override = process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR;
  if (override) return override;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "opencode-observability");
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return join(runtime, "opencode-observability");
  return join(homedir(), ".config", "opencode-observability");
}

export function tokenFilePath(port: number): string {
  return join(tokenDirectory(), `token-${port}.json`);
}

/**
 * Writes a per-port token record with user-only permissions. The TUI reads it
 * so default-on authentication does not require copying the token by hand.
 */
export async function writeTokenFile(
  port: number,
  token: string,
): Promise<string> {
  const directory = tokenDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = tokenFilePath(port);
  const temporary = `${target}.${process.pid}.tmp`;
  const record: TokenRecord = {
    version: 1,
    port,
    token,
    createdAt: new Date().toISOString(),
    pid: process.pid,
  };
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rm(target, { force: true });
  await rename(temporary, target);
  try {
    await chmod(target, 0o600);
  } catch {
    // Windows does not apply POSIX modes; the profile directory is user-scoped.
  }
  return target;
}

export async function readTokenFile(port: number): Promise<TokenRecord | null> {
  try {
    const raw = await readFile(tokenFilePath(port), "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenRecord>;
    if (
      parsed.version !== 1 ||
      parsed.port !== port ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0
    ) {
      return null;
    }
    return parsed as TokenRecord;
  } catch {
    return null;
  }
}

/** Removes the file only when it still belongs to this run. */
export async function removeTokenFile(
  port: number,
  token: string,
): Promise<void> {
  const record = await readTokenFile(port);
  if (!record || record.token !== token) return;
  await clearTokenFile(port);
}

/** Removes any token file for the port, including one left by a hard kill. */
export async function clearTokenFile(port: number): Promise<void> {
  try {
    await rm(tokenFilePath(port), { force: true });
  } catch {
    // A stale token file is harmless; the next run overwrites it.
  }
}
