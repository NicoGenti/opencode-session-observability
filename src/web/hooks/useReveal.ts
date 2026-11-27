import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ApiFn } from "../lib/api.ts";
import type { ConfirmController } from "../lib/confirm.ts";
import { REVEAL_CONFIRM, TOAST } from "../lib/export.ts";
import { get, set } from "../lib/settings.ts";
import type { ToastController } from "../lib/toast.ts";

export interface RevealState {
  /** The server starts with `--reveal`; until a response says so, reveal is off. */
  allowed: boolean;
  reveal: boolean;
}

export interface UseRevealOptions {
  api: ApiFn;
  confirm: ConfirmController;
  toast: ToastController;
  /**
   * The api client reads this object on every request, so flipping reveal is
   * visible to the very next request; the React state mirrors it for rendering.
   */
  state: MutableRefObject<RevealState>;
  /** Re-requests the session with the new reveal state (analysis, events, detail). */
  onChanged(): void;
  /**
   * The boot theme sync (`app.js:4666-4676`): the health payload names the theme
   * OpenCode 2 selected in its CLI config. The provider decides whether it may
   * apply (not user-set, not a TUI deep link).
   */
  onServerTheme?(name: string | null): void;
}

export interface UseRevealResult extends RevealState {
  toggle(): Promise<void>;
  /** `ApiError("reveal_disabled")`: the server refused, so reveal goes off. */
  forbid(): void;
  /** A response's `revealAllowed` flag. */
  syncAllowed(allowed: boolean): void;
}

interface HealthResponse {
  revealAllowed?: boolean;
  theme?: { name?: unknown } | null;
  /** Present on servers that expose the database catalogue; optional for older ones. */
  startupDbKey?: unknown;
}

/**
 * Reveal gating, a port of `toggleReveal` (`app.js:3122-3141`) and the
 * `reveal_disabled` recovery in `showError` (`:353-357`).
 *
 * Turning reveal on requires the themed confirmation first, then re-requests the
 * session so payloads and exports are produced under the new state. Turning it
 * off needs no confirmation, clears the banner and re-requests redacted data.
 * A server started without `--reveal` keeps the toggle disabled and says why.
 */
export function useReveal(options: UseRevealOptions): UseRevealResult {
  const { api, confirm, toast, state: stateRef, onChanged } = options;
  const [state, setState] = useState<RevealState>(stateRef.current);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const serverThemeRef = useRef(options.onServerTheme);
  serverThemeRef.current = options.onServerTheme;

  const write = useCallback(
    (next: RevealState) => {
      stateRef.current = next;
      setState(next);
    },
    [stateRef],
  );

  const forbid = useCallback(() => {
    if (!stateRef.current.allowed && !stateRef.current.reveal) return;
    write({ allowed: false, reveal: false });
    changedRef.current();
  }, [stateRef, write]);

  // The one reveal policy. Both payload entry points — every response (`App.tsx`
  // hands this very function to the api client as its `onRevealAllowed` sink) and
  // the boot health probe below — call it, so they cannot fork: `false` is the
  // `forbid()` recovery, `true` is enable-only.
  const syncAllowed = useCallback(
    (allowed: boolean) => {
      // A payload that says reveal is not allowed is the same recovery as a
      // refused request: it disarms reveal and re-requests redacted data, so a
      // stale banner can never outlive the server's policy.
      if (!allowed) {
        forbid();
        return;
      }
      // `true` only enables the toggle; it never flips reveal on by itself.
      if (stateRef.current.allowed === allowed) return;
      write({ ...stateRef.current, allowed });
    },
    [forbid, stateRef, write],
  );

  // The health route is public and states its own reveal policy, so the toggle
  // is enabled or disabled before the first session is selected.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // The health route is public; it must not carry `reveal=1` even when the
        // toggle is on (`app.js:4646`).
        const data = await api<HealthResponse>("/api/health", {}, { noReveal: true });
        if (!active) return;
        const themeName = data.theme?.name;
        if (typeof themeName === "string" && themeName.trim().length > 0) {
          serverThemeRef.current?.(themeName.trim());
        }
        // First load adopts the startup database. A stored non-empty key is
        // left alone: the Settings dialog validates it against a fresh
        // catalogue and resets it only if it disappeared. An older server
        // without `startupDbKey` leaves the setting empty (placeholder).
        const startupDbKey =
          typeof data.startupDbKey === "string" ? data.startupDbKey.trim() : "";
        if (startupDbKey) {
          const storedDbKey = get("dbKey");
          if (typeof storedDbKey !== "string" || storedDbKey.trim() === "") {
            set("dbKey", startupDbKey);
          }
        }
        if (typeof data.revealAllowed !== "boolean") return;
        // Same policy as a response payload: no second write site here.
        syncAllowed(data.revealAllowed);
      } catch {
        // A failed health probe leaves reveal disabled; the session payloads
        // still report the policy and `syncAllowed` corrects it.
      }
    })();
    return () => {
      active = false;
    };
  }, [api, syncAllowed]);

  const toggle = useCallback(async (): Promise<void> => {
    if (!stateRef.current.allowed) {
      toast.show(TOAST.revealDisabled);
      return;
    }
    if (!stateRef.current.reveal) {
      const confirmed = await confirm.request({
        title: REVEAL_CONFIRM.title,
        message: REVEAL_CONFIRM.message,
        acceptLabel: REVEAL_CONFIRM.acceptLabel,
      });
      if (!confirmed) return;
    }
    write({ ...stateRef.current, reveal: !stateRef.current.reveal });
    changedRef.current();
  }, [confirm, stateRef, toast, write]);

  return { ...state, toggle, forbid, syncAllowed };
}
