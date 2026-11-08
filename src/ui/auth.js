const STORAGE_KEY = "observability-token";

function safeSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Reads `token` from the URL fragment and returns the fragment without it.
 * Fragments are never sent to the server, so the token stays out of request
 * logs. Query parameters and path segments are left untouched.
 */
export function readTokenFromHash(hash) {
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

export function getStoredToken(storage = safeSessionStorage()) {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeToken(token, storage = safeSessionStorage()) {
  if (!token) return;
  try {
    storage?.setItem(STORAGE_KEY, token);
  } catch {
    // Private mode or blocked storage: the in-memory token still works.
  }
}

export function clearToken(storage = safeSessionStorage()) {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

export function authHeaders(token) {
  const value = typeof token === "string" ? token.trim() : "";
  return value ? { Authorization: `Bearer ${value}` } : {};
}

/**
 * Consumes a token from the current fragment, stores it for this tab, and
 * removes it from the address bar. Falls back to the stored token.
 */
export function consumeTokenFromLocation(
  location,
  history,
  storage = safeSessionStorage(),
) {
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
