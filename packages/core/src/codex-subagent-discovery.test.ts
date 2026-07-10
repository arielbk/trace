import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverCodexSubagentSessions, openTraceStore } from "./index.ts";

const PARENT_ID = "019dd000-0000-7000-8000-00000000aaaa";
const CHILD_ON_DISK = "019dd000-0000-7000-8000-00000000bbbb";
const CHILD_MISSING = "019dd000-0000-7000-8000-00000000cccc";

function writeCodexFixture(codexHome: string): {
  parentTranscriptPath: string;
  childTranscriptPath: string;
} {
  const parentDir = join(codexHome, "sessions", "2026", "04", "30");
  const childDir = join(codexHome, "sessions", "2026", "05", "01");
  mkdirSync(parentDir, { recursive: true });
  mkdirSync(childDir, { recursive: true });

  const parentTranscriptPath = join(
    parentDir,
    `rollout-2026-04-30T18-22-15-${PARENT_ID}.jsonl`,
  );
  writeFileSync(
    parentTranscriptPath,
    [
      JSON.stringify({ type: "session_meta", payload: { id: PARENT_ID } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          sender_thread_id: PARENT_ID,
          new_thread_id: CHILD_ON_DISK,
          new_agent_nickname: "Huygens",
          new_agent_role: "explorer",
          status: "pending_init",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          sender_thread_id: PARENT_ID,
          new_thread_id: CHILD_MISSING,
          new_agent_nickname: "Parfit",
          new_agent_role: "reviewer",
          status: "pending_init",
        },
      }),
    ].join("\n"),
  );

  // The child rollout is date-partitioned by its own start time, in a
  // different day-dir than the parent.
  const childTranscriptPath = join(
    childDir,
    `rollout-2026-05-01T00-31-00-${CHILD_ON_DISK}.jsonl`,
  );
  writeFileSync(
    childTranscriptPath,
    [
      JSON.stringify({
        type: "thread.started",
        thread_id: CHILD_ON_DISK,
        model: "gpt-5.5",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    ].join("\n"),
  );

  return { parentTranscriptPath, childTranscriptPath };
}

test("discovers Codex subagent rollouts from the parent's spawn records", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-subagents-"));
  const codexHome = join(dir, "codex-home");
  const databasePath = join(dir, "trace.sqlite");

  try {
    const { parentTranscriptPath, childTranscriptPath } =
      writeCodexFixture(codexHome);

    const store = openTraceStore(databasePath);
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_ID,
      transcriptPath: parentTranscriptPath,
      tool: "codex",
    });
    store.assignSession(parent.id, task.id);

    const discovered = discoverCodexSubagentSessions({
      store,
      parentSessionId: parent.id,
      codexHome,
    });
    const secondRun = discoverCodexSubagentSessions({
      store,
      parentSessionId: parent.id,
      codexHome,
    });

    expect(discovered).toHaveLength(2);
    expect(secondRun).toEqual(discovered);
    expect(store.listSessionsForTask(task.id)).toEqual([
      expect.objectContaining({ id: parent.id, origin: "root" }),
      expect.objectContaining({
        id: CHILD_ON_DISK,
        transcriptPath: childTranscriptPath,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "explorer",
        // The spawn nickname stands in as the child's name.
        title: "Huygens",
        agentId: CHILD_ON_DISK,
        model: "gpt-5.5",
        taskId: task.id,
        tokenTotals: expect.objectContaining({
          inputTokens: 5,
          outputTokens: 7,
          totalTokens: 12,
        }),
      }),
      // A spawn whose rollout hasn't been found yet still registers, under a
      // synthetic locator the store upgrades when a later scan finds the file.
      expect.objectContaining({
        id: CHILD_MISSING,
        transcriptPath: `codex:${CHILD_MISSING}`,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "reviewer",
        taskId: task.id,
      }),
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enriches a child a scan already registered as a root session", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-subagents-enrich-"));
  const codexHome = join(dir, "codex-home");
  const databasePath = join(dir, "trace.sqlite");

  try {
    const { parentTranscriptPath, childTranscriptPath } =
      writeCodexFixture(codexHome);

    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: PARENT_ID,
      transcriptPath: parentTranscriptPath,
      tool: "codex",
    });
    // A plain scan ingested the child rollout first, as a root session.
    store.registerSession({
      id: CHILD_ON_DISK,
      transcriptPath: childTranscriptPath,
      tool: "codex",
      model: "gpt-5.5",
      tokenTotals: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    });

    discoverCodexSubagentSessions({
      store,
      parentSessionId: parent.id,
      codexHome,
    });

    expect(store.getSession(CHILD_ON_DISK)).toEqual(
      expect.objectContaining({
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "explorer",
        transcriptPath: childTranscriptPath,
        model: "gpt-5.5",
      }),
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves a parent registered under a synthetic codex locator", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-subagents-synthetic-"));
  const codexHome = join(dir, "codex-home");
  const databasePath = join(dir, "trace.sqlite");

  try {
    writeCodexFixture(codexHome);

    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: PARENT_ID,
      transcriptPath: `codex:${PARENT_ID}`,
      tool: "codex",
    });

    const discovered = discoverCodexSubagentSessions({
      store,
      parentSessionId: parent.id,
      codexHome,
    });

    expect(discovered.map((session) => session.id)).toEqual([
      CHILD_ON_DISK,
      CHILD_MISSING,
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
