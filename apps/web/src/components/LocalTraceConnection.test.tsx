// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { TRACE_PROTOCOL_VERSION } from "@trace/core/browser";
import {
  HttpError,
  LocalTraceSource,
  TraceDataSourceProvider,
} from "../lib/trace-data-source.ts";
import {
  LocalConnectionBadge,
  LocalTraceConnection,
  connectionFailure,
  supportsLocalTraceBridge,
  validateTraceConnection,
} from "./LocalTraceConnection.tsx";

vi.mock("./BrowserPairing.tsx", async () => {
  const { CopyPromptButton } = await import("./CopyPromptButton.tsx");
  return {
    BrowserPairing: () => (
      <>
        <code>trace connection pair ABCD-1234</code>
        <CopyPromptButton
          label="Copy command"
          copyLabel="Copy command"
          value="trace connection pair ABCD-1234"
        />
      </>
    ),
  };
});

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  cleanup();
});

function renderConnection(
  connect: () => Promise<{
    service: "trace";
    protocolVersion: typeof TRACE_PROTOCOL_VERSION;
  }>,
  userAgent = "Mozilla/5.0 Chrome/140.0 Safari/537.36",
) {
  return render(
    <MemoryRouter>
      <LocalTraceConnection connect={connect} userAgent={userAgent}>
        <p>Local tasks</p>
      </LocalTraceConnection>
    </MemoryRouter>,
  );
}

