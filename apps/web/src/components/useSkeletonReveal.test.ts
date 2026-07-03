// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useSkeletonReveal } from "./useSkeletonReveal.ts";

const OPTS = { delayMs: 100, minVisibleMs: 200 } as const;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSkeletonReveal", () => {
  test("paints nothing while a load is still under the delay threshold", () => {
    const { result } = renderHook(() => useSkeletonReveal(false, OPTS));

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.showContent).toBe(false);
    expect(result.current.revealed).toBe(false);
  });

  test("shows the pulsing skeleton once loading outlasts the delay", async () => {
    const { result } = renderHook(() => useSkeletonReveal(false, OPTS));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.showContent).toBe(false);
    expect(result.current.revealed).toBe(false);
  });

  test("a sub-threshold load skips the skeleton and reveals instantly", async () => {
    const { result, rerender } = renderHook(
      ({ ready }) => useSkeletonReveal(ready, OPTS),
      { initialProps: { ready: false } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    rerender({ ready: true });

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.showContent).toBe(true);
    expect(result.current.revealed).toBe(true);
  });

  test("mounting already-ready reveals immediately without a skeleton", () => {
    const { result } = renderHook(() => useSkeletonReveal(true, OPTS));

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.showContent).toBe(true);
    expect(result.current.revealed).toBe(true);
  });

  test("holds the skeleton for the min-visible window, then cross-fades content in", async () => {
    const { result, rerender } = renderHook(
      ({ ready }) => useSkeletonReveal(ready, OPTS),
      { initialProps: { ready: false } },
    );

    // Delay elapses → skeleton is up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ ready: true });

    // Ready, but the min-visible window has not elapsed: content not yet mounted.
    expect(result.current.showContent).toBe(false);
    expect(result.current.showSkeleton).toBe(true);

    // Cross the min-visible window: content mounts hidden alongside the still-up
    // skeleton, but the reveal waits for the next-frame flip.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.showContent).toBe(true);

    // Let the two-frame reveal run → wrapper flips revealed, cross-fade in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.showContent).toBe(true);
    expect(result.current.revealed).toBe(true);
  });

  test("unmounts the skeleton once the reveal window completes", async () => {
    const { result, rerender } = renderHook(
      ({ ready }) => useSkeletonReveal(ready, OPTS),
      { initialProps: { ready: false } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ ready: true });
    // Cross the min-visible window + reveal frames so the wrapper flips revealed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.revealed).toBe(true);
    // Now let the reveal window elapse so the skeleton layer unmounts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.showContent).toBe(true);
    expect(result.current.revealed).toBe(true);
  });
});
