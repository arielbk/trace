// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TaskExportControl } from "./TaskExportControl.tsx";

function stubExportDownload() {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-export");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

test("include transcripts is unchecked by default and the verbatim warning is present", () => {
  render(<TaskExportControl taskRef="checkout" />);

  expect(
    screen.getByRole("checkbox", { name: /include transcripts/i }),
  ).not.toBeChecked();
  expect(screen.getByText(/verbatim/i)).toBeInTheDocument();
  expect(screen.getByText(/unredacted/i)).toBeInTheDocument();
});

test("Export calls the export route with transcripts off by default", async () => {
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

  render(<TaskExportControl taskRef="checkout" />);
  await user.click(screen.getByRole("button", { name: /export/i }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/checkout/export"),
  );
});

test("Export includes transcripts when the control is checked", async () => {
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

  render(<TaskExportControl taskRef="checkout" />);
  await user.click(
    screen.getByRole("checkbox", { name: /include transcripts/i }),
  );
  await user.click(screen.getByRole("button", { name: /export/i }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/checkout/export?transcripts=1",
    ),
  );
});
