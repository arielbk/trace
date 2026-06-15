import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { renderMarkdown } from "./markdown.ts";
import { openTraceStore, resolveTaskDocsDir } from "./store.ts";

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

  if (path === "/api/config") {
    if (method !== "GET") return methodNotAllowed();
    return json({ home: homedir() });
  }

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

    const archiveMatch = /^\/api\/tasks\/([^/]+)\/(archive|unarchive)\/?$/.exec(
      path,
    );
    if (archiveMatch?.[1] && archiveMatch[2]) {
      if (method !== "POST") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        const ref = decodeURIComponent(archiveMatch[1]);
        const task =
          archiveMatch[2] === "archive"
            ? store.archiveTask(ref)
            : store.unarchiveTask(ref);
        return json(task);
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

    const docsMatch = /^\/api\/tasks\/([^/]+)\/docs\/?$/.exec(path);
    if (docsMatch?.[1]) {
      if (method !== "GET") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        const task = store.getTaskByRef(decodeURIComponent(docsMatch[1]));
        if (!task) return notFound();

        const docPath = new URLSearchParams(rawUrl.split("?", 2)[1] ?? "").get(
          "path",
        );
        if (!docPath) return badRequest("path query parameter is required");

        return readTaskDocContents(databasePath, task.slug, docPath);
      } finally {
        store.close();
      }
    }

    return notFound();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Task not found:")
    ) {
      return { status: 404, body: error.message };
    }
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

function badRequest(message: string): TraceApiResponse {
  return { status: 400, body: message };
}

/** Content types for non-markdown docs, served as raw text. */
const DOC_TEXT_CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".txt": "text/plain",
};

/**
 * Read a task doc for the read-only doc viewer. `docPath` is resolved against
 * the task's docs directory (absolute paths are accepted too) and rejected if
 * it escapes that directory — this is the only guard against path traversal
 * and against docs registered with an out-of-bounds path. `.md` docs are
 * rendered to sanitized HTML; everything else is returned as raw text with a
 * best-effort content type.
 */
function readTaskDocContents(
  databasePath: string,
  taskSlug: string,
  docPath: string,
): TraceApiResponse {
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  const resolved = resolve(docsDir, docPath);

  if (!resolved.startsWith(docsDir + sep)) {
    return badRequest("Doc path is outside the task's docs directory");
  }

  let isFile: boolean;
  try {
    isFile = statSync(resolved).isFile();
  } catch {
    return notFound();
  }

  if (!isFile) {
    return { status: 500, body: "Doc could not be read" };
  }

  let content: string;
  try {
    content = readFileSync(resolved, "utf8");
  } catch {
    return { status: 500, body: "Doc could not be read" };
  }

  const extension = extname(resolved).toLowerCase();
  if (extension === ".md") {
    return { status: 200, body: renderMarkdown(content), contentType: "text/html" };
  }

  return {
    status: 200,
    body: content,
    contentType: DOC_TEXT_CONTENT_TYPES[extension] ?? "text/plain",
  };
}