describe("LocalTraceConnection", () => {
  test("starts with a copyable command, without an unsuccessful connect step", async () => {
    const user = userEvent.setup();
    const connect = vi.fn();
    renderConnection(connect);
    expect(screen.getByText("trace connection pair ABCD-1234")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Connect to Trace" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe(
      "trace connection pair ABCD-1234",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  test("reports a real connection failure and offers retry", async () => {
    localStorage.setItem(
      "trace.bridgeCredential:http://127.0.0.1:4317",
      "c".repeat(43),
    );
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    const connect = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <MemoryRouter>
        <TraceDataSourceProvider source={source}>
          <LocalTraceConnection connect={connect}>
            <p>Local tasks</p>
          </LocalTraceConnection>
        </TraceDataSourceProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Trace isn’t reachable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("reconnects automatically when the browser already has a pairing credential", async () => {
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    localStorage.setItem(source.credentialStorageKey, "c".repeat(43));
    const returningSource = new LocalTraceSource("http://127.0.0.1:4317");
    const connect = vi.fn().mockResolvedValue({
      service: "trace",
      protocolVersion: TRACE_PROTOCOL_VERSION,
    });

    render(
      <MemoryRouter>
        <TraceDataSourceProvider source={returningSource}>
          <LocalTraceConnection connect={connect}>
            <p>Local tasks</p>
          </LocalTraceConnection>
        </TraceDataSourceProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Local tasks")).toBeVisible();
    expect(connect).toHaveBeenCalledOnce();
  });

  test("a missing browser credential returns to ordinary setup, not an error", async () => {
    localStorage.setItem(
      "trace.bridgeCredential:http://127.0.0.1:4317",
      "c".repeat(43),
    );
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    const connect = vi
      .fn()
      .mockRejectedValue(new HttpError(401, "Authorization required"));
    render(
      <MemoryRouter>
        <TraceDataSourceProvider source={source}>
          <LocalTraceConnection connect={connect}>
            <p>Local tasks</p>
          </LocalTraceConnection>
        </TraceDataSourceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("trace connection pair ABCD-1234");
    expect(screen.queryByText("Not paired")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  test("the original tab connects when another tab completes pairing", async () => {
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        service: "trace",
        protocolVersion: TRACE_PROTOCOL_VERSION,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <MemoryRouter>
        <TraceDataSourceProvider source={source}>
          <LocalTraceConnection>
            <p>Local tasks</p>
          </LocalTraceConnection>
        </TraceDataSourceProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      localStorage.setItem(source.credentialStorageKey, "c".repeat(43));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: source.credentialStorageKey,
          newValue: "c".repeat(43),
        }),
      );
    });
    expect(await screen.findByText("Local tasks")).toBeVisible();
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${"c".repeat(43)}`);
  });

  test("pairs when a link arrives in the already-open unpaired tab", async () => {
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "c".repeat(43) }))
      .mockResolvedValueOnce(
        Response.json({
          service: "trace",
          protocolVersion: TRACE_PROTOCOL_VERSION,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    render(
      <MemoryRouter>
        <TraceDataSourceProvider source={source}>
          <LocalTraceConnection userAgent="Chrome/140.0 Safari/537.36">
            <p>Local tasks</p>
          </LocalTraceConnection>
        </TraceDataSourceProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("trace connection pair ABCD-1234")).toBeVisible();
    try {
      await act(async () => {
        window.history.replaceState(null, "", `/#trace-pair=${"s".repeat(43)}`);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(await screen.findByText("Local tasks")).toBeVisible();
      expect(window.location.hash).toBe("");
      expect(localStorage.getItem(source.credentialStorageKey)).toBe(
        "c".repeat(43),
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  test("keeps a refused origin distinct from an unpaired browser", () => {
    expect(connectionFailure(new HttpError(403, "Forbidden"))).toMatchObject({
      kind: "blocked",
    });
    expect(connectionFailure(new TypeError("Failed to fetch"))).toMatchObject({
      kind: "unavailable",
    });
  });

  test("reports an incompatible installed Trace version", () => {
    expect(
      validateTraceConnection({
        service: "trace",
        protocolVersion: 0 as typeof TRACE_PROTOCOL_VERSION,
      }),
    ).toMatchObject({ kind: "incompatible", title: "Trace needs an update" });
  });

  test("states what the site may and may not do before it is connected", () => {
    render(
      <MemoryRouter>
        <TraceDataSourceProvider
          source={new LocalTraceSource("http://127.0.0.1:4317")}
        >
          <LocalTraceConnection
            connect={vi.fn()}
            userAgent="Mozilla/5.0 Chrome/140.0 Safari/537.36"
          >
            <p>Local tasks</p>
          </LocalTraceConnection>
        </TraceDataSourceProvider>
      </MemoryRouter>,
    );

    const scope = screen.getByTestId("connection-scope");
    const available = (label: RegExp) =>
      within(scope)
        .getByText(label)
        .closest("li")
        ?.getAttribute("data-available");

    expect(available(/Browse tasks/)).toBe("true");
    expect(available(/Pin, unpin, archive/)).toBe("true");
    expect(available(/Exporting tasks/)).toBe("false");
    expect(available(/Account and Cloud Sync/)).toBe("false");
  });

  test("names the address a failed connection tried to reach", async () => {
    localStorage.setItem(
      "trace.bridgeCredential:http://127.0.0.1:4317",
      "c".repeat(43),
    );
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    render(
      <MemoryRouter>
        <TraceDataSourceProvider source={source}>
          <LocalTraceConnection
            connect={vi.fn().mockRejectedValue(new HttpError(403, "nope"))}
            userAgent="Mozilla/5.0 Chrome/140.0 Safari/537.36"
          >
            <p>Local tasks</p>
          </LocalTraceConnection>
        </TraceDataSourceProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("connection-origin")).toHaveTextContent(
      "http://127.0.0.1:4317",
    );
    expect(screen.queryByTestId("connection-scope")).not.toBeInTheDocument();
  });

  test("flags Safari and mobile Apple browsers before attempting a connection", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15";
    expect(supportsLocalTraceBridge(safari)).toBe(false);

    renderConnection(vi.fn(), safari);
    expect(screen.getByText("This browser isn’t supported yet")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Connect to Trace" }),
    ).not.toBeInTheDocument();
  });
});

describe("LocalConnectionBadge", () => {
  test("keeps the connection detail in a popover rather than in the header", async () => {
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    render(
      <TraceDataSourceProvider source={source}>
        <LocalConnectionBadge />
      </TraceDataSourceProvider>,
    );

    const trigger = screen.getByRole("button", {
      name: /connected to Trace on this device/i,
    });
    expect(screen.queryByText("Connected locally")).not.toBeInTheDocument();

    await userEvent.click(trigger);

    expect(await screen.findByText("Connected locally")).toBeVisible();
    expect(screen.getByText("http://127.0.0.1:4317")).toBeVisible();
    expect(
      screen.queryByText(/pinning or archiving them/i),
    ).not.toBeInTheDocument();
  });
});


test.each([
  ["https://app.eqnx.ai", "trace setup"],
  ["https://preview.example", "TRACE_WEB_ORIGIN='https://preview.example' trace setup"],
])("setup instructions match the hosted origin %s", (origin, command) => {
  vi.stubGlobal("location", new URL(origin));
  renderConnection(vi.fn());
  const instructions = screen.getByText((_, element) =>
    element?.tagName === "CODE" && element.textContent === `npm install -g @arielbk/trace\n${command}`,
  );
  expect(instructions).toBeInTheDocument();
});
