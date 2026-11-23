import { useEffect, useRef } from "react";
import {
  resolveShortcut,
  type ShortcutCommand,
  type ShortcutState,
  type ShortcutTarget,
} from "../lib/shortcuts.ts";

export * from "../lib/shortcuts.ts";

/** Maps a DOM event target onto the suppression vocabulary. */
export function shortcutTarget(target: EventTarget | null): ShortcutTarget {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return "other";
  const element = target as HTMLElement;
  if (element.isContentEditable === true) return "contenteditable";
  const tag = element.tagName;
  if (tag === "INPUT") return "input";
  if (tag === "TEXTAREA") return "textarea";
  if (tag === "SELECT") return "select";
  return "other";
}

/**
 * Binds the pure decision function to one window listener. The listener is
 * registered once; the latest state and command handler are read through refs,
 * so re-renders never stack listeners and StrictMode's mount/unmount/mount
 * cycle leaves exactly one.
 */
export function useKeyboardShortcuts(
  getState: () => Omit<ShortcutState, "target">,
  onCommand: (command: ShortcutCommand) => void,
): void {
  const stateRef = useRef(getState);
  const commandRef = useRef(onCommand);
  stateRef.current = getState;
  commandRef.current = onCommand;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = resolveShortcut(event, {
        ...stateRef.current(),
        target: shortcutTarget(event.target),
      });
      if (!command) return;
      if (command.preventDefault) event.preventDefault();
      commandRef.current(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
