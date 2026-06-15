// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TaskTimeline } from "@trace/core";
import type { ParsedStateMd } from "@trace/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeftOffPanel, TaskPage, TaskTimelineView } from "./TaskPage.tsx";

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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

test("TaskTimelineView renders the Cursor brand mark for a cursor session", () => {
  const timeline: TaskTimeline = {
    task: {
      id: "task-1",
      slug: "cursor-task",
      title: "Cursor task",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-06-11T00:00:00.000Z",
      archivedAt: null,
    },
    items: [
      {
        type: "session",
        createdAt: "2026-06-11T00:01:00.000Z",
        session: {
          id: "cursor-session",
          transcriptPath: "cursor:cursor-session",
          tool: "cursor",
          model: "claude-opus-4-7",
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
    lastActivityAt: "2026-06-11T00:00:00.000Z",
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

  // The cursor session carries its own labeled type icon, colored via the
  // cursor token, using the real Cursor cube mark — not the placeholder arrow.
  expect(html).toContain("type-icon type-icon-cursor");
  expect(html).toContain('aria-label="Cursor session"');
  expect(html).toContain("var(--color-tag-cursor)");
  expect(html).toContain("M12 2L22 7.5L12 13L2 7.5Z");
  expect(html).not.toContain("M5 3l14 8-6 1.6L9.6 18z");
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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

  expect(html).toContain('aria-label="Toggle color theme"');
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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

  expect(html).toContain('data-testid="task-description"');
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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

  expect(html).not.toContain('data-testid="task-description"');
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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
  expect(html).toContain('data-testid="token-summary-cache"');
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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

  // When projectRoot is empty, no project crumb segment should appear in the breadcrumb
  // (only the wordmark "Trace" and the context title render in the nav).
  expect(html).not.toContain("app-header-project");
  // The truncated path should not appear as visible text either.
  expect(html).not.toContain(">/Users/me/Projects<");
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
    lastActivityAt: "2026-05-29T00:00:00.000Z",
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

function baseTimeline(overrides: Partial<TaskTimeline["task"]> = {}): TaskTimeline {
  return {
    task: {
      id: "task-1",
      slug: "usable-v1",
      title: "usable v1",
      projectRoot: "/work/trace-v2",
      createdAt: "2026-05-29T00:00:00.000Z",
      archivedAt: null,
      ...overrides,
    },
    items: [],
    lastActivityAt: "2026-05-29T00:00:00.000Z",
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };
}

test("TaskTimelineView header shows breadcrumb with task slug, not raw title", () => {
  const timeline = baseTimeline();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );
  // The breadcrumb context crumb should be the slug
  expect(html).toContain("usable-v1");
});

test("TaskTimelineView header shows All tasks back link", () => {
  const timeline = baseTimeline();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );
  expect(html).toContain("All tasks");
});

test("TaskTimelineView header shows Last active timestamp", () => {
  const now = new Date("2026-05-29T00:10:00.000Z");
  const timeline = baseTimeline();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} now={now} />
    </MemoryRouter>,
  );
  expect(html).toContain("Last active");
  // lastActivityAt is "2026-05-29T00:00:00.000Z", now is 10m later
  expect(html).toContain("10m ago");
});

test("TaskTimelineView header shows Re-enter button with prompt as title", () => {
  const timeline = baseTimeline();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );
  expect(html).toContain("Re-enter");
  // The full prompt is available on the button for accessibility/hover
  expect(html).toContain('title="Re-enter the trace task &quot;usable v1&quot; (usable-v1)"');
});

test("TaskTimelineView header shows Archive button for unarchived task", () => {
  const timeline = baseTimeline({ archivedAt: null });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} onArchive={() => {}} />
    </MemoryRouter>,
  );
  expect(html).toContain("aria-label=\"Archive task\"");
  expect(html).not.toContain("aria-label=\"Unarchive task\"");
});

test("TaskTimelineView header shows Unarchive button for archived task", () => {
  const timeline = baseTimeline({ archivedAt: "2026-06-01T00:00:00.000Z" });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} onUnarchive={() => {}} />
    </MemoryRouter>,
  );
  expect(html).toContain("aria-label=\"Unarchive task\"");
  expect(html).not.toContain("aria-label=\"Archive task\"");
});

test("TaskTimelineView Archive button calls onArchive handler on click", async () => {
  const onArchive = vi.fn().mockResolvedValue(undefined);
  const timeline = baseTimeline({ archivedAt: null });
  render(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} onArchive={onArchive} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByLabelText("Archive task"));
  await waitFor(() => expect(onArchive).toHaveBeenCalledTimes(1));
});

