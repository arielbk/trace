import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore, resolveTaskDocsDir } from "./store.ts";
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
  let createdAt = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    const task = store.createTask("checkout");
    timelineId = task.id;
    createdAt = task.createdAt;
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
    expect(timeline.lastActivityAt).toBe(createdAt);
    expect("state" in timeline).toBe(false);
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:id/timeline includes parsed state when state.md exists", () => {
  let timelineId = "";
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    const task = store.createTask("checkout");
    timelineId = task.id;
    taskSlug = task.slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, "state.md"),
    [
      "# Checkout is resumable",
      "",
      "## Decisions made",
      "- Keep parsing in **core**",
      "",
      "## Current state",
      "Endpoint work is `in progress`.",
      "",
      "## Next step",
      "Render the panel.",
    ].join("\n"),
  );

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${timelineId}/timeline`,
    );
    expect(response!.status).toBe(200);
    const timeline = JSON.parse(response!.body);
    expect(timeline.state).toEqual({
      summary: "Checkout is resumable",
      decisions: ["Keep parsing in <strong>core</strong>"],
      currentState: ["<p>Endpoint work is <code>in progress</code>.</p>"],
      nextStep: "<p>Render the panel.</p>",
      openQuestions: [],
    });
    expect(timeline.lastActivityAt).toEqual(expect.any(String));
    expect(timeline.lastActivityAt >= timeline.task.createdAt).toBe(true);
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

test("GET /api/tasks/:ref/docs renders an in-bounds markdown doc as sanitized HTML", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "notes.md");
  writeFileSync(docPath, "# Notes\n\nSome content.");

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(docPath)}`,
    );
    expect(response!.status).toBe(200);
    expect(response!.contentType).toBe("text/html");
    expect(response!.body).toContain("<h1>Notes</h1>");
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs returns raw text and a content type for a non-markdown doc", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "notes.txt");
  writeFileSync(docPath, "plain notes");

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(docPath)}`,
    );
    expect(response!.status).toBe(200);
    expect(response!.contentType).toBe("text/plain");
    expect(response!.body).toBe("plain notes");
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs carries the doc's explicit title and description as headers", () => {
  let taskId = "";
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    const task = store.createTask("checkout");
    taskId = task.id;
    taskSlug = task.slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "notes.md");
  writeFileSync(docPath, "# H1 heading\n\nBody.");
  const store = openTraceStore(databasePath);
  try {
    store.addTaskDoc(taskId, docPath, {
      title: "Deployment plan",
      description: "How the rollout works",
    });
  } finally {
    store.close();
  }

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(docPath)}`,
    );
    expect(response!.status).toBe(200);
    // Explicit title wins over the H1, and the description rides along — both
    // url-encoded so arbitrary text survives the header transport.
    expect(decodeURIComponent(response!.headers!["x-doc-title"]!)).toBe(
      "Deployment plan",
    );
    expect(decodeURIComponent(response!.headers!["x-doc-description"]!)).toBe(
      "How the rollout works",
    );
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs resolves the title from the first H1 when there is no explicit title", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "notes.md");
  writeFileSync(docPath, "# Parsed from heading\n\nBody.");

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(docPath)}`,
    );
    expect(response!.status).toBe(200);
    expect(decodeURIComponent(response!.headers!["x-doc-title"]!)).toBe(
      "Parsed from heading",
    );
    // No description was registered, so no header at all (not an empty one).
    expect(response!.headers?.["x-doc-description"]).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs falls back to the filename when there is no title or H1", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "bare.md");
  writeFileSync(docPath, "Just body text, no heading.");

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(docPath)}`,
    );
    expect(response!.status).toBe(200);
    expect(decodeURIComponent(response!.headers!["x-doc-title"]!)).toBe(
      "bare.md",
    );
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs rejects a doc path outside the task's docs directory", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });

  // A sibling file outside the task's own docs dir.
  const outsidePath = join(docsDir, "..", "..", "secret.md");
  writeFileSync(outsidePath, "# Secret");

  try {
    const traversal = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent("../../secret.md")}`,
    );
    expect(traversal!.status).toBe(400);

    const absoluteOutside = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(resolve(outsidePath))}`,
    );
    expect(absoluteOutside!.status).toBe(400);
  } finally {
    rmSync(outsidePath, { force: true });
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs returns distinct results for a missing doc vs. an unreadable one", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(join(docsDir, "subdir"), { recursive: true });

  try {
    const missing = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(join(docsDir, "missing.md"))}`,
    );
    expect(missing!.status).toBe(404);

    // A directory exists at this path but cannot be read as a doc.
    const unreadable = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(join(docsDir, "subdir"))}`,
    );
    expect(unreadable!.status).toBe(500);
    expect(unreadable!.status).not.toBe(missing!.status);
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs returns 400 when the path query parameter is missing, and 404 for an unknown task", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });

  try {
    const missingParam = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs`,
    );
    expect(missingParam!.status).toBe(400);

    const unknownTask = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/does-not-exist/docs?path=notes.md`,
    );
    expect(unknownTask!.status).toBe(404);

    const wrongMethod = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskSlug}/docs?path=notes.md`,
    );
    expect(wrongMethod!.status).toBe(405);
  } finally {
    cleanup();
  }
});

test("GET /api/tasks/:ref/docs is read-only: the doc on disk is unchanged after the request", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "notes.md");
  const original = "# Notes\n\nOriginal content.";
  writeFileSync(docPath, original);
  const statBefore = statSync(docPath);

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs?path=${encodeURIComponent(docPath)}`,
    );
    expect(response!.status).toBe(200);

    expect(readFileSync(docPath, "utf8")).toBe(original);
    expect(statSync(docPath).mtimeMs).toBe(statBefore.mtimeMs);
  } finally {
    cleanup();
  }
});

