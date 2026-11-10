import {
  PluginContextProvider,
  usePlugin,
  type Plugin,
} from "@opencode/plugin/tui";

import { themePalette } from "../../tui.ts";

type Context = Plugin.Context;

/**
 * Phase 1 placeholder for the native Statistics view. It proves the JSX /
 * OpenTUI toolchain end to end; the data binding lands in phase 2.
 */

/** Subset of the `themePalette` mapping used by the banner. */
type BannerColors = {
  readonly fg: string;
  readonly bg: string;
};

const FALLBACK_COLORS: BannerColors = { fg: "#ffffff", bg: "#000000" };

function bannerColors(context: Context): BannerColors {
  const palette = themePalette(context);
  return {
    fg: palette?.text ?? FALLBACK_COLORS.fg,
    bg: palette?.page ?? FALLBACK_COLORS.bg,
  };
}

function StatisticsBanner() {
  const colors = bannerColors(usePlugin());
  return (
    <box flexDirection="column" padding={1} backgroundColor={colors.bg}>
      <text fg={colors.fg}>
        StatisticsView (phase 1) — data binding lands in phase 2
      </text>
    </box>
  );
}

export function StatisticsView(props: { readonly context: Context }) {
  return (
    <PluginContextProvider value={props.context}>
      <StatisticsBanner />
    </PluginContextProvider>
  );
}

/**
 * Slot render body. The host renders slot claims outside the plugin's own
 * Solid root, so the plugin context is re-provided here.
 */
export function statisticsPanelElement(context: Context) {
  return <StatisticsView context={context} />;
}
