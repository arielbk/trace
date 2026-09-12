// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { TaskActionsMenu } from "./TaskActionsMenu.tsx";

function stubExportDownload() {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-export");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

test("the overflow keeps Export, transcripts, and Archive out of the page until opened", () => {
  render(
    <TaskActionsMenu
      taskRef="checkout"
      isArchived={false}
      onArchive={() => undefined}
    />,
  );

  expect(
    screen.getByRole("button", { name: "More actions" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Export task" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Export with transcripts$/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Archive task" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/verbatim/i)).not.toBeInTheDocument();
});

test("opening the menu shows concise, distinct export choices and Archive", async () => {
  const user = userEvent.setup();
  render(
    <TaskActionsMenu
      taskRef="checkout"
      isArchived={false}
      onArchive={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "More actions" }));

  expect(
    await screen.findByRole("button", { name: "Export task" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /^Export with transcripts$/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Docs, metadata, and session summaries"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Includes unredacted session logs"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/machine identifiers/i)).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Archive task" }),
  ).toBeInTheDocument();
});

test("Export calls the export route with transcripts off", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="checkout-2026-08-19.zip"',
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  stubExportDownload();

  render(<TaskActionsMenu taskRef="checkout" isArchived={false} />);
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("button", { name: "Export task" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/checkout/export"),
  );
  expect(await screen.findByText("Download started")).toBeInTheDocument();
});

test("Export with transcripts confirms the sensitive choice before downloading", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="checkout-2026-08-19.zip"',
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  stubExportDownload();

  render(<TaskActionsMenu taskRef="checkout" isArchived={false} />);
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(
    await screen.findByRole("button", { name: /^Export with transcripts$/ }),
  );

  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    await screen.findByRole("dialog", {
      name: "Include unredacted transcripts?",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText(/local file paths/i)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Export transcripts" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/checkout/export?transcripts=1",
    ),
  );
  expect(await screen.findByText("Download started")).toBeInTheDocument();
});

test("export reports progress while the task bundle is being prepared", async () => {
  const user = userEvent.setup();
  let resolveFetch!: (response: Response) => void;
  const fetchMock = vi.fn().mockReturnValue(
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  stubExportDownload();

  render(<TaskActionsMenu taskRef="checkout" isArchived={false} />);
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("button", { name: "Export task" }));

  expect(await screen.findByText("Preparing task export…")).toBeInTheDocument();

  resolveFetch(
    new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="checkout.zip"',
      },
    }),
  );
  expect(await screen.findByText("Download started")).toBeInTheDocument();
});

test("a failed export offers a working retry", async () => {
  const user = userEvent.setup();
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="checkout.zip"',
        },
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  stubExportDownload();

  render(<TaskActionsMenu taskRef="checkout" isArchived={false} />);
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("button", { name: "Export task" }));

  expect(await screen.findByText("Export failed")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Download started")).toBeInTheDocument();
});

test("Archive in the menu calls onArchive", async () => {
  const user = userEvent.setup();
  const onArchive = vi.fn();
  render(
    <TaskActionsMenu
      taskRef="checkout"
      isArchived={false}
      onArchive={onArchive}
    />,
  );

  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("button", { name: "Archive task" }));

  expect(onArchive).toHaveBeenCalledTimes(1);
});
