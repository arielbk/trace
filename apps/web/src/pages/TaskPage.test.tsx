import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { TaskTimeline } from "@trace/core";
import { TaskTimelineView } from "./TaskPage.tsx";

test("TaskTimelineView renders colored tool tags and model chips", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
    },
    items: [
      {
        type: "session",
        createdAt: "2026-05-29T00:01:00.000Z",
        session: {
          id: "session-1",
          transcriptPath: "/tmp/session-1.jsonl",
          tool: "claude",
          model: "claude-opus-4-7",
          taskId: "task-1",
          tokenTotals: {
            inputTokens: 10,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalTokens: 15,
          },
          createdAt: "2026-05-29T00:01:00.000Z",
        },
      },
      {
        type: "session",
        createdAt: "2026-05-29T00:02:00.000Z",
        session: {
          id: "session-2",
          transcriptPath: "/tmp/session-2.jsonl",
          tool: "codex",
          model: null,
          taskId: "task-1",
          tokenTotals: {
            inputTokens: 7,
            outputTokens: 3,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalTokens: 10,
          },
          createdAt: "2026-05-29T00:02:00.000Z",
        },
      },
    ],
    tokenTotals: {
      inputTokens: 17,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 25,
    },
  };

  const html = renderToStaticMarkup(<TaskTimelineView timeline={timeline} />);

  expect(html).toContain("tool-tag tool-tag-claude");
  expect(html).toContain("tool-tag tool-tag-codex");
  expect(html).toContain("claude-opus-4-7");
  expect(html).toContain(">—<");
  expect(html).toContain("usable-v1");
});
