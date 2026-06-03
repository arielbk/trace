import type { Plugin } from "vite";
import { handleTraceApiRequest, writeTraceApiResponse } from "@trace/core";
import { getDatabasePath } from "./data.ts";

export function traceApiPlugin(): Plugin {
  return {
    name: "trace-api",
    configureServer(server) {
      // Mount unscoped so the shared handler sees the full `/api/...` path and
      // routes identically to the standalone `trace serve` server.
      server.middlewares.use((req, res, next) => {
        const response = handleTraceApiRequest(
          getDatabasePath(),
          req.method ?? "GET",
          req.url ?? "/",
        );
        if (!response) {
          next();
          return;
        }
        writeTraceApiResponse(res, response);
      });
    },
  };
}