test("TaskTimelineView Unarchive button calls onUnarchive handler on click", async () => {
  const onUnarchive = vi.fn().mockResolvedValue(undefined);
  const timeline = baseTimeline({ archivedAt: "2026-06-01T00:00:00.000Z" });
  render(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} onUnarchive={onUnarchive} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByLabelText("Unarchive task"));
  await waitFor(() => expect(onUnarchive).toHaveBeenCalledTimes(1));
});

test("TaskTimelineView Re-enter button copies re-enter prompt to clipboard on click", async () => {
  const timeline = baseTimeline();
  render(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByLabelText("Copy re-enter prompt"));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Re-enter the trace task "usable v1" (usable-v1)',
    ),
  );
});

// LeftOffPanel tests

test("LeftOffPanel renders all sections when full state is present", () => {
  const state: ParsedStateMd = {
    summary: "Working on the checkout redesign",
    decisions: ["Use React Query for data fetching", "Skip caching layer"],
    currentState: ["Auth flow is done", "Payment step is blocked"],
    nextStep: "Wire up the Stripe webhook handler",
    openQuestions: ["Do we support PayPal?"],
  };

  const html = renderToStaticMarkup(<LeftOffPanel state={state} />);

  expect(html).toContain("Where you left off");
  expect(html).toContain("Working on the checkout redesign");
  expect(html).toContain("Use React Query for data fetching");
  expect(html).toContain("Skip caching layer");
  expect(html).toContain("Auth flow is done");
  expect(html).toContain("Payment step is blocked");
  expect(html).toContain("Wire up the Stripe webhook handler");
  expect(html).toContain("Do we support PayPal?");
  // currentState renders as a muted paragraph (no header), so its content is
  // asserted above; the remaining sections still carry headers.
  expect(html).toContain("Decisions made");
  expect(html).toContain("Next step");
  expect(html).toContain("Open questions");
});

test("LeftOffPanel omits headers for missing sections (partial state)", () => {
  const state: ParsedStateMd = {
    summary: "Auth migration in progress",
    decisions: [],
    currentState: ["JWT tokens implemented"],
    nextStep: undefined,
    openQuestions: [],
  };

  const html = renderToStaticMarkup(<LeftOffPanel state={state} />);

  expect(html).toContain("Where you left off");
  expect(html).toContain("Auth migration in progress");
  expect(html).toContain("JWT tokens implemented");
  // Sections with no content should not render their headers
  expect(html).not.toContain("Decisions");
  expect(html).not.toContain("Next step");
  expect(html).not.toContain("Open questions");
});

test("LeftOffPanel renders handoff prompt when state is absent", () => {
  const html = renderToStaticMarkup(<LeftOffPanel state={undefined} />);

  expect(html).toContain("/handoff");
  // No section headers when there's no state
  expect(html).not.toContain("Where you left off");
  expect(html).not.toContain("Decisions");
});

test("LeftOffPanel renders HTML fragments without escaping inline markup", () => {
  const state: ParsedStateMd = {
    decisions: [],
    currentState: [],
    openQuestions: [],
    summary: "Working on <strong>auth</strong>",
    nextStep: "Fix <code>login()</code>",
  };

  const html = renderToStaticMarkup(<LeftOffPanel state={state} />);

  // The pre-rendered HTML fragments must not be double-escaped
  expect(html).toContain("<strong>auth</strong>");
  expect(html).toContain("<code>login()</code>");
});

test("TaskTimelineView renders LeftOffPanel with state when timeline has state", () => {
  const state: ParsedStateMd = {
    summary: "Working on billing integration",
    decisions: ["Use Stripe"],
    currentState: [],
    openQuestions: [],
  };
  const timeline: TaskTimeline = {
    ...baseTimeline(),
    state,
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain("Where you left off");
  expect(html).toContain("Working on billing integration");
});

test("TaskTimelineView renders handoff prompt when timeline has no state", () => {
  const timeline = baseTimeline();

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain("/handoff");
});

// activity-timeline-restyle: continuous spine tests

test("TaskTimelineView renders a single continuous timeline spine across items", () => {
  const timeline: TaskTimeline = {
    ...baseTimeline(),
    items: [
      {
        type: "session",
        createdAt: "2026-05-29T00:01:00.000Z",
        session: {
          id: "s1",
          transcriptPath: "/tmp/s1.jsonl",
          tool: "claude",
          model: null,
          taskId: "task-1",
          tokenTotals: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 2 },
          createdAt: "2026-05-29T00:01:00.000Z",
        },
        sessionName: null,
      },
      {
        type: "doc",
        createdAt: "2026-05-29T00:02:00.000Z",
        doc: { taskId: "task-1", path: "/work/docs/a.md", createdAt: "2026-05-29T00:02:00.000Z" },
        sizeBytes: null,
      },
      {
        type: "session",
        createdAt: "2026-05-29T00:03:00.000Z",
        session: {
          id: "s2",
          transcriptPath: "/tmp/s2.jsonl",
          tool: "codex",
          model: null,
          taskId: "task-1",
          tokenTotals: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0 },
          createdAt: "2026-05-29T00:03:00.000Z",
        },
        sessionName: null,
      },
    ],
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  // The timeline is drawn as one continuous spine behind the icons, not as
  // per-row connectors — so exactly one spine element regardless of item count,
  // and no horizontal dividers between rows.
  const spineCount = (html.match(/data-testid="timeline-spine"/g) ?? []).length;
  expect(spineCount).toBe(1);
  expect(html).not.toContain("border-b border-border");
});

