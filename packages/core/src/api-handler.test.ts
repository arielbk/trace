import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "./store.ts";
import { handleTraceApiRequest } from "./api-handler.ts";

function withSeededDatabase(
  seed: (store: ReturnType<typeof openTraceStore>) => void,
): { databasePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "trace-api-handler-"));
  const databasePath = join(dir, "trace.sqlite");
  const store = openTraceStore(databasePath);
  try {
    seed(store);
  } finally {
    store.close();
  }
  return { databasePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("GET /api/tasks returns the live task summaries as JSON", () => {
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    store.createTask("checkout");
  });

  try {
    const response = handleTraceApiRequest(databasePath, "GET", "/api/tasks");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.contentType).toBe("application/json");
    const summaries = JSON.parse(response!.body);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("checkout");
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:id/timeline returns the live timeline as JSON", () => {
  let timelineId = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    const task = store.createTask("checkout");
    timelineId = task.id;
  });

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${timelineId}/timeline`,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.contentType).toBe("application/json");
    const timeline = JSON.parse(response!.body);
    expect(timeline.task.id).toBe(timelineId);
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:id/timeline returns 404 for an unknown task", () => {
  const { databasePath, cleanup } = withSeededDatabase(() => {});

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      "/api/tasks/does-not-exist/timeline",
    );
    expect(response!.status).toBe(404);
  } finally {
    cleanup();
  }
});

test("non-API requests return null so the host can fall through", () => {
  const { databasePath, cleanup } = withSeededDatabase(() => {});

  try {
    expect(handleTraceApiRequest(databasePath, "GET", "/")).toBeNull();
    expect(handleTraceApiRequest(databasePath, "GET", "/tasks/abc")).toBeNull();
  } finally {
    cleanup();
  }
});
