import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CliTheme {
  name: string;
  mode?: "system" | "dark" | "light";
}

export interface ThemeDiscoveryOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * OpenCode 2 keeps the TUI theme in its CLI config (`cli.json`), separate from
 * the project config. The observed profile layout is
 * `~/.opencode2/config/opencode/cli.json`; the XDG and platform locations are
 * checked as fallbacks.
 */
export function candidateCliConfigPaths(
  options: ThemeDiscoveryOptions = {},
): string[] {
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

  push(options.configPath);
  push(env.OPENCODE_CLI_CONFIG);
  if (env.OPENCODE_CONFIG_DIR) {
    push(join(env.OPENCODE_CONFIG_DIR, "opencode", "cli.json"));
  }
  // The isolated OpenCode 2 profile is authoritative before legacy/system
  // locations, mirroring the database discovery order.
  push(join(home, ".opencode2", "config", "opencode", "cli.json"));
  push(join(home, ".opencode2", "config-fm", "opencode", "cli.json"));
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  push(join(xdg, "opencode", "cli.json"));
  if (platform === "win32" && env.APPDATA) {
    push(join(env.APPDATA, "opencode", "cli.json"));
  }
  if (platform === "darwin") {
    push(join(home, "Library", "Application Support", "opencode", "cli.json"));
  }
  return paths;
}

function parseTheme(value: unknown): CliTheme | null {
  if (typeof value === "string") {
    const name = value.trim();
    return name ? { name } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const mode =
    record.mode === "system" || record.mode === "dark" || record.mode === "light"
      ? record.mode
      : undefined;
  return mode ? { name, mode } : { name };
}

/**
 * The CLI theme is process-static configuration: OpenCode writes it once and a
 * running server never needs to observe a mid-process change. The server
 * therefore resolves it exactly once, while it is being created, so no request
 * handler reads a config file. The discovery result is memoised per candidate
 * path list and a failed lookup is cached exactly like a successful one (a
 * malformed or absent config cannot become a per-request filesystem read).
 */
let cachedLookup: { key: string; theme: CliTheme | null } | null = null;
let fileReads = 0;

/** Drops the memo. Only the tests need this; production resolves at startup. */
export function resetOpenCodeThemeCache(): void {
  cachedLookup = null;
  fileReads = 0;
}

/**
 * How many config files this process has actually read. Exposed so a test can
 * prove the theme is resolved at server creation and that serving requests
 * adds no further reads.
 */
export function openCodeThemeReadCount(): number {
  return fileReads;
}

/** Returns the theme currently selected in OpenCode 2, or null when unknown. */
export function readOpenCodeTheme(
  options: ThemeDiscoveryOptions = {},
): CliTheme | null {
  const paths = options.configPath
    ? [resolve(options.configPath)]
    : candidateCliConfigPaths(options);
  const key = paths.join("\n");
  if (cachedLookup !== null && cachedLookup.key === key) {
    return cachedLookup.theme;
  }
  let theme: CliTheme | null = null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      fileReads += 1;
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      theme = parseTheme(config.theme);
      if (theme) break;
    } catch {
      // A malformed or unreadable config must not prevent the UI from starting.
    }
  }
  cachedLookup = { key, theme };
  return theme;
}
