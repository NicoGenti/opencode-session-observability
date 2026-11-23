import { useCallback, useRef, useState } from "react";
import { TOKEN_PROMPT_COPY, type TokenPromptCopy } from "../lib/auth.ts";

export interface TokenPromptOptions {
  title?: string;
  description?: string;
}

export interface TokenPromptController {
  /** Opens the dialog and resolves with the entered token, or `null` on cancel. */
  requestToken(options?: TokenPromptOptions): Promise<string | null>;
  open: boolean;
  copy: TokenPromptCopy;
  onOpenChange(open: boolean): void;
  onSubmit(token: string): void;
}

/**
 * Promise-based replacement for the legacy `window.prompt` token fallback.
 *
 * Spread the controller onto `TokenPromptDialog`:
 *
 * ```tsx
 * const tokenPrompt = useTokenPrompt();
 * const token = await tokenPrompt.requestToken();
 * // <TokenPromptDialog {...tokenPrompt} />
 * ```
 *
 * A second `requestToken` while a prompt is open resolves the first one with
 * `null` instead of stacking dialogs, so callers never hang.
 */
export function useTokenPrompt(options?: TokenPromptOptions): TokenPromptController {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<TokenPromptCopy>(() => ({
    ...TOKEN_PROMPT_COPY,
    ...(options?.title ? { title: options.title } : {}),
    ...(options?.description ? { description: options.description } : {}),
  }));
  const resolver = useRef<((value: string | null) => void) | null>(null);

  const resolveCurrent = useCallback((value: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const requestToken = useCallback((next?: TokenPromptOptions) => {
    if (next?.title || next?.description) {
      setCopy((previous) => ({
        ...previous,
        ...(next.title ? { title: next.title } : {}),
        ...(next.description ? { description: next.description } : {}),
      }));
    }
    // A superseded prompt settles instead of leaking a pending promise.
    resolver.current?.(null);
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resolveCurrent(null);
    },
    [resolveCurrent],
  );

  const onSubmit = useCallback(
    (token: string) => {
      resolveCurrent(token);
    },
    [resolveCurrent],
  );

  return { requestToken, open, copy, onOpenChange, onSubmit };
}
