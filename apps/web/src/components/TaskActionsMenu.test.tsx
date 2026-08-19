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
  expect(screen.queryByRole("button", { name: /^Export$/ })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Export with transcripts$/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Archive task" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/verbatim/i)).not.toBeInTheDocument();
});

test("opening the menu shows Export, Export with transcripts plus the warning, and Archive", async () => {
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
    await screen.findByRole("button", { name: /^Export$/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /^Export with transcripts$/ }),
  ).toBeInTheDocument();
  expect(screen.getByText(/verbatim/i)).toBeInTheDocument();
  expect(screen.getByText(/unredacted/i)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Archive task" }),
  ).toBeInTheDocument();
});

test("Export calls the export route with transcripts off", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(new Blob(["PK"]), {
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
  await user.click(await screen.findByRole("button", { name: /^Export$/ }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/checkout/export"),
  );
});

test("Export with transcripts calls the export route with transcripts on", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(new Blob(["PK"]), {
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

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/checkout/export?transcripts=1",
    ),
  );
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
