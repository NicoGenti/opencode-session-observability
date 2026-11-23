import { useCallback } from "react";
import type { EventIndexEntry, NormalizedEvent, SessionSummary } from "../../core/types.ts";
import { responseError, type ApiFn } from "../lib/api.ts";
import type { ConfirmController } from "../lib/confirm.ts";
import {
  REVEAL_COPY_WARNING,
  TOAST,
  digestToastMessage,
  exportRequestPath,
  exportToastMessage,
  metricsLine,
  resolveExportTarget,
  safeDownloadName,
  sessionExportName,
  turnChainText,
  type ExportFormat,
  type ExportTarget,
} from "../lib/export.ts";
import type { ToastController } from "../lib/toast.ts";

/** The session page the resolved list is read from; the server clamps at 1000. */
const SESSION_LIST_LIMIT = 1000;

export interface UseExportOptions {
  api: ApiFn;
  toast: ToastController;
  confirm: ConfirmController;
  /** The loaded session list; the export target is resolved against it. */
  sessions: readonly SessionSummary[];
  /** The selected session id — only ever a lookup key. */
  sessionID: string | null;
  token(): string | null;
  reveal(): boolean;
  /** Surfaces a request failure in the global error banner. */
  onError(message: string, error?: unknown): void;
}

export interface UseExportResult {
  exportSession(format: ExportFormat): Promise<void>;
  copyDigest(options: { prompt: boolean }): Promise<void>;
  /** Copies arbitrary text and reports the given confirmation. */
  copy(text: string, success: string): Promise<void>;
  copyMetrics(event: NormalizedEvent | null | undefined): Promise<void>;
  copyTurnChain(
    event: NormalizedEvent | null | undefined,
    events: readonly EventIndexEntry[],
  ): Promise<void>;
  /** Exposed for the tests and the drawer's JSON/text actions. */
  resolveTarget(): Promise<ExportTarget | null>;
}

/** The clipboard write with the legacy `execCommand` fallback (`format.js:178-198`). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/**
 * The download anchor (`format.js:227-239`): the name is re-checked at the sink
 * with the same allowlist the caller used, and the anchor is never inserted into
 * the document.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeDownloadName(filename);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function authHeader(token: string | null): Record<string, string> {
  const value = typeof token === "string" ? token.trim() : "";
  return value ? { Authorization: `Bearer ${value}` } : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Export, digest copy and the drawer copy actions (`app.js:3027-3120`,
 * `:2801-2863`).
 *
 * Every request resolves its target through the server's own session list first
 * (`resolveExportTarget`), so the selected id — which arrives from the document
 * location — never reaches a request path or a download name. The request is a
 * root-relative `fetch` with the session token and the current reveal state;
 * `api()` cannot be used because the responses are text, not JSON.
 */
export function useExport(options: UseExportOptions): UseExportResult {
  const { api, toast, confirm, sessions, sessionID, token, reveal, onError } = options;

  const refreshList = useCallback(async (): Promise<readonly SessionSummary[]> => {
    const data = await api<{ sessions?: SessionSummary[] }>("/api/sessions", {
      limit: SESSION_LIST_LIMIT,
    });
    return Array.isArray(data.sessions) ? data.sessions : [];
  }, [api]);

  const resolveTarget = useCallback(
    () =>
      resolveExportTarget(sessionID, {
        sessions,
        refresh: refreshList,
        notify: toast.show,
      }),
    [refreshList, sessionID, sessions, toast],
  );

  const requestText = useCallback(
    async (path: string): Promise<string> => {
      const response = await fetch(path, {
        cache: "no-store",
        headers: authHeader(token()),
      });
      if (!response.ok) {
        throw await responseError(
          response,
          `Request failed (${response.status})`,
        );
      }
      return response.text();
    },
    [token],
  );

  const copy = useCallback(
    async (text: string, success: string): Promise<void> => {
      const copied = await copyText(text);
      toast.show(copied ? success : TOAST.copyFailed);
    },
    [toast],
  );

  const exportSession = useCallback(
    async (format: ExportFormat): Promise<void> => {
      if (!sessionID) return;
      try {
        const target = await resolveTarget();
        if (!target) return;
        const path = exportRequestPath(target.id, {
          format,
          includeEvents: true,
          reveal: reveal(),
        });
        const response = await fetch(path, {
          cache: "no-store",
          headers: authHeader(token()),
        });
        if (!response.ok) {
          throw await responseError(
            response,
            `Export failed (${response.status})`,
          );
        }
        const blob = await response.blob();
        // Named from the record the request was resolved against — read once, so
        // a route change during the awaits cannot pair one session's bytes with
        // another session's name.
        downloadBlob(safeDownloadName(sessionExportName(target.record, format)), blob);
        toast.show(exportToastMessage(reveal()));
      } catch (error) {
        onError(messageOf(error), error);
      }
    },
    [onError, resolveTarget, reveal, sessionID, toast, token],
  );

  const copyDigest = useCallback(
    async ({ prompt }: { prompt: boolean }): Promise<void> => {
      if (!sessionID) return;
      const unredacted = reveal();
      try {
        if (unredacted) {
          const confirmed = await confirm.request({
            title: REVEAL_COPY_WARNING.title,
            message: REVEAL_COPY_WARNING.message,
            acceptLabel: REVEAL_COPY_WARNING.acceptLabel,
          });
          if (!confirmed) return;
        }
        const target = await resolveTarget();
        if (!target) return;
        const path = exportRequestPath(target.id, {
          format: "digest",
          prompt,
          reveal: unredacted,
        });
        const text = await requestText(path);
        const copied = await copyText(text);
        toast.show(
          copied ? digestToastMessage(prompt, unredacted) : TOAST.clipboardBlocked,
        );
      } catch (error) {
        onError(messageOf(error), error);
      }
    },
    [confirm, onError, requestText, resolveTarget, reveal, sessionID, toast],
  );

  const copyMetrics = useCallback(
    async (event: NormalizedEvent | null | undefined): Promise<void> => {
      if (!event) return;
      await copy(metricsLine(event), TOAST.metricsCopied);
    },
    [copy],
  );

  const copyTurnChain = useCallback(
    async (
      event: NormalizedEvent | null | undefined,
      events: readonly EventIndexEntry[],
    ): Promise<void> => {
      if (!event) return;
      const text = turnChainText(event, events);
      if (text === null) {
        toast.show(TOAST.noTurnAttribution);
        return;
      }
      await copy(text, TOAST.turnChainCopied);
    },
    [copy, toast],
  );

  return { exportSession, copyDigest, copy, copyMetrics, copyTurnChain, resolveTarget };
}
