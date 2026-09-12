// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BrowserPairing } from "./BrowserPairing.tsx";
import { LocalTraceSource } from "../lib/trace-data-source.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("shows only the short code and connects this tab after terminal approval", async () => {
  vi.useFakeTimers();
  const secret = "s".repeat(43),
    token = "t".repeat(43);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { code: "ABCD-1234", secret, expiresAt: Date.now() + 300_000 },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ status: "pending" }, { status: 202 }),
    )
    .mockResolvedValueOnce(Response.json({ status: "approved", token }));
  vi.stubGlobal("fetch", fetch);
  const onApproved = vi.fn().mockResolvedValue(undefined);
  render(
    <BrowserPairing
      source={new LocalTraceSource("http://127.0.0.1:4317")}
      onApproved={onApproved}
    />,
  );
  await act(async () => {});
  expect(screen.getByText("eqnx pair ABCD-1234")).toBeVisible();
  expect(document.body.textContent).not.toContain(secret);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(onApproved).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(onApproved).toHaveBeenCalledTimes(1);
  expect(
    localStorage.getItem("trace.bridgeCredential:http://127.0.0.1:4317"),
  ).toBe(token);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("expires the command and cancels polling when leaving the page", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(
    Response.json(
      {
        code: "ABCD-1234",
        secret: "s".repeat(43),
        expiresAt: Date.now() + 500,
      },
      { status: 201 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <BrowserPairing
      source={new LocalTraceSource("http://127.0.0.1:4317")}
      onApproved={vi.fn()}
    />,
  );
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screen.getByText(/This command has expired/)).toBeVisible();
  expect(
    screen.queryByText("eqnx pair ABCD-1234"),
  ).not.toBeInTheDocument();
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("leaving a waiting page aborts its request and stops future polls", async () => {
  vi.useFakeTimers();
  let pollSignal: AbortSignal | undefined;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        code: "ABCD-1234",
        secret: "s".repeat(43),
        expiresAt: Date.now() + 300_000,
      }),
    )
    .mockImplementationOnce((_url, init) => {
      pollSignal = init.signal;
      return new Promise(() => {});
    });
  vi.stubGlobal("fetch", fetch);
  const onApproved = vi.fn();
  const view = render(
    <BrowserPairing
      source={new LocalTraceSource("http://127.0.0.1:4317")}
      onApproved={onApproved}
    />,
  );
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(pollSignal?.aborted).toBe(false);
  view.unmount();
  expect(pollSignal?.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(onApproved).not.toHaveBeenCalled();
});
