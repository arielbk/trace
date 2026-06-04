import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "@trace/core";
import { traceApiPlugin } from "../server/api-plugin.ts";

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type TestRequest = { method: string; url: string };
type TestHandler = (
  req: TestRequest,
  res: TestResponse,
  next: () => void,
) => void;
type TestPlugin = {
  configureServer(server: {
    middlewares: {
      use(path: string, registered: TestHandler): void;
    };
  }): void;
};

test("task archive endpoint archives by slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-web-api-"));
  const databasePath = join(dir, "trace.sqlite");
  const originalTraceDb = process.env.TRACE_DB;
  process.env.TRACE_DB = databasePath;

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    store.close();

    const response = invokeTasksApi("POST", `/${task.slug}/archive`);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      id: task.id,
      slug: task.slug,
      archivedAt: expect.any(String),
    });
  } finally {
    restoreTraceDb(originalTraceDb);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task unarchive endpoint unarchives by id", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-web-api-"));
  const databasePath = join(dir, "trace.sqlite");
  const originalTraceDb = process.env.TRACE_DB;
  process.env.TRACE_DB = databasePath;

  try {
    const store = openTraceStore(databasePath);
    const task = store.archiveTask(store.createTask("checkout").id);
    store.close();

    const response = invokeTasksApi("POST", `/${task.id}/unarchive`);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      id: task.id,
      archivedAt: null,
    });
  } finally {
    restoreTraceDb(originalTraceDb);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task archive endpoints return 404 for unknown refs and 405 for non-POST", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-web-api-"));
  const databasePath = join(dir, "trace.sqlite");
  const originalTraceDb = process.env.TRACE_DB;
  process.env.TRACE_DB = databasePath;

  try {
    expect(invokeTasksApi("POST", "/missing/archive").statusCode).toBe(404);
    expect(invokeTasksApi("GET", "/missing/archive").statusCode).toBe(405);
    expect(invokeTasksApi("DELETE", "/missing/unarchive").statusCode).toBe(405);
  } finally {
    restoreTraceDb(originalTraceDb);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task list payload includes archivedAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-web-api-"));
  const databasePath = join(dir, "trace.sqlite");
  const originalTraceDb = process.env.TRACE_DB;
  process.env.TRACE_DB = databasePath;

  try {
    const store = openTraceStore(databasePath);
    const task = store.archiveTask(store.createTask("checkout").slug);
    store.close();

    const response = invokeTasksApi("GET", "/");

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([
      {
        id: task.id,
        archivedAt: task.archivedAt,
      },
    ]);
  } finally {
    restoreTraceDb(originalTraceDb);
    rmSync(dir, { recursive: true, force: true });
  }
});

function invokeTasksApi(method: string, url: string): CapturedResponse {
  const plugin = traceApiPlugin() as unknown as TestPlugin;
  let registeredHandler = false;
  let handler: TestHandler = () => {
    throw new Error("API handler was not registered");
  };

  plugin.configureServer({
    middlewares: {
      use(path: string, registered) {
        expect(path).toBe("/api/tasks");
        registeredHandler = true;
        handler = registered;
      },
    },
  });

  if (!registeredHandler) throw new Error("API handler was not registered");

  const response = new TestResponse();
  handler({ method, url }, response, () => {
    response.statusCode = 404;
    response.end();
  });
  return response.capture();
}

class TestResponse {
  statusCode = 200;
  readonly headers: Record<string, string> = {};
  body = "";

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(body = ""): void {
    this.body = body;
  }

  capture(): CapturedResponse {
    return {
      statusCode: this.statusCode,
      headers: this.headers,
      body: this.body,
    };
  }
}

function restoreTraceDb(originalTraceDb: string | undefined): void {
  if (originalTraceDb === undefined) {
    delete process.env.TRACE_DB;
  } else {
    process.env.TRACE_DB = originalTraceDb;
  }
}
