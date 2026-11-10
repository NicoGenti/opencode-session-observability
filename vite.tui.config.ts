import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * Build lane for the OpenCode TUI part.
 *
 * The TUI host provides OpenTUI, Solid and the OpenCode SDK at runtime, so they
 * stay external: the artifact only carries this plugin's own code. JSX compiles
 * to the OpenTUI Solid runtime (universal output) instead of the DOM runtime.
 */
const HOST_PROVIDED =
  /^(?:@opentui\/|@opencode\/(?:plugin|theme)(?:\/|$)|solid-js(?:\/|$))/;

function isHostProvided(id: string): boolean {
  if (id.startsWith("node:")) return true;
  if (builtinModules.includes(id)) return true;
  return HOST_PROVIDED.test(id);
}

export default defineConfig({
  plugins: [
    solid({
      exclude: [/[\\/]node_modules[\\/]/],
      solid: {
        generate: "universal",
        moduleName: "@opentui/solid",
      },
    }),
  ],
  build: {
    outDir: "dist-tui",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: "esnext",
    lib: {
      entry: fileURLToPath(new URL("./src/plugin/tui.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "tui.mjs",
    },
    rollupOptions: {
      external: isHostProvided,
      output: { format: "es", inlineDynamicImports: true },
    },
  },
});
