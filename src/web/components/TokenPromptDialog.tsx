import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState, type FormEvent } from "react";
import { TOKEN_PROMPT_COPY, type TokenPromptCopy } from "../lib/auth.ts";

export interface TokenPromptDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(token: string): void;
  copy?: TokenPromptCopy;
}

/**
 * The themed token dialog that replaces the legacy `window.prompt` fallback.
 *
 * Radix Dialog owns the behaviour the design contract requires: `role="dialog"`
 * + `aria-modal`, a focus trap, `Esc` to close, and focus returned to the opener.
 * The token input is the first focusable control, `Enter` submits, and the value
 * is never echoed anywhere but the caller's `onSubmit`.
 */
export function TokenPromptDialog({
  open,
  onOpenChange,
  onSubmit,
  copy = TOKEN_PROMPT_COPY,
}: TokenPromptDialogProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setValue("");
      setError(null);
    }
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      setError(copy.invalidMessage);
      return;
    }
    setValue("");
    setError(null);
    onSubmit(token);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text/40 frosted-scrim" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border floating-frost p-5 text-text shadow-float">
          <Dialog.Title className="text-[14px] font-semibold">
            {copy.title}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-[1.5] text-text-2">
            {copy.description}
          </Dialog.Description>
          <form className="mt-4 grid gap-3" onSubmit={submit} noValidate>
            <label className="grid gap-1 text-[12px] font-semibold" htmlFor="token-prompt-input">
              {copy.label}
            </label>
            <input
              id="token-prompt-input"
              autoComplete="off"
              autoFocus
              placeholder={copy.placeholder}
              spellCheck={false}
              type="password"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
              className="w-full rounded-sm border border-border-strong bg-surface-2 px-2.5 py-1.5 text-[13px] text-text"
            />
            {error ? (
              <p className="text-[12px] text-critical" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mt-1 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-[12.5px] text-text-2"
                >
                  {copy.cancelLabel}
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className="rounded-sm bg-accent px-2.5 py-1 text-[12.5px] text-page"
              >
                {copy.submitLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
