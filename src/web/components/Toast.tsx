import { useSyncExternalStore } from "react";
import type { ToastController } from "../lib/toast.ts";

/**
 * The one toast (`index.html:96`), rendered from `ToastController`.
 *
 * Single instance, newest message replaces the previous one, auto-dismissed
 * after 2400 ms by the controller (`app.js:364-373`). The live region is
 * `role="status"` with `aria-live="polite"` because the copy is never an error
 * requiring focus; the drawer's own loading regions stay separate.
 */
export function Toast({ controller }: { controller: ToastController }) {
  const message = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => null,
  );
  if (message === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-border floating-frost px-3 py-1.5 text-[12.5px] text-text shadow-float"
    >
      {message}
    </div>
  );
}
