// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TRACE_PROTOCOL_VERSION } from "@trace/core/browser";
import { HttpError } from "./trace-data-source.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_DELAYS_MS,
  useConnectionRecovery,
} from "./connection-recovery.ts";

const healthy = { service: "trace" as const, protocolVersion: TRACE_PROTOCOL_VERSION };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run the heartbeat, then every bounded retry the hook is allowed. */
async function exhaustRecovery(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
  });
  for (const delay of RECONNECT_DELAYS_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay);
    });
  }
}

describe("useConnectionRecovery", () => {
  test("keeps watching a connection that goes on answering", async () => {
    const probe = vi.fn().mockResolvedValue(healthy);
    const { result } = renderHook(() => useConnectionRecovery({ probe }));

    expect(result.current.status).toBe("healthy");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    });

    expect(probe).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe("healthy");
    expect(result.current.loss).toBeNull();
  });

  test("retries a connection that stopped answering before giving up on it", async () => {
    const probe = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useConnectionRecovery({ probe }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });

    expect(result.current.status).toBe("recovering");
    expect(result.current.loss).toMatchObject({ kind: "unreachable" });

    for (const delay of RECONNECT_DELAYS_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }

    expect(result.current.status).toBe("lost");
    // The heartbeat plus each bounded retry, and nothing beyond them.
    expect(probe).toHaveBeenCalledTimes(1 + RECONNECT_DELAYS_MS.length);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    });
    expect(probe).toHaveBeenCalledTimes(1 + RECONNECT_DELAYS_MS.length);
  });

  test("returns to healthy when a retry reaches the connection again", async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(healthy);
    const { result } = renderHook(() => useConnectionRecovery({ probe }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    expect(result.current.status).toBe("recovering");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0] as number);
    });

    expect(result.current.status).toBe("healthy");
    expect(result.current.loss).toBeNull();
  });

  test("does not retry a credential the connection has revoked", async () => {
    const probe = vi.fn().mockRejectedValue(new HttpError(401, "no"));
    const { result } = renderHook(() => useConnectionRecovery({ probe }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });

    expect(result.current.status).toBe("lost");
    expect(result.current.loss).toMatchObject({ kind: "revoked" });
    expect(probe).toHaveBeenCalledOnce();
  });

  test("does not retry a runtime that came back speaking another protocol", async () => {
    const probe = vi.fn().mockResolvedValue({
      service: "trace",
      protocolVersion: TRACE_PROTOCOL_VERSION + 1,
    });
    const { result } = renderHook(() => useConnectionRecovery({ probe }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });

    expect(result.current.status).toBe("lost");
    expect(result.current.loss).toMatchObject({
      kind: "outdated",
      protocolVersion: TRACE_PROTOCOL_VERSION + 1,
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  test("checks again when the viewer returns to the tab", async () => {
    const probe = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    renderHook(() => useConnectionRecovery({ probe }));
    await exhaustRecovery();
    expect(probe).toHaveBeenCalledTimes(1 + RECONNECT_DELAYS_MS.length);

    probe.mockResolvedValue(healthy);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(probe).toHaveBeenCalledTimes(2 + RECONNECT_DELAYS_MS.length);
  });

  test("stops probing and ignores an answer that arrives after unmount", async () => {
    let settle: ((connection: typeof healthy) => void) | undefined;
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve as (connection: typeof healthy) => void;
        }),
    );
    const { unmount } = renderHook(() => useConnectionRecovery({ probe }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    expect(probe).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      settle?.(healthy);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    });

    expect(probe).toHaveBeenCalledOnce();
  });

  test("watches nothing while it is disabled", async () => {
    const probe = vi.fn().mockResolvedValue(healthy);
    renderHook(() => useConnectionRecovery({ probe, enabled: false }));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    });

    expect(probe).not.toHaveBeenCalled();
  });
});