test("TaskTimelineView still renders the spine with only one timeline item", () => {
  const timeline: TaskTimeline = {
    ...baseTimeline(),
    items: [
      {
        type: "doc",
        createdAt: "2026-05-29T00:01:00.000Z",
        doc: { taskId: "task-1", path: "/work/docs/b.md", createdAt: "2026-05-29T00:01:00.000Z" },
        sizeBytes: null,
      },
    ],
  };

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={timeline} />
    </MemoryRouter>,
  );

  expect(html).toContain('data-testid="timeline-spine"');
});

// timeline filtering by session / doc counts

function filterableTimeline(): TaskTimeline {
  return {
    ...baseTimeline(),
    items: [
      {
        type: "session",
        createdAt: "2026-05-29T00:01:00.000Z",
        session: {
          id: "s1",
          transcriptPath: "/tmp/s1.jsonl",
          tool: "claude",
          model: null,
          taskId: "task-1",
          tokenTotals: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 2 },
          createdAt: "2026-05-29T00:01:00.000Z",
        },
        sessionName: null,
      },
      {
        type: "doc",
        createdAt: "2026-05-29T00:02:00.000Z",
        doc: { taskId: "task-1", path: "/work/docs/a.md", createdAt: "2026-05-29T00:02:00.000Z" },
        sizeBytes: null,
      },
    ],
  };
}

test("TaskTimelineView filters the timeline when a count is clicked, and toggles back", () => {
  render(
    <MemoryRouter>
      <TaskTimelineView timeline={filterableTimeline()} />
    </MemoryRouter>,
  );

  expect(screen.getAllByRole("listitem")).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "1 doc" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(1);

  // clicking the active filter again clears it
  fireEvent.click(screen.getByRole("button", { name: "1 doc" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

test("TaskTimelineView breadcrumb links the project name to the filtered home view", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskTimelineView timeline={baseTimeline()} />
    </MemoryRouter>,
  );
  expect(html).toContain(
    `href="/?project=${encodeURIComponent("/work/trace-v2")}"`,
  );
});

// TaskPage hook-level integration tests

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderTaskPage(slug: string, queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tasks/${slug}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeTimeline(slug: string, archivedAt: string | null = null): TaskTimeline {
  return {
    task: {
      id: "task-abc",
      slug,
      title: "My task",
      projectRoot: "/work/proj",
      createdAt: "2026-06-01T00:00:00.000Z",
      archivedAt,
    },
    items: [],
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    tokenTotals: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0 },
  };
}

describe("TaskPage", () => {
  test("renders the timeline title when fetch succeeds", async () => {
    const timeline = makeTimeline("my-task");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(timeline),
    }));

    renderTaskPage("my-task", makeQueryClient());

    expect(await screen.findByText("My task")).toBeInTheDocument();
  });

  test("renders not-found state on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve(null),
    }));

    renderTaskPage("no-such-task", makeQueryClient());

    expect(await screen.findByText("Task not found.")).toBeInTheDocument();
  });

  test("archive button fires POST to archive endpoint and refetches", async () => {
    const timeline = makeTimeline("my-task");
    const archivedTimeline = makeTimeline("my-task", "2026-06-01T00:01:00.000Z");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(timeline) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: "task-abc", archivedAt: "2026-06-01T00:01:00.000Z" }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(archivedTimeline) });

    vi.stubGlobal("fetch", fetchMock);

    renderTaskPage("my-task", makeQueryClient());
    await screen.findByText("My task");

    fireEvent.click(screen.getByLabelText("Archive task"));

    await waitFor(() => {
      const archiveCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/archive"),
      );
      expect(archiveCall).toBeDefined();
      expect(archiveCall?.[1]?.method).toBe("POST");
    });
  });
});
