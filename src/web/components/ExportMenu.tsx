import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import {
  EXPORT_ITEMS,
  EXPORT_NOTE,
  type ExportKind,
} from "../lib/copy.ts";
import { useFocusReturn } from "../hooks/useFocusReturn.ts";

export { EXPORT_ITEMS, EXPORT_NOTE, type ExportKind };

export interface ExportMenuProps {
  /**
   * Phase 6 replaces this stub with `useExport`; the menu contract stays. The
   * caller receives the chosen kind so it can report what happened.
   */
  onExport(kind: ExportKind): void;
  note?: string;
}

/**
 * The legacy export disclosure (`src/ui/index.html:48-56`) as a real menu: one
 * button with `aria-haspopup`/`aria-expanded`, `menuitem` buttons, Escape and
 * outside-click dismissal, focus returned to the opener.
 *
 * All three items render; their actions are stubs until Phase 6, so nothing here
 * produces an export.
 */
export function ExportMenu({ onExport, note = EXPORT_NOTE }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useFocusReturn(open);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className={clsx(
          "flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-[12.5px] text-text",
          "hover:border-border-strong",
        )}
      >
        Export
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Export"
          className="absolute right-0 z-20 mt-1 w-[220px] rounded-sm border border-border floating-frost p-1 shadow-float"
        >
          {EXPORT_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExport(item.id);
              }}
              className="block w-full rounded-sm px-2 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
            >
              {item.label}
            </button>
          ))}
          <p className="m-0 border-t border-border px-2 pt-1.5 pb-1 text-[11px] text-muted">
            {note}
          </p>
        </div>
      ) : null}
    </div>
  );
}
