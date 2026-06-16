// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DocViewerSheet } from "./DocViewerSheet.tsx";

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSheet(
  docPath: string,
  onOpenChange: (open: boolean) => void = () => {},
  options: {
    knownDocPaths?: readonly string[];
    onNavigateDocRoute?: (route: string) => void;
  } = {},
) {
  const triggerRef = createRef<HTMLElement>();
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <DocViewerSheet
        taskRef="my-task"
        docPath={docPath}
        knownDocPaths={options.knownDocPaths}
        triggerRef={triggerRef}
        onOpenChange={onOpenChange}
        onNavigateDocRoute={options.onNavigateDocRoute}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

test("shows a loading state while doc contents are pending", () => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

  renderSheet("/work/docs/plan.md");

  expect(screen.getByText("Loading…")).toBeInTheDocument();
});

test("renders sanitized HTML for a markdown doc", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<h1>Plan</h1><p>Body text</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  );

  renderSheet("/work/docs/plan.md");

  expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
  expect(screen.getByText("Body text")).toBeInTheDocument();
});

test("renders raw text in a contained fallback for a non-markdown doc", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response('{"key":"value"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

  renderSheet("/work/docs/data.json");

  expect(await screen.findByText("Showing raw contents")).toBeInTheDocument();
  expect(screen.getByText('{"key":"value"}')).toBeInTheDocument();
});

test("shows a contained message when the doc is missing (404)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

  renderSheet("/work/docs/missing.md");

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This document could not be found.",
  );
});

test("shows a contained message when the doc is unreadable (500)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Doc could not be read", { status: 500 })),
  );

  renderSheet("/work/docs/unreadable.md");

  expect(await screen.findByRole("alert")).toHaveTextContent("Doc could not be read");
});

test("displays the doc's basename as the Sheet title", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<p>Hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  );

  renderSheet("/work/docs/plan.md");

  expect(await screen.findByRole("heading", { name: "plan.md" })).toBeInTheDocument();
});

test("Escape dismisses the Sheet via onOpenChange(false)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<p>Hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  );
  const onOpenChange = vi.fn();

  renderSheet("/work/docs/plan.md", onOpenChange);
  await screen.findByText("Hi");

  fireEvent.keyDown(document, { key: "Escape" });

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("the Close button dismisses the Sheet via onOpenChange(false)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<p>Hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  );
  const onOpenChange = vi.fn();

  renderSheet("/work/docs/plan.md", onOpenChange);
  await screen.findByText("Hi");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("does not intercept unknown, external, or non-markdown links", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        [
          '<a href="missing.md">Missing</a>',
          '<a href="https://example.com/plan.md">External</a>',
          '<a href="data.json">Data</a>',
        ].join(" "),
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ),
  );
  const onNavigateDocRoute = vi.fn();

  renderSheet("/work/docs/plan.md", () => {}, {
    knownDocPaths: ["/work/docs/plan.md", "/work/docs/next.md"],
    onNavigateDocRoute,
  });
  await screen.findByRole("link", { name: "Missing" });

  for (const name of ["Missing", "External", "Data"]) {
    const event = createEvent.click(screen.getByRole("link", { name }), {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(screen.getByRole("link", { name }), event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(onNavigateDocRoute).not.toHaveBeenCalled();
});
