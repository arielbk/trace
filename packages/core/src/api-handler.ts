import { openTraceStore } from "./store.ts";

export type TraceApiResponse = {
  status: number;
  body: string;
  contentType?: string;
};

/**
 * A minimal structural view of a node `http.ServerResponse` (also satisfied by
 * Connect/Vite's response object). Lets `writeTraceApiResponse` apply a
 * framework-agnostic {@link TraceApiResponse} without `@trace/core` importing
 * `node:http`.
 */
export interface TraceApiResponseSink {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

const JSON_CONTENT_TYPE = "application/json";

/**
 * Framework-agnostic router for the trace web API. Returns a response for any
 * `/api/...` request, or `null` when the request is not an API request — so an
 * HTTP host can fall through to static assets / SPA handling. Shared by the Vite
 * dev middleware and the standalone `trace serve` server so the two never fork.
 */
export function handleTraceApiRequest(
  databasePath: string,
  method: string,
  rawUrl: string,
): TraceApiResponse | null {
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;

  if (path !== "/api/tasks" && !path.startsWith("/api/tasks/")) {
    return path.startsWith("/api/") ? notFound() : null;
  }

  try {
    if (path === "/api/tasks" || path === "/api/tasks/") {
      if (method !== "GET") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        return json(store.listTaskSummaries());
      } finally {
        store.close();
      }
    }

    const match = /^\/api\/tasks\/([^/]+)\/timeline\/?$/.exec(path);
    if (match?.[1]) {
      if (method !== "GET") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        const timeline = store.getTaskTimeline(decodeURIComponent(match[1]));
        return timeline ? json(timeline) : notFound();
      } finally {
        store.close();
      }
    }

    return notFound();
  } catch (error) {
    return {
      status: 500,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Apply a {@link TraceApiResponse} to a node/Connect-style response object. */
export function writeTraceApiResponse(
  sink: TraceApiResponseSink,
  response: TraceApiResponse,
): void {
  sink.statusCode = response.status;
  if (response.contentType) {
    sink.setHeader("content-type", response.contentType);
  }
  sink.end(response.body);
}

function json(payload: unknown): TraceApiResponse {
  return {
    status: 200,
    body: JSON.stringify(payload),
    contentType: JSON_CONTENT_TYPE,
  };
}

function notFound(): TraceApiResponse {
  return { status: 404, body: "" };
}

function methodNotAllowed(): TraceApiResponse {
  return { status: 405, body: "" };
}
