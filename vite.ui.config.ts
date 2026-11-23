import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Build lane for the browser UI.
 *
 * The local HTTP server (see `vite.server.config.ts`) resolves the React UI from
 * `dist-ui/`; the artifact is committed and CI fails when it is stale. The HTML
 * entry lives in `src/web/`, which is also the Vite project root, so asset
 * URLs are emitted relative to the served prefix:
 *
 * - `base` is `/ui/` because `src/server/http.ts` serves hashed assets from the
 *   UI root under `/ui/*` and only `GET /` returns `index.html`.
 * - Sourcemaps stay off: `dist-server` has none, and `.map` would otherwise be
 *   served next to the assets.
 * - `outDir` sits outside the project root (`src/web/`), hence `emptyOutDir`.
 * - `@tailwindcss/vite` compiles `src/web/styles/index.css` (the `@theme` token
 *   bridge) and scans `src/web/**` for the utilities it emits.
 *
 * This lane shares nothing with `vite.tui.config.ts` (Solid, host-provided) or
 * `vite.server.config.ts` (SSR bundle).
 */
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist-ui", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
