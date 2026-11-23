import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef } from "react";
import { SHORTCUT_ROWS } from "../lib/copy.ts";

export { SHORTCUT_ROWS };

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * The shortcut reference (`docs/UI.md:296-326`), rendered from the shared table
 * so the dialog and its test cannot drift.
 */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const active = globalThis.document?.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-page/70 frosted-scrim" />
      <Dialog.Content
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = opener.current;
          opener.current = null;
          if (target?.isConnected) target.focus();
        }}
        className="fixed left-1/2 top-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border floating-frost p-5 text-text shadow-float"
      >
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title className="text-[14px] font-semibold">
            Keyboard shortcuts
          </Dialog.Title>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="rounded-sm border border-border px-1.5 py-0.5 text-[12px] text-text-2"
            >
              Close
            </button>
          </Dialog.Close>
        </div>
        <Dialog.Description className="mt-1 text-[12px] leading-[1.5] text-text-2">
          Shortcuts are ignored while a field has focus or a dialog is open.
        </Dialog.Description>
        <dl className="mt-4 grid gap-1.5 text-[12.5px]">
          {SHORTCUT_ROWS.map((row) => (
            <div
              key={row.action}
              className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-3 border-b border-border pb-1.5 last:border-b-0"
            >
              <dt className="flex flex-wrap gap-1 text-text-2">
                {row.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded-sm border border-border-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text"
                  >
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="m-0 text-text-2">{row.action}</dd>
            </div>
          ))}
        </dl>
      </Dialog.Content>
    </Dialog.Root>
  );
}
