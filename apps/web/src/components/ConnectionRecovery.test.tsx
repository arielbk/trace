// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  TRACE_PROTOCOL_VERSION,
  type TraceConnection,
} from "@trace/core/browser";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_DELAYS_MS,
} from "../lib/connection-recovery.ts";
import { HttpError } from "../lib/trace-data-source.ts";
import { LocalConnectionBadge } from "./LocalTraceConnection.tsx";
import { ConnectionRecovery } from "./ConnectionRecovery.tsx";

const healthy: TraceConnection = {
  service: "trace",
  protocolVersion: TRACE_PROTOCOL_VERSION,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function renderBoard(probe: () => Promise<TraceConnection>) {
  return render(
    <ConnectionRecovery probe={probe}>
      <p>Local tasks</p>
    </ConnectionRecovery>,
  );
}

/** Let the heartbeat fire, then spend every bounded retry. */
async function loseTheConnection(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
  });
  for (const delay of RECONNECT_DELAYS_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay);
    });
  }
}

describe("ConnectionRecovery", () => {
  test("stays out of the way while the connection answers", async () => {
    renderBoard(vi.fn().mockResolvedValue(healthy));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    });

    expect(screen.getByText("Local tasks")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("says it is reconnecting before it says the connection is gone", async () => {
    const probe = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    renderBoard(probe);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });

    expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/i);
    // The board it already rendered stays on screen while it recovers.
    expect(screen.getByText("Local tasks")).toBeVisible();
  });

  test("groups a stopped, blocked, or offline connection under one honest message", async () => {
    renderBoard(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await loseTheConnection();

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Trace isn’t responding");
    expect(banner).toHaveTextContent(/local-network access/i);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });

  test("tells a revoked browser it needs a new pairing link", async () => {
    renderBoard(vi.fn().mockRejectedValue(new HttpError(401, "no")));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("This browser’s access was revoked");
    expect(banner).toHaveTextContent(/trace board/);
  });

  test("the header badge agrees with connection loss and recovery", async () => {
    const probe = vi.fn().mockRejectedValue(new HttpError(401, "revoked"));
    render(
      <ConnectionRecovery probe={probe}>
        <LocalConnectionBadge />
      </ConnectionRecovery>,
    );
    expect(screen.getByRole("button", {name: "Connection — connected to Trace on this device"})).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); });
    expect(screen.getByRole("button", {name: "Connection — access revoked"})).toBeVisible();
    probe.mockResolvedValue(healthy);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByRole("button", {name: "Connection — connected to Trace on this device"})).toBeVisible();
  });

  test("tells a board whose runtime changed protocol to reload", async () => {
    renderBoard(
      vi.fn().mockResolvedValue({
        service: "trace",
        protocolVersion: TRACE_PROTOCOL_VERSION + 1,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Trace on this device changed version");
    expect(banner).toHaveTextContent(/reload/i);
  });

  test("clears the banner when the connection comes back", async () => {
    const probe = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    renderBoard(probe);
    await loseTheConnection();
    expect(screen.getByRole("status")).toBeVisible();

    probe.mockResolvedValue(healthy);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Local tasks")).toBeVisible();
  });
});
