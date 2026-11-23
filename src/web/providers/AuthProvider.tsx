import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  authHeaders,
  clearToken,
  consumeTokenFromLocation,
  getStoredToken,
  storeToken,
} from "../lib/auth.ts";

export interface AuthContextValue {
  /** The run token for this tab, or `null` when none was supplied. */
  token: string | null;
  /** True when a token is available and requests must carry it. */
  authorized: boolean;
  /** The `Authorization` header for the current token, or `{}`. */
  headers: Record<string, string>;
  /** Stores a token entered in the prompt dialog and marks the tab authorized. */
  acceptToken(token: string): void;
  /** Forgets the token for this tab. */
  forgetToken(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Consumes a fragment token before the first route render: the initializer
 * stores it and rewrites the address bar, and a StrictMode second pass simply
 * reads the stored token back. The provider sits above the router, so no route
 * can render while a token is still in the fragment.
 */
function readInitialToken(): string | null {
  return consumeTokenFromLocation(globalThis.location, globalThis.history);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(readInitialToken);

  const acceptToken = useCallback((next: string) => {
    const value = next.trim();
    if (!value) return;
    storeToken(value);
    setToken(value);
  }, []);

  const forgetToken = useCallback(() => {
    clearToken();
    setToken(getStoredToken());
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      authorized: token !== null && token.length > 0,
      headers: authHeaders(token),
      acceptToken,
      forgetToken,
    }),
    [token, acceptToken, forgetToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
