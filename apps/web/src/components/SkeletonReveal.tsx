import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

// Must stay in sync with --skel-reveal-dur in index.css's .t-skel block — the
// skeleton layer stays mounted for exactly one reveal cycle so the cross-fade
// (skeleton fading out while content fades in) has both layers to animate.
const REVEAL_MS = 250;

// Loads faster than this never paint a skeleton at all — the content just
// appears, so a quick fetch feels instant instead of flashing a placeholder.
const DEFAULT_DELAY_MS = 150;

// Once the skeleton *is* shown, keep it up at least this long so a fetch that
// lands right after the delay threshold doesn't blink the skeleton in and out.
const DEFAULT_MIN_VISIBLE_MS = 250;

// pre      — loading, but under the delay threshold: render nothing yet.
// skeleton — delay elapsed while still loading: skeleton mounted + pulsing.
// reveal   — ready: content mounted alongside the skeleton for one cross-fade.
// done     — reveal window elapsed (or a sub-threshold load): content only.
type Phase = "pre" | "skeleton" | "reveal" | "done";

export interface SkeletonRevealOptions {
  /** Delay before a still-pending load shows its skeleton. */
  delayMs?: number;
  /** Minimum time a shown skeleton stays up before revealing. */
  minVisibleMs?: number;
}

export interface SkeletonRevealState {
  /** Render the skeleton layer. */
  showSkeleton: boolean;
  /** Mount the real content layer. */
  showContent: boolean;
  /** Cross-fade in flight — drives the `is-revealed` class. */
  revealing: boolean;
}

/**
 * Orchestrates the `t-skel` cross-fade with two guards the naive
 * "skeleton while isPending" approach lacks:
 *
 * - **Fast loads skip the skeleton.** Nothing paints until a load outlasts
 *   `delayMs`; a quicker fetch jumps straight to revealed content, so it reads
 *   as instant instead of flashing a placeholder.
 * - **The reveal is a true cross-fade.** On ready the content mounts in the
 *   same commit that flips `revealing`; the CSS `@starting-style` rule gives
 *   the browser a first-frame value to fade the content in from, while the
 *   already-mounted skeleton fades out. The skeleton unmounts after the
 *   reveal window (`REVEAL_MS`) elapses.
 */
export function useSkeletonReveal(
  ready: boolean,
  { delayMs = DEFAULT_DELAY_MS, minVisibleMs = DEFAULT_MIN_VISIBLE_MS }: SkeletonRevealOptions = {},
): SkeletonRevealState {
  // Mounting already-ready (cached data) skips straight to content.
  const [phase, setPhase] = useState<Phase>(ready ? "done" : "pre");
  const shownAt = useRef<number | null>(null);

  // pre: wait out the delay. If ready lands first, skip straight to done (no
  // skeleton, no cross-fade); otherwise promote to skeleton and remember when.
  useEffect(() => {
    if (phase !== "pre") return;
    if (ready) {
      setPhase("done");
      return;
    }
    const timer = setTimeout(() => {
      shownAt.current = Date.now();
      setPhase("skeleton");
    }, delayMs);
    return () => clearTimeout(timer);
  }, [phase, ready, delayMs]);

  // skeleton: once ready, hold for the min-visible window, then start the
  // cross-fade.
  useEffect(() => {
    if (phase !== "skeleton" || !ready) return;
    const elapsed = Date.now() - (shownAt.current ?? Date.now());
    const wait = Math.max(0, minVisibleMs - elapsed);
    const timer = setTimeout(() => setPhase("reveal"), wait);
    return () => clearTimeout(timer);
  }, [phase, ready, minVisibleMs]);

  // reveal: drop the skeleton layer once the cross-fade window elapses.
  useEffect(() => {
    if (phase !== "reveal") return;
    const timer = setTimeout(() => setPhase("done"), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  return {
    showSkeleton: phase === "skeleton" || phase === "reveal",
    showContent: phase === "reveal" || phase === "done",
    revealing: phase === "reveal",
  };
}

/**
 * The `t-skel` cross-fade slot: renders the skeleton layer, the content layer,
 * or both (during the reveal), wired to a `useSkeletonReveal` state. The
 * skeleton is decorative — it renders `aria-hidden` inside a single wrapper so
 * the pulse animates one element, not every bar.
 */
export function SkeletonReveal({
  state,
  skeleton,
  children,
}: {
  state: SkeletonRevealState;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  const { showSkeleton, showContent, revealing } = state;
  if (!showSkeleton && !showContent) return null;

  return (
    <div
      className={cn("t-skel", revealing && "is-revealed")}
      aria-busy={!showContent || undefined}
    >
      {showSkeleton ? (
        <div
          className={cn("t-skel-skeleton", !revealing && "is-pulsing")}
          aria-hidden="true"
        >
          {skeleton}
        </div>
      ) : null}
      {showContent ? <div className="t-skel-content">{children}</div> : null}
    </div>
  );
}
