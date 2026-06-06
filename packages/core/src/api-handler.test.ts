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

test("GET /api/tasks/:id/timeline includes the task description when present", () => {
  let withId = "";
  let withoutId = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    withId = store.createTask(
      "checkout",
      undefined,
      "Rework the checkout into a multi-step wizard",
    ).id;
    withoutId = store.createTask("billing").id;
  });

  try {
    const withResponse = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${withId}/timeline`,
    );
    const withTimeline = JSON.parse(withResponse!.body);
    expect(withTimeline.task.description).toBe(
      "Rework the checkout into a multi-step wizard",
    );

    // A description-less task carries no description key, not null.
    const withoutResponse = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${withoutId}/timeline`,
    );
    const withoutTimeline = JSON.parse(withoutResponse!.body);
    expect("description" in withoutTimeline.task).toBe(false);
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

test("POST /api/tasks/:ref/archive archives the task and returns it", () => {
  let taskId = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskId = store.createTask("checkout").id;
  });

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskId}/archive`,
    );
    expect(response!.status).toBe(200);
    expect(response!.contentType).toBe("application/json");
    const task = JSON.parse(response!.body);
    expect(task.id).toBe(taskId);
    expect(task.archivedAt).not.toBeNull();
  } finally {
    cleanup();
  }
});

test("POST /api/tasks/:ref/unarchive clears archivedAt", () => {
  let taskId = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskId = store.createTask("checkout").id;
    store.archiveTask(taskId);
  });

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskId}/unarchive`,
    );
    expect(response!.status).toBe(200);
    const task = JSON.parse(response!.body);
    expect(task.archivedAt).toBeNull();
  } finally {
    cleanup();
  }
});

test("archive routes reject non-POST methods", () => {
  let taskId = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskId = store.createTask("checkout").id;
  });

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskId}/archive`,
    );
    expect(response!.status).toBe(405);
  } finally {
    cleanup();
  }
});

test("POST /api/tasks/:ref/archive returns 404 for an unknown task", () => {
  const { databasePath, cleanup } = withSeededDatabase(() => {});

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "POST",
      "/api/tasks/does-not-exist/archive",
    );
    expect(response!.status).toBe(404);
  } finally {
    cleanup();
  }
});

test("GET /api/config returns { home } as JSON with status 200", () => {
  const { databasePath, cleanup } = withSeededDatabase(() => {});

  try {
    const response = handleTraceApiRequest(databasePath, "GET", "/api/config");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.contentType).toBe("application/json");
    const config = JSON.parse(response!.body);
    expect(typeof config.home).toBe("string");
    expect(config.home.length).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("non-GET /api/config is rejected with 405", () => {
  const { databasePath, cleanup } = withSeededDatabase(() => {});

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "POST",
      "/api/config",
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(405);
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
