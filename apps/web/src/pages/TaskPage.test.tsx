import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { expect, test } from "vitest";
import type { TaskTimeline } from "@trace/core";
import { TaskTimelineView } from "./TaskPage.tsx";

test("TaskTimelineView renders per-type SVG icons and model chips", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
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
        sessionName: null,
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
        sessionName: null,
      },
      {
        type: "doc",
        createdAt: "2026-05-29T00:03:00.000Z",
        doc: {
          taskId: "task-1",
          path: "/work/trace-v2/docs/plan.md",
          createdAt: "2026-05-29T00:03:00.000Z",
        },
        sizeBytes: null,
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

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  // Each entry type carries an inline SVG icon, not a text tag.
  expect(html).toContain("<svg");
  expect(html).toContain("type-icon type-icon-claude");
  expect(html).toContain("type-icon type-icon-codex");
  expect(html).toContain("type-icon type-icon-doc");
  expect(html).not.toContain("tool-tag");
  // Claude uses its product color mark, not the old hand-drawn spoke glyph.
  expect(html).toContain("M4.709 15.955");
  expect(html).not.toContain('x2="21"');
  // Codex uses the product color mark, not the old angle-bracket code glyph.
  expect(html).toContain("codex-icon-gradient");
  expect(html).toContain("#3941ff");
  expect(html).not.toContain("M19.503 0H4.496");
  expect(html).not.toContain("points=&quot;9 8 5 12 9 16&quot;");
  // Model chip renders only when a model is known — no em dash fallback pill.
  expect(html).toContain("claude-opus-4-7");
  expect(html).not.toContain(">—<");
  // Per-session tokens show the input/output split, not the cache-inflated total.
  expect(html).toContain("10 in");
  expect(html).toContain("5 out");
});

test("TaskTimelineView labels uncaptured session token totals as unavailable", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "codex-re-entry-support",
      title: "Codex re-entry support",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-06-11T00:00:00.000Z",
      archivedAt: null,
    },
    items: [
      {
        type: "session",
        createdAt: "2026-06-11T00:01:00.000Z",
        session: {
          id: "codex-session",
          transcriptPath: "codex:codex-session",
          tool: "codex",
          model: null,
          taskId: "task-1",
          tokenTotals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalTokens: 0,
          },
          createdAt: "2026-06-11T00:01:00.000Z",
        },
        sessionName: null,
      },
    ],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain("tokens unavailable");
  expect(html).not.toContain("0 in");
  expect(html).not.toContain("0 out");
});

test("TaskTimelineView renders relative timestamps, never raw ISO strings", () => {
  const now = new Date("2026-05-29T00:05:00.000Z");
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [
      {
        type: "doc",
        createdAt: "2026-05-29T00:03:00.000Z",
        doc: {
          taskId: "task-1",
          path: "/work/trace-v2/docs/plan.md",
          createdAt: "2026-05-29T00:03:00.000Z",
        },
        sizeBytes: null,
      },
    ],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} now={now} />
    </MemoryRouter>,
  );

  expect(html).toContain("2m ago");
  // No raw ISO timestamp leaks into the rendered output.
  expect(html).not.toContain("2026-05-29T00:03:00.000Z");
});

