// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SkeletonReveal, useSkeletonReveal } from "./SkeletonReveal.tsx";

const OPTS = { delayMs: 100, minVisibleMs: 200 } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSkeletonReveal", () => {
  test("paints nothing while a load is still under the delay threshold", () => {
    const { result } = renderHook(() => useSkeletonReveal(false, OPTS));

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.showContent).toBe(false);
    expect(result.current.revealing).toBe(false);
  });

  test("shows the pulsing skeleton once loading outlasts the delay", async () => {
    const { result } = renderHook(() => useSkeletonReveal(false, OPTS));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.showContent).toBe(false);
    expect(result.current.revealing).toBe(false);
  });

  test("a sub-threshold load skips the skeleton and shows content instantly", async () => {
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
    // No cross-fade for a load that never painted a skeleton.
    expect(result.current.revealing).toBe(false);
  });

  test("mounting already-ready shows content immediately without a skeleton", () => {
    const { result } = renderHook(() => useSkeletonReveal(true, OPTS));

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.showContent).toBe(true);
    expect(result.current.revealing).toBe(false);
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

    // Cross the min-visible window: content mounts alongside the still-up
    // skeleton and the cross-fade starts in the same commit.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.showContent).toBe(true);
    expect(result.current.revealing).toBe(true);
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
    // Cross the min-visible window so the cross-fade starts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.revealing).toBe(true);
    // Now let the reveal window elapse so the skeleton layer unmounts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.showContent).toBe(true);
    expect(result.current.revealing).toBe(false);
  });
});

describe("SkeletonReveal", () => {
  test("renders nothing before the skeleton delay elapses", () => {
    const { container } = render(
      <SkeletonReveal
        state={{ showSkeleton: false, showContent: false, revealing: false }}
        skeleton={<p>bars</p>}
      >
        <p>content</p>
      </SkeletonReveal>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  test("renders the skeleton layer pulsing, hidden from assistive tech", () => {
    const { container } = render(
      <SkeletonReveal
        state={{ showSkeleton: true, showContent: false, revealing: false }}
        skeleton={<p>bars</p>}
      >
        <p>content</p>
      </SkeletonReveal>,
    );

    const skeleton = container.querySelector(".t-skel-skeleton")!;
    expect(skeleton).toHaveClass("is-pulsing");
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".t-skel")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".t-skel-content")).toBeNull();
  });

  test("mounts both layers with is-revealed during the cross-fade", () => {
    const { container } = render(
      <SkeletonReveal
        state={{ showSkeleton: true, showContent: true, revealing: true }}
        skeleton={<p>bars</p>}
      >
        <p>content</p>
      </SkeletonReveal>,
    );

    expect(container.querySelector(".t-skel")).toHaveClass("is-revealed");
    expect(container.querySelector(".t-skel-skeleton")).not.toHaveClass("is-pulsing");
    expect(container.querySelector(".t-skel-content")).not.toBeNull();
  });

  test("renders content only, without the reveal class, once done", () => {
    const { container } = render(
      <SkeletonReveal
        state={{ showSkeleton: false, showContent: true, revealing: false }}
        skeleton={<p>bars</p>}
      >
        <p>content</p>
      </SkeletonReveal>,
    );

    expect(container.querySelector(".t-skel")).not.toHaveClass("is-revealed");
    expect(container.querySelector(".t-skel-skeleton")).toBeNull();
    expect(container.querySelector(".t-skel")).not.toHaveAttribute("aria-busy");
  });
});
