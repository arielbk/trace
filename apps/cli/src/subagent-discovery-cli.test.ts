import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

type TimelineSession = {
  type: string;
  session?: {
    id: string;
    parentSessionId: string | null;
    origin: string;
    subagentType: string | null;
  };
};

function runTrace(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): string {
  return execFileSync(process.execPath, [traceBin, ...args], {
    encoding: "utf8",
    env,
    ...(cwd ? { cwd } : {}),
  });
}

function timelineItems(
  taskId: string,
  env: NodeJS.ProcessEnv,
): TimelineSession[] {
  const timeline = JSON.parse(
    runTrace(["task", "timeline", taskId, "--json"], env),
  ) as { items: TimelineSession[] };
  return timeline.items;
}

function writeCodexHome(codexHome: string): {
  parentTranscriptPath: string;
} {
  const sessionsDir = join(codexHome, "sessions", "2026", "07", "06");
  mkdirSync(sessionsDir, { recursive: true });

  const parentTranscriptPath = join(sessionsDir, "codex-parent-1.jsonl");
  writeFileSync(
    parentTranscriptPath,
    [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-parent-1" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          sender_thread_id: "codex-parent-1",
          new_thread_id: "codex-child-1",
          new_agent_nickname: "Huygens",
          new_agent_role: "explorer",
          status: "pending_init",
        },
      }),
    ].join("\n"),
  );

  writeFileSync(
    join(sessionsDir, "codex-child-1.jsonl"),
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-child-1",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "codex-parent-1",
                depth: 1,
                agent_nickname: "Huygens",
                agent_role: "explorer",
              },
            },
          },
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    ].join("\n"),
  );

  return { parentTranscriptPath };
}

test("scan --codex attributes subagent rollouts to their parent session", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-codex-scan-subagents-"));
  const codexHome = join(dir, "codex-home");
  // HOME anchors auth.json/key.json (TRACE_DB only isolates the store), so
  // point it at the temp dir too — otherwise a spawned trace reads the real
  // ~/.trace credentials and background-syncs these fixtures to a live server.
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
  };
  const taskSlug = "codex-fan-out";

  try {
    const { parentTranscriptPath } = writeCodexHome(codexHome);

    runTrace(
      [
        "skill",
        "work-on-task",
        "Codex fan-out",
        "--id",
        "codex-parent-1",
        "--transcript",
        parentTranscriptPath,
        "--tool",
        "codex",
      ],
      env,
      dir,
    );
    runTrace(["session", "scan", "--codex", "--codex-home", codexHome], env);

    expect(timelineItems(taskSlug, env)).toContainEqual(
      expect.objectContaining({
        type: "session",
        session: expect.objectContaining({
          id: "codex-child-1",
          parentSessionId: "codex-parent-1",
          origin: "subagent",
          subagentType: "explorer",
        }),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entering a task sweeps up Codex subagents without a scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-reenter-sweep-"));
  const codexHome = join(dir, "codex-home");
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
    CODEX_HOME: codexHome,
  };
  const taskSlug = "codex-fan-out";

  try {
    const { parentTranscriptPath } = writeCodexHome(codexHome);

    runTrace(
      [
        "skill",
        "work-on-task",
        "Codex fan-out",
        "--id",
        "codex-parent-1",
        "--transcript",
        parentTranscriptPath,
        "--tool",
        "codex",
      ],
      env,
      dir,
    );
    runTrace(["skill", "re-enter", "Codex fan-out"], env, dir);

    expect(timelineItems(taskSlug, env)).toContainEqual(
      expect.objectContaining({
        type: "session",
        session: expect.objectContaining({
          id: "codex-child-1",
          parentSessionId: "codex-parent-1",
          origin: "subagent",
          subagentType: "explorer",
        }),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discover-subagents recovers Cursor subagents via the parent's Task prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cursor-discover-"));
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
  };
  const chatDir = join(
    dir,
    "projects",
    "Users-dev-repo",
    "agent-transcripts",
    "cursor-parent-1",
  );
  const subagentsDir = join(chatDir, "subagents");
  const parentTranscriptPath = join(chatDir, "cursor-parent-1.jsonl");
  const taskSlug = "cursor-fan-out";

  try {
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      parentTranscriptPath,
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              input: {
                description: "Explore the spec",
                subagent_type: "explore",
                prompt: "Investigate project type immutability",
              },
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(subagentsDir, "cursor-child-1.jsonl"),
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nInvestigate project type immutability\n</user_query>",
            },
          ],
        },
      }),
    );

    runTrace(
      [
        "skill",
        "work-on-task",
        "Cursor fan-out",
        "--id",
        "cursor-parent-1",
        "--transcript",
        parentTranscriptPath,
        "--tool",
        "cursor",
      ],
      env,
      dir,
    );
    runTrace(["session", "discover-subagents", "cursor-parent-1"], env);

    expect(timelineItems(taskSlug, env)).toContainEqual(
      expect.objectContaining({
        type: "session",
        session: expect.objectContaining({
          id: "cursor-child-1",
          parentSessionId: "cursor-parent-1",
          origin: "subagent",
          subagentType: "explore",
        }),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
