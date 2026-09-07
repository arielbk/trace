import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveTraceApiOrigin,
  traceApiFetch,
  traceApiUrl,
} from "./api-origin.ts";

afterEach(() => vi.restoreAllMocks());

describe("resolveTraceApiOrigin", () => {
  test("keeps the existing same-origin API when no hosted origin is configured", () => {
    expect(resolveTraceApiOrigin(undefined)).toBe("");
    expect(traceApiUrl("/api/tasks", "")).toBe("/api/tasks");
  });

  test("normalizes a configured local API origin", () => {
    expect(resolveTraceApiOrigin(" http://127.0.0.1:4317/ ")).toBe(
      "http://127.0.0.1:4317",
    );
    expect(traceApiUrl("/api/tasks", "http://127.0.0.1:4317")).toBe(
      "http://127.0.0.1:4317/api/tasks",
    );
  });

  test("rejects values that are not HTTP origins", () => {
    expect(() => resolveTraceApiOrigin("javascript:alert(1)")).toThrow(
      "VITE_TRACE_API_ORIGIN must be an HTTP origin",
    );
    expect(() => resolveTraceApiOrigin("https://trace.test/path")).toThrow(
      "VITE_TRACE_API_ORIGIN must be an HTTP origin",
    );
  });

  test("marks hosted API requests as loopback network access", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await traceApiFetch(
      "/api/tasks",
      { method: "GET" },
      "http://127.0.0.1:4317",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/tasks",
      expect.objectContaining({
        method: "GET",
        targetAddressSpace: "loopback",
      }),
    );
  });
});
