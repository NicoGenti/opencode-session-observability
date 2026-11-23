import { useEffect } from "react";

/**
 * Returns focus to the control that opened a surface when it closes
 * (`docs/UI.md:332`). Radix dialogs already do this for their own content; this
 * hook is for the surfaces Radix does not own, starting with the export menu.
 *
 * The opener is captured when `open` turns true and restored when it turns
 * false or the component unmounts. A disconnected opener is skipped, so closing
 * a menu after its trigger was re-rendered cannot steal focus to `<body>`.
 */
export function useFocusReturn(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const opener =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);
}
