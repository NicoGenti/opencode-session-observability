import { readTokenFile } from "../server/token-file.ts";

/**
 * Local-UI transport helpers (issue #9).
 *
 * The TUI entry point (`tui.ts`) and the status badge seam (`tui-status.ts`)
 * both resolve the local UI URL, read its token and probe `/api/health`. This
 * leaf owns that shared transport so the two seams never have to import each
 * other. It imports nothing from `tui.ts`, `tui-native.ts` or `tui-status.ts`,
 * so the seam graph stays acyclic. It is pure `.ts`: no JSX, no `@opentui/*`.
 */

const DEFAULT_URL = "http://127.0.0.1:4517";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Where the local UI answers: reachable, token-protected, or offline. */
export type Reachability = "ok" | "auth" | "down";

export function pluginToken(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const env = process.env.OPENCODE_OBSERVABILITY_TOKEN;
  return typeof env === "string" && env.trim().length > 0 ? env.trim() : null;
}

export async function tokenFromFile(base: string): Promise<string | null> {
  try {
    const url = new URL(base);
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return (await readTokenFile(port))?.token ?? null;
  } catch {
    return null;
  }
}

export function baseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return DEFAULT_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_URL;
    // The TUI only opens the local UI; restrict the target to loopback so the
    // configurable URL cannot be turned into a launcher for arbitrary hosts.
    if (!LOOPBACK.has(url.hostname.toLowerCase())) return DEFAULT_URL;
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_URL;
  }
}

export async function reachable(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Reachability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(`${url}/api/health`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return "down";
    const body = (await response.json().catch(() => null)) as {
      authRequired?: unknown;
    } | null;
    return body?.authRequired === true ? "auth" : "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
