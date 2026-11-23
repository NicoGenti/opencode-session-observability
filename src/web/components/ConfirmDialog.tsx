import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  CONFIRM_DEFAULTS,
  type ConfirmController,
} from "../lib/confirm.ts";

export { useConfirmController } from "../lib/confirm.ts";

/**
 * The Radix wrapper over `ConfirmController`. Radix owns the focus trap, `Esc`
 * and focus return; every close path resolves `false`, so Cancel is the
 * default answer.
 */
export function ConfirmDialog({ controller }: { controller: ConfirmController }) {
  const request = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => null,
  );
  const accept = useCallback(() => controller.settle(true), [controller]);
  const cancel = useCallback(() => controller.settle(false), [controller]);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) controller.settle(false);
    },
    [controller],
  );
  // Remember the control that asked for confirmation; `onCloseAutoFocus` puts
  // focus back there because the request is opened programmatically.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const isOpen = request !== null;
    if (isOpen && !wasOpen.current) {
      const active = globalThis.document?.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
    }
    wasOpen.current = isOpen;
  }, [request]);

  const acceptClass = useMemo(
    () =>
      request?.danger
        ? "rounded-sm bg-critical px-2.5 py-1 text-[12.5px] text-page"
        : "rounded-sm bg-accent px-2.5 py-1 text-[12.5px] text-page",
    [request?.danger],
  );

  return (
    <Dialog.Root open={request !== null} onOpenChange={onOpenChange}>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-page/70 frosted-scrim" />
      <Dialog.Content
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = opener.current;
          opener.current = null;
          if (target?.isConnected) target.focus();
        }}
        className="fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border floating-frost p-5 text-text shadow-float"
      >
        <Dialog.Title className="text-[14px] font-semibold">
          {request?.title ?? "Confirm"}
        </Dialog.Title>
        <Dialog.Description className="mt-1 text-[12.5px] leading-[1.5] text-text-2">
          {request?.message ?? ""}
        </Dialog.Description>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-[12.5px] text-text-2"
          >
            {CONFIRM_DEFAULTS.cancelLabel}
          </button>
          <button type="button" onClick={accept} className={acceptClass}>
            {request?.acceptLabel ?? CONFIRM_DEFAULTS.acceptLabel}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
