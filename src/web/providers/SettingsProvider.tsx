import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyViewMode,
  get,
  getGuardrails,
  getViewMode,
  resetGuardrails as resetStoredGuardrails,
  set,
  setGuardrail as writeGuardrail,
  setViewMode as persistViewMode,
  type GuardrailValues,
  type GuardrailWriteResult,
  type StoredSettings,
  type ViewMode,
} from "../lib/settings.ts";
import { resetAll } from "../lib/theme.ts";

export interface SettingsContextValue {
  viewMode: ViewMode;
  responseLimit: number;
  contextBasis: string;
  showEventRows: boolean;
  groupByProject: boolean;
  sessionTree: boolean;
  guardrails: GuardrailValues;
  guardrailsExpanded: boolean;
  guardrailsCollapsed: boolean;
  setViewMode(mode: string): ViewMode;
  setContextBasis(value: string): string;
  setResponseLimit(value: number): void;
  setShowEventRows(value: boolean): void;
  setGroupByProject(value: boolean): void;
  setSessionTree(value: boolean): void;
  setGuardrailsExpanded(value: boolean): void;
  setGuardrailsCollapsed(value: boolean): void;
  setGuardrail(key: string, value: unknown): GuardrailWriteResult;
  resetGuardrails(): GuardrailValues;
  /** Clears every stored preference and returns the document to Auto + Basic. */
  resetSettings(): void;
}

type SettingSnapshot = Pick<
  StoredSettings,
  | "viewMode"
  | "responseLimit"
  | "contextBasis"
  | "showEventRows"
  | "groupByProject"
  | "sessionTree"
  | "guardrailsExpanded"
  | "guardrailsCollapsed"
>;

const SettingsContext = createContext<SettingsContextValue | null>(null);

function readSnapshot(): SettingSnapshot {
  return {
    viewMode: getViewMode(),
    responseLimit: get("responseLimit"),
    // A hand-edited store can hold any string; the renderer only ever reads the
    // two documented bases (`app.js:2468`).
    contextBasis: get("contextBasis") === "cumulative" ? "cumulative" : "latest",
    showEventRows: get("showEventRows"),
    groupByProject: get("groupByProject"),
    sessionTree: get("sessionTree"),
    // The two keys are aliases kept in sync; either saying "expanded" wins so a
    // stale single-key write cannot hide warnings the user asked to see.
    guardrailsExpanded:
      get("guardrailsExpanded") === true || get("guardrailsCollapsed") === false,
    guardrailsCollapsed: get("guardrailsCollapsed"),
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingSnapshot>(readSnapshot);
  const [guardrails, setGuardrailValues] = useState<GuardrailValues>(
    getGuardrails,
  );

  useEffect(() => {
    // Mirrors the legacy boot application; safe to run twice.
    applyViewMode(settings.viewMode);
  }, [settings.viewMode]);

  const update = useCallback(
    <K extends keyof SettingSnapshot>(key: K, value: SettingSnapshot[K]) => {
      setSettings((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const changeViewMode = useCallback((mode: string) => {
    const next = persistViewMode(mode);
    setSettings((previous) => ({ ...previous, viewMode: next }));
    return next;
  }, []);

  const changeResponseLimit = useCallback(
    (value: number) => {
      set("responseLimit", value);
      update("responseLimit", value);
    },
    [update],
  );

  const changeContextBasis = useCallback(
    (value: string) => {
      // The renderer only ever reads `latest` or `cumulative` (`app.js:2468`);
      // anything else is normalised on read so a hand-edited store cannot
      // produce a third basis.
      const next = value === "cumulative" ? "cumulative" : "latest";
      set("contextBasis", next);
      update("contextBasis", next);
      return next;
    },
    [update],
  );

  const changeShowEventRows = useCallback(
    (value: boolean) => {
      set("showEventRows", value);
      update("showEventRows", value);
    },
    [update],
  );

  const changeGroupByProject = useCallback(
    (value: boolean) => {
      set("groupByProject", value);
      update("groupByProject", value);
    },
    [update],
  );

  const changeSessionTree = useCallback(
    (value: boolean) => {
      set("sessionTree", value);
      update("sessionTree", value);
    },
    [update],
  );

  const changeGuardrailsExpanded = useCallback(
    (value: boolean) => {
      // The disclosure persists both mirrored keys together (`app.js:4365`).
      set("guardrailsExpanded", value);
      set("guardrailsCollapsed", !value);
      setSettings((previous) => ({
        ...previous,
        guardrailsExpanded: value,
        guardrailsCollapsed: !value,
      }));
    },
    [],
  );

  const changeGuardrailsCollapsed = useCallback(
    (value: boolean) => {
      set("guardrailsCollapsed", value);
      set("guardrailsExpanded", !value);
      setSettings((previous) => ({
        ...previous,
        guardrailsCollapsed: value,
        guardrailsExpanded: !value,
      }));
    },
    [],
  );

  const changeGuardrail = useCallback((key: string, value: unknown) => {
    const result = writeGuardrail(key, value);
    if (result.ok) setGuardrailValues(getGuardrails());
    return result;
  }, []);

  const resetGuardrails = useCallback(() => {
    const restored = resetStoredGuardrails();
    setGuardrailValues(restored);
    return restored;
  }, []);

  const resetSettings = useCallback(() => {
    resetAll();
    setSettings(readSnapshot());
    setGuardrailValues(getGuardrails());
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      ...settings,
      guardrails,
      setViewMode: changeViewMode,
      setContextBasis: changeContextBasis,
      setResponseLimit: changeResponseLimit,
      setShowEventRows: changeShowEventRows,
      setGroupByProject: changeGroupByProject,
      setSessionTree: changeSessionTree,
      setGuardrailsExpanded: changeGuardrailsExpanded,
      setGuardrailsCollapsed: changeGuardrailsCollapsed,
      setGuardrail: changeGuardrail,
      resetGuardrails,
      resetSettings,
    }),
    [
      settings,
      guardrails,
      changeViewMode,
      changeContextBasis,
      changeResponseLimit,
      changeShowEventRows,
      changeGroupByProject,
      changeSessionTree,
      changeGuardrailsExpanded,
      changeGuardrailsCollapsed,
      changeGuardrail,
      resetGuardrails,
      resetSettings,
    ],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings must be used inside SettingsProvider");
  }
  return context;
}
