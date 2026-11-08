import { parentPort } from "node:worker_threads";
import {
  DatabaseBusyError,
  SqliteSource,
  UnsupportedSchemaError,
} from "./sqlite.ts";

interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

const port = parentPort;
if (!port) throw new Error("sqlite worker requires a parent port");

let source: SqliteSource | null = null;

port.on("message", async (message: WorkerRequest) => {
  const { id, method, args } = message;
  try {
    if (method === "init") {
      source = new SqliteSource(String(args[0]));
      port.postMessage({ id, ok: true, value: true });
      return;
    }
    if (method === "close") {
      source?.close();
      source = null;
      port.postMessage({ id, ok: true, value: true });
      return;
    }
    if (!source) throw new Error("sqlite source is not initialized");
    const value = await (
      source as unknown as Record<string, (...params: unknown[]) => Promise<unknown>>
    )[method]!(...args);
    port.postMessage({ id, ok: true, value });
  } catch (error) {
    const name =
      error instanceof DatabaseBusyError
        ? "DatabaseBusyError"
        : error instanceof UnsupportedSchemaError
          ? "UnsupportedSchemaError"
          : error instanceof Error
            ? error.name
            : "Error";
    port.postMessage({
      id,
      ok: false,
      error: {
        name,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
