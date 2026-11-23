import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveSnapshot } from "../../core/live.ts";
import type { ApiFn } from "../lib/api.ts";
import {
  LIVE_POLL_MS,
  liveWarningsSignature,
  liveSinceCursor,
  nextLiveCursor,
  shouldHeavyRefresh,
  shouldReplaceLiveWarnings,
  withStaleMarker,
  type LiveFrame,
} from "../lib/live.ts";

export interface UseLivePollOptions {
  api: ApiFn;
  sessionID: string | null;
  /** The Live toggle. */
  enabled: boolean;
  /** True while a session load or refresh is in flight. */
  paused: boolean;
  /** The last `orderKey` the loaded analysis has already seen. */
  lastSeenOrderKey(): string | null | undefined;
  /** The heavy `refreshCurrent()` pass: the caller re-requests the view. */
  onHeavyRefresh(): void;
}

export interface UseLivePollResult {
  frame: LiveFrame | null;
  /** Set only when no frame exists yet; a stale frame carries its own detail. */
  error: string | null;
  since: string | null;
  /** One tick now (visibility regained, manual refresh). */
  pollNow(): void;
}

interface LiveResponse extends LiveSnapshot {
  revealAllowed?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * The one live poller (`app.js:4045-4110`).
 *
 * Contract kept from legacy:
 *
 * - one interval of `LIVE_POLL_MS` for the whole app; the hook is mounted once in
 *   `App`, never per view, so a view change cannot start a second timer;
 * - a tick runs only while the document is visible and no load or refresh is in
 *   flight, and regaining visibility ticks immediately rather than waiting out
 *   the remainder of the interval;
 * - the request carries the `since` cursor (`liveSinceCursor`), and the response
 *   seeds the next one (`nextLiveCursor`);
 * - `liveRequestSeq` is bumped when the toggle turns off or the session changes,
 *   so an in-flight response is a no-op; a session switch also clears the frame;
 * - the heavy pass runs only when `shouldHeavyRefresh` allows it;
 * - a failed poll keeps the previous frame with the stale marker, and with no
 *   frame leaves `error` for the "Live unavailable" reading;
 * - the warning array keeps its previous identity when the rule set is unchanged,
 *   so the `aria-live` region is not announced again every five seconds.
 */
export function useLivePoll(options: UseLivePollOptions): UseLivePollResult {
  const { api, sessionID, enabled, paused } = options;

  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);

  const frameRef = useRef<LiveFrame | null>(null);
  const sinceRef = useRef<string | null>(null);
  const warningsKey = useRef<string | null>(null);
  const pausedRef = useRef(paused);
  const lastSeenRef = useRef(options.lastSeenOrderKey);
  const heavyRef = useRef(options.onHeavyRefresh);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const lastSession = useRef<string | null>(null);

  pausedRef.current = paused;
  lastSeenRef.current = options.lastSeenOrderKey;
  heavyRef.current = options.onHeavyRefresh;

  const commitFrame = useCallback((next: LiveFrame | null) => {
    frameRef.current = next;
    setFrame(next);
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    if (!sessionID || inFlight.current) return;
    const ticket = ++sequence.current;
    inFlight.current = true;
    const cursor = liveSinceCursor(sinceRef.current, frameRef.current, lastSeenRef.current());
    try {
      const data = await api<LiveResponse>(
        `/api/sessions/${encodeURIComponent(sessionID)}/live`,
        { since: cursor ?? undefined },
      );
      if (ticket !== sequence.current) return;
      const previous = frameRef.current;
      const heavy = shouldHeavyRefresh(previous, data);
      // `since` advances only on the page just read; an empty page keeps it.
      const nextSince = nextLiveCursor(cursor, data.newEvents);
      sinceRef.current = nextSince;
      setSince(nextSince);
      setError(null);
      const key = liveWarningsSignature(data.warnings);
      const next: LiveFrame = shouldReplaceLiveWarnings(warningsKey.current, key)
        ? data
        : { ...data, warnings: previous?.warnings ?? data.warnings };
      warningsKey.current = key;
      commitFrame(next);
      if (heavy) heavyRef.current();
    } catch (failure) {
      if (ticket !== sequence.current) return;
      const previous = frameRef.current;
      const stale = withStaleMarker(previous, messageOf(failure));
      commitFrame(stale);
      // A second failure repeats the same text: the setter keeps the reference.
      setError((current) => {
        const next = stale === null ? messageOf(failure) : null;
        return current === next ? current : next;
      });
    } finally {
      if (ticket === sequence.current) inFlight.current = false;
    }
  }, [api, commitFrame, sessionID]);

  const pollNow = useCallback((): void => {
    void poll();
  }, [poll]);

  useEffect(() => {
    if (!enabled || !sessionID) {
      // Turning the toggle off (or leaving the session route) clears the frame,
      // the error and the cursor, and invalidates any in-flight response.
      sequence.current += 1;
      inFlight.current = false;
      warningsKey.current = null;
      sinceRef.current = null;
      frameRef.current = null;
      lastSession.current = null;
      setFrame(null);
      setError(null);
      setSince(null);
      return;
    }

    // A session switch clears the previous frame before the first tick, so a
    // failed load cannot leave another session's badge or warnings on screen.
    if (lastSession.current !== null && lastSession.current !== sessionID) {
      frameRef.current = null;
      setFrame(null);
    }
    lastSession.current = sessionID;

    // Seeded from the session on screen: the first tick derives the cursor from
    // the analysis it is about to read, never from a previous session.
    sinceRef.current = null;
    setSince(null);
    setError(null);
    warningsKey.current = null;
    void poll();

    const timer = setInterval(() => {
      if (!visible() || pausedRef.current || inFlight.current) return;
      void poll();
    }, LIVE_POLL_MS);

    const onVisibility = (): void => {
      if (visible() && !pausedRef.current) void poll();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      // Any response still in flight belongs to the previous session/toggle.
      sequence.current += 1;
      inFlight.current = false;
    };
  }, [enabled, poll, sessionID]);

  return { frame, error, since, pollNow };
}
