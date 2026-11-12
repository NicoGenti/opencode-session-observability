import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * Build lane for the local HTTP server shipped in the npm package.
 *
 * Node ≥22.18 refuses to type-strip files under `node_modules`, so the shipped
 * server cannot run as `src/server/index.*`. This lane produces a single
 * node-runnable ESM file, `dist-server/server.mjs`, that the bin shim and the
 * TUI warm-up prefer over the TypeScript source.
 *
 * Every npm package import is bundled; only Node builtins stay external. The
 * bundle targets the package's engine floor (Node 22). Two build-time rewrites
 * keep the artifact self-contained:
 *
 * - `http.ts` anchors the static UI at `src/ui/`, one level up from `src/server/`.
 *   The bundle lives in `dist-server/`, so its anchor is `../src/ui/`; `src/` is
 *   part of the package `files` whitelist, so the directory ships unchanged.
 * - `sqlite-worker-source.ts` starts a worker from `./sqlite-worker.ts` next to
 *   itself. The artifact has no sibling modules, so the worker (and the SQLite
 *   adapter it imports) is pre-bundled here into an inline data: URL.
 */

const SERVER_ENTRY = fileURLToPath(new URL("./src/server/index.ts", import.meta.url));
const WORKER_ENTRY = fileURLToPath(
  new URL("./src/core/adapters/sqlite-worker.ts", import.meta.url),
);

const NODE_BUILTIN = (id: string): boolean =>
  id.startsWith("node:") || builtinModules.includes(id);

const UI_ROOT_HREF = 'new URL("../ui/", import.meta.url)';
const BUNDLED_UI_ROOT_HREF = 'new URL("../src/ui/", import.meta.url)';

const WORKER_CONSTRUCTOR =
  'new Worker(new URL("./sqlite-worker.ts", import.meta.url))';

/** Bundles the worker entry into one self-contained ES module source string. */
async function bundleWorkerSource(): Promise<string> {
  const { build } = await import("vite");
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      emptyOutDir: false,
      ssr: WORKER_ENTRY,
      outDir: "dist-server-worker",
      target: "node22",
      minify: false,
      sourcemap: false,
      rollupOptions: {
        external: NODE_BUILTIN,
        output: { format: "es", codeSplitting: false },
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === "chunk") return chunk.code;
    }
  }
  throw new Error("build:server: the SQLite worker bundle produced no chunk");
}

function bundleRewrites(workerSource: string): Plugin {
  const workerDataUrl = `data:text/javascript;base64,${Buffer.from(workerSource, "utf8").toString("base64")}`;
  return {
    name: "observability-server-bundle",
    enforce: "pre",
    transform(code, id) {
      const normalized = id.replace(/\\/g, "/");
      if (normalized.endsWith("/src/core/adapters/sqlite-worker-source.ts")) {
        if (!code.includes(WORKER_CONSTRUCTOR)) {
          throw new Error(
            `build:server: expected the worker constructor in ${normalized}`,
          );
        }
        return {
          code: code.replace(
            WORKER_CONSTRUCTOR,
            `new Worker(new URL(${JSON.stringify(workerDataUrl)}))`,
          ),
          map: null,
        };
      }
      if (normalized.endsWith("/src/server/http.ts")) {
        if (!code.includes(UI_ROOT_HREF)) {
          throw new Error(`build:server: expected the UI root anchor in ${normalized}`);
        }
        return { code: code.replace(UI_ROOT_HREF, BUNDLED_UI_ROOT_HREF), map: null };
      }
      return null;
    },
  };
}

export default defineConfig(async () => {
  const workerSource = await bundleWorkerSource();
  return {
    plugins: [bundleRewrites(workerSource)],
    ssr: { noExternal: true },
    build: {
      ssr: SERVER_ENTRY,
      outDir: "dist-server",
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      target: "node22",
      rollupOptions: {
        external: NODE_BUILTIN,
        output: {
          format: "es",
          codeSplitting: false,
          entryFileNames: "server.mjs",
        },
      },
    },
  };
});
