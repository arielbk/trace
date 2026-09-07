// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  HttpError,
  LocalTraceSource,
  SameOriginTraceSource,
  TraceDataSourceProvider,
  createTraceDataSource,
  useTraceDataSource,
} from "./trace-data-source.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("TraceDataSource", () => {
  test("the same-origin source preserves the bundled board API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const source = new SameOriginTraceSource();

    await source.request("/api/tasks");

    expect(source.capabilities).toMatchObject({
      requiresConnection: false,
      taskDetails: true,
      taskMutations: true,
      account: true,
      sync: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks");
  });

  test("the local source targets loopback and exposes only its supported surface", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const source = new LocalTraceSource("http://127.0.0.1:4317");

    await source.request("/api/tasks", { method: "GET" });

    expect(source.capabilities).toMatchObject({
      requiresConnection: true,
      taskDetails: false,
      taskMutations: false,
      account: false,
      sync: false,
    });
    expect(source.protocolVersion).toBeTypeOf("number");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/tasks",
      expect.objectContaining({
        method: "GET",
        targetAddressSpace: "loopback",
      }),
    );
  });

  test("selects a source from configuration without exposing transport to components", () => {
    expect(createTraceDataSource("")).toBeInstanceOf(SameOriginTraceSource);
    expect(createTraceDataSource("  ")).toBeInstanceOf(SameOriginTraceSource);
    expect(createTraceDataSource("http://127.0.0.1:4317")).toBeInstanceOf(
      LocalTraceSource,
    );
  });

  test("performs the versioned connection handshake through the source", async () => {
    const handshake = {
      service: "trace" as const,
      version: "0.1.0",
      protocolVersion: 1,
      capabilities: ["tasks:list"] as const,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(handshake), { status: 200 }),
    );
    const source = new LocalTraceSource("http://127.0.0.1:4317");

    await expect(source.connect()).resolves.toEqual(handshake);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/connection",
      expect.objectContaining({ targetAddressSpace: "loopback" }),
    );
  });

  test("preserves the handshake HTTP status for connection diagnostics", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 403 }),
    );
    const source = new LocalTraceSource("http://127.0.0.1:4317");

    await expect(source.connect()).rejects.toBeInstanceOf(HttpError);
    await expect(source.connect()).rejects.toMatchObject({ status: 403 });
  });

  test("exchanges a fragment pairing secret, stores the credential, and removes the fragment", async () => {
    const pairingSecret = "p".repeat(43);
    const credential = "c".repeat(43);
    window.history.replaceState({}, "", `/#trace-pair=${pairingSecret}`);
    localStorage.clear();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ token: credential }, { status: 200 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            service: "trace",
            protocolVersion: 1,
          },
          { status: 200 },
        ),
      );
    const source = new LocalTraceSource("http://127.0.0.1:4317");

    await source.connect();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:4317/api/pairing",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ secret: pairingSecret }),
        targetAddressSpace: "loopback",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:4317/api/connection",
      expect.objectContaining({
        headers: expect.any(Headers),
        targetAddressSpace: "loopback",
      }),
    );
    expect(
      (fetchMock.mock.calls[1]?.[1]?.headers as Headers).get("authorization"),
    ).toBe(`Bearer ${credential}`);
    expect(localStorage.getItem(source.credentialStorageKey)).toBe(credential);
    expect(window.location.hash).toBe("");
  });

  test("reconnects with the stored credential on a later visit", async () => {
    const origin = "http://127.0.0.1:4317";
    const credential = "c".repeat(43);
    const initial = new LocalTraceSource(origin);
    localStorage.setItem(initial.credentialStorageKey, credential);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { service: "trace", protocolVersion: 1 },
          { status: 200 },
        ),
      );

    const returning = new LocalTraceSource(origin);
    await returning.connect();

    expect(returning.connectAutomatically).toBe(true);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe(`Bearer ${credential}`);
  });

  test("removes a rejected pairing secret from the address bar", async () => {
    const pairingSecret = "p".repeat(43);
    window.history.replaceState({}, "", `/#trace-pair=${pairingSecret}`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const source = new LocalTraceSource("http://127.0.0.1:4317");

    await expect(source.connect()).rejects.toMatchObject({ status: 401 });

    expect(window.location.hash).toBe("");
    expect(localStorage.getItem(source.credentialStorageKey)).toBeNull();
  });

  test("provides the selected source to data hooks and UI capabilities", () => {
    const source = new LocalTraceSource("http://127.0.0.1:4317");
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TraceDataSourceProvider, { source }, children);

    const { result } = renderHook(() => useTraceDataSource(), { wrapper });

    expect(result.current).toBe(source);
  });
});
