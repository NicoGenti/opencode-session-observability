/**
 * The single toast instance (`app.js:364-373`).
 *
 * Legacy had exactly one `#toast` element: `toast(message)` wrote the text,
 * un-hid it, cleared the pending timer and armed a 2400 ms dismissal, so a newer
 * message replaced the older one instead of stacking. `Toast.tsx` renders the
 * snapshot; this controller owns that state so the replacement and the timing
 * are testable without a DOM.
 */

import { TOAST_MS } from "./export.ts";

export interface ToastTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: ToastTimers = {
  set(callback, ms) {
    return setTimeout(callback, ms);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class ToastController {
  private message: string | null = null;
  private handle: unknown = null;
  private readonly listeners = new Set<() => void>();
  private readonly timers: ToastTimers;
  private readonly delay: number;

  constructor(timers: ToastTimers = DEFAULT_TIMERS, delay: number = TOAST_MS) {
    this.timers = timers;
    this.delay = delay;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): string | null => this.message;

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Replaces the visible message and re-arms the dismissal. */
  show = (message: string): void => {
    const text = typeof message === "string" ? message : String(message ?? "");
    if (text.length === 0) return;
    this.cancelTimer();
    this.message = text;
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.message = null;
      this.notify();
    }, this.delay);
    this.notify();
  };

  dismiss = (): void => {
    this.cancelTimer();
    if (this.message === null) return;
    this.message = null;
    this.notify();
  };

  /** Stops the pending timer without notifying (unmount). */
  dispose = (): void => {
    this.cancelTimer();
  };

  private cancelTimer(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }
}
