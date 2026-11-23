/**
 * Token storage and fragment consumption, a strict TypeScript port of
 * `src/ui/auth.js`.
 *
 * The run token arrives in the URL fragment (never sent to the server) and is
 * moved into `sessionStorage` under `observability-token` before any routing.
 * `consumeTokenFromLocation` must run before the first route render; the
 * `AuthProvider` does exactly that on mount.
 */

import {
  domScope,
  type StorageLike,
} from "./settings.ts";

/** The per-tab storage key, unchanged from the legacy UI. */
export const TOKEN_STORAGE_KEY = "observability-token";

export interface TokenRead {
  token: string | null;
  cleanHash: string;
}

export interface TokenLocation {
  hash: string;
  pathname: string;
  search: string;
}

export interface TokenHistory {
  replaceState(state: unknown, title: string, url: string): void;
}

function safeSessionStorage(): StorageLike | null {
  try {
    return domScope().sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads `token` from the URL fragment and returns the fragment without it.
 * Fragments are never sent to the server, so the token stays out of request
 * logs. Query parameters and path segments are left untouched.
 */
export function readTokenFromHash(hash: string): TokenRead {
  if (typeof hash !== "string" || hash.length === 0) {
    return { token: null, cleanHash: hash };
  }
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const normalized =
    raw.includes("?") || !raw.startsWith("token=") ? raw : `/?${raw}`;
  const question = normalized.indexOf("?");
  if (question === -1) return { token: null, cleanHash: hash };
  const path = normalized.slice(0, question);
  const params = new URLSearchParams(normalized.slice(question + 1));
  const token = params.get("token");
  if (!token) return { token: null, cleanHash: hash };
  params.delete("token");
  const query = params.toString();
  return { token, cleanHash: `#${path}${query ? `?${query}` : ""}` };
}

export function getStoredToken(
  storage: StorageLike | null = safeSessionStorage(),
): string | null {
  try {
    return storage?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeToken(
  token: string | null | undefined,
  storage: StorageLike | null = safeSessionStorage(),
): void {
  if (!token) return;
  try {
    storage?.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Private mode or blocked storage: the in-memory token still works.
  }
}

export function clearToken(
  storage: StorageLike | null = safeSessionStorage(),
): void {
  try {
    storage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

export function authHeaders(
  token: string | null | undefined,
): Record<string, string> {
  const value = typeof token === "string" ? token.trim() : "";
  return value ? { Authorization: `Bearer ${value}` } : {};
}

/**
 * Consumes a token from the current fragment, stores it for this tab, and
 * removes it from the address bar. Falls back to the stored token.
 */
export function consumeTokenFromLocation(
  location: TokenLocation | null | undefined,
  history: TokenHistory | null | undefined,
  storage: StorageLike | null = safeSessionStorage(),
): string | null {
  if (!location) return getStoredToken(storage);
  const { token, cleanHash } = readTokenFromHash(location.hash);
  if (!token) return getStoredToken(storage);
  storeToken(token, storage);
  try {
    history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}${cleanHash}`,
    );
  } catch {
    // The token is already stored; a failed cleanup must not break the UI.
  }
  return token;
}

/**
 * Copy for the Radix token dialog that replaces the legacy `window.prompt`
 * fallback. Sentence case, no exclamation marks, no trailing period on the
 * short strings (labels and actions).
 */
export interface TokenPromptCopy {
  title: string;
  description: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  cancelLabel: string;
  invalidMessage: string;
}

export const TOKEN_PROMPT_COPY: Readonly<TokenPromptCopy> = Object.freeze({
  title: "Access token required",
  description:
    "This run requires a token. Paste the token printed by the server; it stays in this tab and is not written to disk.",
  label: "Access token",
  placeholder: "Paste the token from the server output",
  submitLabel: "Use token",
  cancelLabel: "Cancel",
  invalidMessage: "Enter the token to continue",
});
