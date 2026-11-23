import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { get, migrate, type ThemePalette } from "../lib/settings.ts";
import {
  applyPalette,
  applyTheme,
  getTheme,
  normalizeTheme,
  readPaletteFromHash,
  readThemeFromHash,
  selectServerTheme,
  setTheme as persistTheme,
  themeLabel,
} from "../lib/theme.ts";

export interface ThemeContextValue {
  /** The selection: "auto", "light", "dark", "opencode-current" or a theme id. */
  theme: string;
  /** The sentence-case label for the selection. */
  label: string;
  /** The TUI-supplied palette in effect, when the selection is OpenCode current. */
  palette: ThemePalette | null;
  /** True once the user picked a theme; deep links must never override it. */
  themeUserSet: boolean;
  /**
   * Selects and persists a theme. `userSet: false` mirrors a TUI deep link: it
   * applies the theme without marking it as the user's explicit choice.
   */
  setTheme(theme: string, options?: { userSet?: boolean }): string;
  /** Applies the CLI-selected theme from `/api/health` at boot (`app.js:4666`). */
  applyServerTheme(name: string | null | undefined): void;
}

interface ThemeState {
  theme: string;
  palette: ThemePalette | null;
  themeUserSet: boolean;
  /** The page arrived through a `?theme=` / `?palette=` TUI deep link. */
  linkedTheme: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * The boot selection. The one-time migration runs first, then a `?theme=` /
 * `?palette=` deep link is honored only when the user has not explicitly
 * chosen a theme. No DOM application happens here; the effect below owns that,
 * so a StrictMode double render is harmless.
 */
function readInitialTheme(): ThemeState {
  migrate();
  const themeUserSet = get("themeUserSet") === true;
  const hash = globalThis.location?.hash ?? "";
  const hashTheme = readThemeFromHash(hash);
  const hashPalette = readPaletteFromHash(hash);
  const linkedTheme = Boolean(hashTheme || hashPalette);
  if (!themeUserSet && hashTheme) {
    return { theme: normalizeTheme(hashTheme), palette: hashPalette, themeUserSet, linkedTheme };
  }
  if (!themeUserSet && hashPalette) {
    return { theme: "opencode-current", palette: hashPalette, themeUserSet, linkedTheme };
  }
  return { theme: getTheme(), palette: get("palette"), themeUserSet, linkedTheme };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThemeState>(readInitialTheme);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // Idempotent: applying the same selection twice yields the same document.
    if (state.theme === "opencode-current" && state.palette) {
      applyPalette(state.palette);
      return;
    }
    applyTheme(state.theme);
  }, [state.theme, state.palette]);

  const chooseTheme = useCallback(
    (next: string, options?: { userSet?: boolean }) => {
      const userSet = options?.userSet ?? true;
      const normalized = persistTheme(next, userSet);
      setState((previous) => ({
        theme: normalized,
        palette: normalized === "opencode-current" ? previous.palette : null,
        themeUserSet: userSet ? true : previous.themeUserSet,
        linkedTheme: previous.linkedTheme,
      }));
      return normalized;
    },
    [],
  );

  const applyServerTheme = useCallback((name: string | null | undefined) => {
    const current = stateRef.current;
    const selected = selectServerTheme(name, current);
    if (selected === null) return;
    persistTheme(selected, false);
    setState((previous) =>
      previous.themeUserSet || previous.linkedTheme
        ? previous
        : {
            ...previous,
            theme: selected,
            palette: selected === "opencode-current" ? previous.palette : null,
          },
    );
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: state.theme,
      label: themeLabel(state.theme),
      palette: state.palette,
      themeUserSet: state.themeUserSet,
      setTheme: chooseTheme,
      applyServerTheme,
    }),
    [state, chooseTheme, applyServerTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