test("TaskTimelineView shows transcript and doc paths as truncated copy chips", () => {
  const transcriptPath = "/Users/me/.trace/sessions/session-abc.jsonl";
  const docPath = "/work/trace-v2/docs/web-redesign/web-redesign.tasks.md";
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [
      {
        type: "session",
        createdAt: "2026-05-29T00:01:00.000Z",
        session: {
          id: "session-1",
          transcriptPath,
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
        sessionName: null,
      },
      {
        type: "doc",
        createdAt: "2026-05-29T00:03:00.000Z",
        doc: {
          taskId: "task-1",
          path: docPath,
          createdAt: "2026-05-29T00:03:00.000Z",
        },
        sizeBytes: null,
      },
    ],
    tokenTotals: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 15,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  // Tails are shown; the full paths are copyable via the chip title.
  expect(html).toContain(">session-abc.jsonl<");
  expect(html).toContain(`title="${transcriptPath}"`);
  expect(html).toContain(">web-redesign.tasks.md<");
  expect(html).toContain(`title="${docPath}"`);
  // The full paths never render as bare body text.
  expect(html).not.toContain(`>${transcriptPath}<`);
  expect(html).not.toContain(`>${docPath}<`);
});

test("TaskTimelineView stat cards show the cache split, compact with exact on hover", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [],
    tokenTotals: {
      inputTokens: 81123,
      outputTokens: 5,
      cacheCreationInputTokens: 999,
      cacheReadInputTokens: 1_000_000,
      totalTokens: 16_317_514,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  // Total/Input/Output cards plus a cache split on a secondary line below,
  // labeled and without the old "+" subtext styling.
  expect(html).toContain("Total");
  expect(html).toContain("Input");
  expect(html).toContain("Output");
  expect(html).toContain("Cache");
  expect(html).toContain("1.0M read");
  expect(html).toContain("999 written");
  expect(html).not.toContain("+999");

  // "Total" is fresh spend (input + output), matching the main task list — the
  // cache-inflated grand total does not headline the summary.
  expect(html).toContain('title="81128"'); // 81123 + 5
  expect(html).not.toContain(">16.3M<");
  expect(html).not.toContain('title="16317514"');

  // Values render compactly with the exact integer available on hover.
  expect(html).toContain(">81.1K<");
  expect(html).toContain('title="1000000"');
  // No raw multi-thousand integer is rendered as bare card text.
  expect(html).not.toContain(">16317514<");
});

test("TaskTimelineView header includes the theme toggle", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain('class="theme-toggle"');
});

test("TaskTimelineView header has a copy re-enter prompt button, no slug text, no UUID chip", () => {
  const fullId = "0e1d2c3b-4a59-6879-8a7b-6c5d4e3f2a1b";
  const timeline: TaskTimeline = {
    task: {
      id: fullId,
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  // Copy re-enter prompt button is present; title attribute HTML-encodes the inner quotes.
  expect(html).toContain(
    'title="Re-enter the trace task &quot;usable v1&quot; (usable-v1)"',
  );
  expect(html).toContain("Copy re-enter prompt");
  // No raw UUID chip in the header.
  expect(html).not.toContain(`title="${fullId}"`);
  expect(html).not.toContain(">0e1d2c3b<");
  // Slug is not rendered as visible text in the header.
  expect(html).not.toContain('class="task-slug"');
});

test("TaskTimelineView renders the task description under the title when present", () => {
  const description = "Rework the checkout into a multi-step wizard";
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
      description,
    },
    items: [],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain('class="task-description"');
  expect(html).toContain(description);
});

test("TaskTimelineView omits the description block when absent", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).not.toContain("task-description");
});

test("TokenSummary renders cache reads/writes as a secondary line below the cards", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "cache-heavy",
      title: "cache heavy",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [],
    tokenTotals: {
      inputTokens: 81123,
      outputTokens: 5,
      cacheCreationInputTokens: 999,
      cacheReadInputTokens: 1_000_000,
      totalTokens: 16_317_514,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  // Cache reads/writes render on the dedicated secondary line, not as a card.
  expect(html).toContain('class="token-summary-cache"');
  // Cache data is still visible (not hidden), labeled, without the old "+".
  expect(html).toContain("1.0M read");
  expect(html).toContain("999 written");
  expect(html).not.toContain("+999");
});

test("TaskTimelineView shows the project display name in the header breadcrumb when projectRoot is set", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/Users/me/Projects/my-cool-app",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain('class="app-header-project"');
  expect(html).toContain("my-cool-app");
  // Full path must not render as bare visible text.
  expect(html).not.toContain(">/Users/me/Projects/my-cool-app<");
});

test("TaskTimelineView omits the breadcrumb project segment when projectRoot is empty", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
    },
    items: [],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).not.toContain("app-header-project");
});

test("TaskTimelineView renders a sessionless doc-only task with zero token totals", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-2",
      slug: "captured-findings",
      title: "Captured findings",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-06-03T00:00:00.000Z",
      archivedAt: null,
    },
    items: [
      {
        type: "doc",
        createdAt: "2026-06-03T00:00:00.000Z",
        doc: {
          taskId: "task-2",
          path: "/home/u/.trace/tasks/task-2/docs/findings.md",
          createdAt: "2026-06-03T00:00:00.000Z",
        },
        sizeBytes: 12544,
      },
    ],
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain("type-icon type-icon-doc");
  expect(html).toContain("findings.md");
  // The doc's on-disk size renders as a compact, human-readable detail.
  expect(html).toContain("12.3 KB");
  expect(html).not.toContain("No timeline items found.");
  // Zero token totals still render (no session rows, no crash).
  expect(html).toContain("Token totals");
});
