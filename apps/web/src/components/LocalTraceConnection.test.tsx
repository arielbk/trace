// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { TRACE_PROTOCOL_VERSION } from "@trace/core/browser";
import {
  LocalTraceSource,
  TraceDataSourceProvider,
} from "../lib/trace-data-source.ts";
import {
  LocalTraceConnection,
  supportsLocalTraceBridge,
  validateTraceConnection,
} from "./LocalTraceConnection.tsx";

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
  test("waits for an explicit click before requesting local-network access", async () => {
    const connect = vi.fn().mockResolvedValue({
      service: "trace",
      protocolVersion: TRACE_PROTOCOL_VERSION,
    });
    renderConnection(connect);

    expect(connect).not.toHaveBeenCalled();
    expect(screen.getByText(/browser may ask for permission/i)).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Connect to Trace" }),
    );

    expect(connect).toHaveBeenCalledOnce();
    expect(await screen.findByText("Local tasks")).toBeVisible();
  });

  test("reports a stopped bridge or denied permission and offers retry", async () => {
    const connect = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    renderConnection(connect);

    await userEvent.click(
      screen.getByRole("button", { name: "Connect to Trace" }),
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

  test("reports an incompatible installed Trace version", () => {
    expect(
      validateTraceConnection({
        service: "trace",
        protocolVersion: 0 as typeof TRACE_PROTOCOL_VERSION,
      }),
    ).toMatchObject({ kind: "incompatible", title: "Trace needs an update" });
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
