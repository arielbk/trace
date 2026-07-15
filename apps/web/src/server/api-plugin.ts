import type { Plugin } from "vite";
import {
  handleTraceApiRequest,
  resolveDatabasePath,
  writeTraceApiResponse,
} from "@trace/core";

export function traceApiPlugin(): Plugin {
  return {
    name: "trace-api",
    configureServer(server) {
      // Mount unscoped so the shared handler sees the full `/api/...` path and
      // routes identically to the standalone `trace serve` server.
      server.middlewares.use((req, res, next) => {
        const method = req.method ?? "GET";

        const dispatch = (body?: string): void => {
          const response = handleTraceApiRequest(
            resolveDatabasePath(process.env),
            method,
            req.url ?? "/",
            body,
            { syncServerConfigured: Boolean(process.env.TRACE_SERVER_URL) },
          );
          if (!response) {
            next();
            return;
          }
          writeTraceApiResponse(res, response);
        };

        // Buffer the body only for payload-carrying methods, and only when
        // `req` is a real stream (tests drive a bare {method,url} object).
        const mayHaveBody =
          method === "POST" || method === "PUT" || method === "PATCH";
        if (mayHaveBody && typeof req.on === "function") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () =>
            dispatch(Buffer.concat(chunks).toString("utf8")),
          );
          req.on("error", () => dispatch(""));
        } else {
          dispatch();
        }
      });
    },
  };
}
