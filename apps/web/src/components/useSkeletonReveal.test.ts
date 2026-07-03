// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useSkeletonReveal } from "./useSkeletonReveal.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("useSkeletonReveal", () => {
  test("reports the skeleton layer mounted and not revealed while not ready", () => {
    const { result } = renderHook(() => useSkeletonReveal(false));

    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.revealed).toBe(false);
  });

  test("stacks content over the skeleton and flips to revealed once ready", () => {
    const { result, rerender } = renderHook(
      ({ ready }) => useSkeletonReveal(ready),
      { initialProps: { ready: false } },
    );

    rerender({ ready: true });

    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.revealed).toBe(true);
  });

  test("unmounts the skeleton layer once the reveal window completes", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ ready }) => useSkeletonReveal(ready),
      { initialProps: { ready: false } },
    );

    rerender({ ready: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(result.current.showSkeleton).toBe(false);
  });

  test("does not unmount the skeleton before the reveal window completes", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ ready }) => useSkeletonReveal(ready),
      { initialProps: { ready: false } },
    );

    rerender({ ready: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });

    expect(result.current.showSkeleton).toBe(true);
  });
});