test("POST /api/tasks/:ref/docs/checkbox flips the addressed marker in the on-disk file", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "todo.md");
  writeFileSync(docPath, "- [ ] first\n- [ ] second\n");

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskSlug}/docs/checkbox`,
      JSON.stringify({ path: docPath, index: 1, checked: true }),
    );
    expect(response!.status).toBe(200);
    expect(readFileSync(docPath, "utf8")).toBe("- [ ] first\n- [x] second\n");
  } finally {
    cleanup();
  }
});

test("POST /api/tasks/:ref/docs/checkbox rejects a path outside the task's docs directory", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const outsidePath = join(docsDir, "..", "..", "secret.md");
  writeFileSync(outsidePath, "- [ ] secret\n");

  try {
    const traversal = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskSlug}/docs/checkbox`,
      JSON.stringify({ path: "../../secret.md", index: 0, checked: true }),
    );
    expect(traversal!.status).toBe(400);
    // The out-of-bounds file is untouched.
    expect(readFileSync(outsidePath, "utf8")).toBe("- [ ] secret\n");
  } finally {
    rmSync(outsidePath, { force: true });
    cleanup();
  }
});

test("POST /api/tasks/:ref/docs/checkbox handles an out-of-range index gracefully", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "todo.md");
  const original = "- [ ] only one\n";
  writeFileSync(docPath, original);

  try {
    const response = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskSlug}/docs/checkbox`,
      JSON.stringify({ path: docPath, index: 5, checked: true }),
    );
    expect(response!.status).toBe(200);
    expect(readFileSync(docPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

test("POST /api/tasks/:ref/docs/checkbox rejects non-POST methods, unknown tasks, and malformed bodies", () => {
  let taskSlug = "";
  const { databasePath, cleanup } = withSeededDatabase((store) => {
    taskSlug = store.createTask("checkout").slug;
  });
  const docsDir = resolveTaskDocsDir(databasePath, taskSlug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "todo.md");
  writeFileSync(docPath, "- [ ] first\n");

  try {
    const body = JSON.stringify({ path: docPath, index: 0, checked: true });

    const wrongMethod = handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${taskSlug}/docs/checkbox`,
      body,
    );
    expect(wrongMethod!.status).toBe(405);

    const unknownTask = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/does-not-exist/docs/checkbox`,
      body,
    );
    expect(unknownTask!.status).toBe(404);

    const badJson = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskSlug}/docs/checkbox`,
      "not json",
    );
    expect(badJson!.status).toBe(400);

    const missingFields = handleTraceApiRequest(
      databasePath,
      "POST",
      `/api/tasks/${taskSlug}/docs/checkbox`,
      JSON.stringify({ path: docPath }),
    );
    expect(missingFields!.status).toBe(400);
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
