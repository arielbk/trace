import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "./index.ts";
import { resolveStateAuthor } from "./state-author.ts";
import type { Session } from "./types.ts";
import { emptyTokenTotals } from "./token-totals.ts";

function waitForNextMillisecond(): void {
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    // SQLite stores ISO timestamps with millisecond precision.
  }
}

function session(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    transcriptPath: `/tmp/${overrides.id}.jsonl`,
    tool: "claude",
    model: null,
    title: null,
    taskId: "task-1",
    parentSessionId: null,
    origin: "root",
    subagentType: null,
    agentId: null,
    createdAt: "2026-08-21T10:00:00.000Z",
    tokenTotals: emptyTokenTotals(),
    ...overrides,
  };
}

test("attributes state to the newest session that had started when it was written", () => {
  const author = resolveStateAuthor(
    [
      session({
        id: "older",
        tool: "claude",
        model: "claude-opus-4-5",
        createdAt: "2026-08-21T09:00:00.000Z",
      }),
      session({
        id: "writer",
        tool: "codex",
        model: "gpt-5.6-terra",
        createdAt: "2026-08-21T11:00:00.000Z",
      }),
    ],
    "2026-08-21T12:30:00.000Z",
  );

  expect(author).toEqual({ tool: "codex", model: "gpt-5.6-terra" });
});

test("never credits a session that started after the state file was written", () => {
  const author = resolveStateAuthor(
    [
      session({
        id: "writer",
        tool: "codex",
        model: "gpt-5.6-terra",
        createdAt: "2026-08-21T11:00:00.000Z",
      }),
      // The session reading the board back is newer than the prose it reads.
      session({
        id: "reader",
        tool: "claude",
        model: "claude-opus-5",
        createdAt: "2026-08-21T14:00:00.000Z",
      }),
    ],
    "2026-08-21T12:30:00.000Z",
  );

  expect(author).toEqual({ tool: "codex", model: "gpt-5.6-terra" });
});

test("skips in-process subagents but keeps spawned children eligible", () => {
  const sessions = [
    session({
      id: "parent",
      tool: "claude",
      model: "claude-opus-5",
      createdAt: "2026-08-21T11:00:00.000Z",
    }),
    session({
      id: "subagent",
      tool: "claude",
      model: "claude-haiku-4-5",
      origin: "subagent",
      parentSessionId: "parent",
      createdAt: "2026-08-21T11:30:00.000Z",
    }),
  ];

  expect(resolveStateAuthor(sessions, "2026-08-21T12:00:00.000Z")).toEqual({
    tool: "claude",
    model: "claude-opus-5",
  });

  const withSpawned = [
    ...sessions,
    session({
      id: "ralph-iteration",
      tool: "codex",
      model: "gpt-5.6-terra",
      origin: "spawned",
      createdAt: "2026-08-21T11:45:00.000Z",
    }),
  ];

  expect(resolveStateAuthor(withSpawned, "2026-08-21T12:00:00.000Z")).toEqual({
    tool: "codex",
    model: "gpt-5.6-terra",
  });
});

test("omits an unrecorded model rather than carrying null", () => {
  expect(
    resolveStateAuthor(
      [session({ id: "writer", tool: "cursor", model: null })],
      "2026-08-21T12:00:00.000Z",
    ),
  ).toEqual({ tool: "cursor" });
});

test("returns nothing when there is no state file or no eligible session", () => {
  const writer = session({
    id: "writer",
    createdAt: "2026-08-21T11:00:00.000Z",
  });

  expect(resolveStateAuthor([writer], undefined)).toBeUndefined();
  expect(resolveStateAuthor([], "2026-08-21T12:00:00.000Z")).toBeUndefined();
  // Every session postdates the prose — an imported or hand-written state file.
  expect(
    resolveStateAuthor([writer], "2026-08-21T10:00:00.000Z"),
  ).toBeUndefined();
});

test("the task timeline attributes state prose to the session that wrote it", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-state-author-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const task = store.createTask("checkout");
    const writer = store.registerSession({
      id: "writer",
      transcriptPath: "/tmp/writer.jsonl",
      tool: "codex",
      model: "gpt-5.6-terra",
    });
    store.assignSession(writer.id, task.id);

    const docsDir = join(dir, "tasks", task.slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    const statePath = join(docsDir, "state.md");
    writeFileSync(
      statePath,
      "# Ready for QA\n\n## Next step\n\nRun the plan.\n",
    );
    // Stamp the prose to the moment the writer's run began: within its window,
    // and safely before any session registered after it.
    const writtenAt = new Date(writer.createdAt);
    utimesSync(statePath, writtenAt, writtenAt);
    expect(store.getTaskTimeline(task.id)?.stateUpdatedAt).toBe(
      writer.createdAt,
    );

    expect(store.getTaskTimeline(task.id)?.stateAuthor).toEqual({
      tool: "codex",
      model: "gpt-5.6-terra",
    });

    // A fresh session re-entering the task must not claim authorship of prose
    // it is only reading back.
    waitForNextMillisecond();
    const reader = store.registerSession({
      id: "reader",
      transcriptPath: "/tmp/reader.jsonl",
      tool: "claude",
      model: "claude-opus-5",
    });
    store.assignSession(reader.id, task.id);

    expect(store.getTaskTimeline(task.id)?.stateAuthor).toEqual({
      tool: "codex",
      model: "gpt-5.6-terra",
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
