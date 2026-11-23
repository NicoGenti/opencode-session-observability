import { useRef } from "react";

/**
 * The promise-based confirmation the legacy UI expressed with `askConfirm()`
 * (`src/ui/app.js:3210-3246`): one dialog at a time, a second request settles
 * the first with `false`, and every dismissal path — Cancel, Esc, an outside
 * click — resolves `false`.
 *
 * Framework-free so the contract is testable without a DOM; `ConfirmDialog` is a
 * thin Radix wrapper over this snapshot.
 */

export interface ConfirmOptions {
  title: string;
  message: string;
  acceptLabel?: string;
  danger?: boolean;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  acceptLabel: string;
  danger: boolean;
}

export const CONFIRM_DEFAULTS = Object.freeze({
  cancelLabel: "Cancel",
  acceptLabel: "Continue",
  danger: true,
});

export class ConfirmController {
  private current: ConfirmRequest | null = null;
  private resolver: ((accepted: boolean) => void) | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ConfirmRequest | null => this.current;

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  request = (options: ConfirmOptions): Promise<boolean> => {
    const previous = this.resolver;
    this.resolver = null;
    previous?.(false);
    this.current = {
      title: options.title,
      message: options.message,
      acceptLabel: options.acceptLabel ?? CONFIRM_DEFAULTS.acceptLabel,
      danger: options.danger ?? CONFIRM_DEFAULTS.danger,
    };
    this.notify();
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  };

  settle = (accepted: boolean): void => {
    if (!this.current) return;
    const resolve = this.resolver;
    this.resolver = null;
    this.current = null;
    this.notify();
    resolve?.(accepted);
  };
}

export function useConfirmController(): ConfirmController {
  const ref = useRef<ConfirmController | null>(null);
  if (ref.current === null) ref.current = new ConfirmController();
  return ref.current;
}
