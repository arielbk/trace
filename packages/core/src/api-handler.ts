import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { resolveDocTitle } from "./display-title.ts";
import { renderMarkdown, toggleTaskListCheckbox } from "./markdown.ts";
import { openTraceStore, resolveTaskDocsDir } from "./store.ts";
import type { AddTaskDocOptions } from "./types.ts";

export type TraceApiResponse = {
  status: number;
  body: string;
  contentType?: string;
  /** Extra response headers applied verbatim by {@link writeTraceApiResponse}. */
  headers?: Record<string, string>;
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
  body?: string,
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

    const checkboxMatch = /^\/api\/tasks\/([^/]+)\/docs\/checkbox\/?$/.exec(
      path,
    );
    if (checkboxMatch?.[1]) {
      if (method !== "POST") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        const task = store.getTaskByRef(decodeURIComponent(checkboxMatch[1]));
        if (!task) return notFound();
        return toggleTaskDocCheckbox(databasePath, task.slug, body);
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

        // Carry the registered doc's explicit title/description (if any) into
        // the read so the title resolver can prefer them over a parsed H1.
        const resolvedReq = resolveInBoundsDocPath(
          databasePath,
          task.slug,
          docPath,
        );
        const docMeta = resolvedReq
          ? store
              .listDocsForTask(task.id)
              .find(
                (doc) =>
                  resolveInBoundsDocPath(databasePath, task.slug, doc.path) ===
                  resolvedReq,
              )
          : undefined;

        return readTaskDocContents(databasePath, task.slug, docPath, docMeta);
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
  if (response.headers) {
    for (const [name, value] of Object.entries(response.headers)) {
      sink.setHeader(name, value);
    }
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
  docMeta?: AddTaskDocOptions,
): TraceApiResponse {
  const resolved = resolveInBoundsDocPath(databasePath, taskSlug, docPath);
  if (!resolved) {
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

  // Resolve the display title server-side (explicit title → first H1 →
  // filename) where the raw markdown is in hand, and carry it plus the
  // description to the viewer as url-encoded headers — the body stays the raw
  // rendered doc so the existing content transport is untouched.
  const headers = docDisplayHeaders(docPath, content, docMeta);

  const extension = extname(resolved).toLowerCase();
  if (extension === ".md") {
    return {
      status: 200,
      body: renderMarkdown(content),
      contentType: "text/html",
      headers,
    };
  }

  return {
    status: 200,
    body: content,
    contentType: DOC_TEXT_CONTENT_TYPES[extension] ?? "text/plain",
    headers,
  };
}

/**
 * Build the `X-Doc-Title`/`X-Doc-Description` headers for a doc read. The title
 * is always present (the resolver's filename floor guarantees it); the
 * description rides along only when the doc was registered with one. Values are
 * url-encoded so arbitrary text survives the header transport.
 */
function docDisplayHeaders(
  docPath: string,
  content: string,
  docMeta?: AddTaskDocOptions,
): Record<string, string> {
  const title = resolveDocTitle({ path: docPath, title: docMeta?.title }, content);
  const headers: Record<string, string> = {
    "x-doc-title": encodeURIComponent(title),
  };
  const description = docMeta?.description?.trim();
  if (description) {
    headers["x-doc-description"] = encodeURIComponent(description);
  }
  return headers;
}

/**
 * Resolve `docPath` against the task's docs directory, returning the absolute
 * path or `null` if it escapes that directory. The single guard against path
 * traversal (and against out-of-bounds registered doc paths) shared by the
 * read-only viewer and the checkbox writer.
 */
function resolveInBoundsDocPath(
  databasePath: string,
  taskSlug: string,
  docPath: string,
): string | null {
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  const resolved = resolve(docsDir, docPath);
  return resolved.startsWith(docsDir + sep) ? resolved : null;
}

/**
 * Apply a checkbox toggle to a task doc: read the in-bounds `.md`, flip the Nth
 * task-list marker via {@link toggleTaskListCheckbox}, and write it back. An
 * out-of-range index is a safe no-op (the unchanged content is written). The
 * body must be JSON `{ path: string, index: integer, checked: boolean }`.
 */
function toggleTaskDocCheckbox(
  databasePath: string,
  taskSlug: string,
  body: string | undefined,
): TraceApiResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    return badRequest("Request body must be JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    return badRequest("Body requires { path, index, checked }");
  }
  const { path: docPath, index, checked } = parsed as Record<string, unknown>;
  if (
    typeof docPath !== "string" ||
    !Number.isInteger(index) ||
    typeof checked !== "boolean"
  ) {
    return badRequest("Body requires { path, index, checked }");
  }

  const resolved = resolveInBoundsDocPath(databasePath, taskSlug, docPath);
  if (!resolved) {
    return badRequest("Doc path is outside the task's docs directory");
  }

  let content: string;
  try {
    content = readFileSync(resolved, "utf8");
  } catch {
    return notFound();
  }

  const updated = toggleTaskListCheckbox(content, index as number, checked);
  try {
    writeFileSync(resolved, updated);
  } catch {
    return { status: 500, body: "Doc could not be written" };
  }

  return json({ ok: true });
}
