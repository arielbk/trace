import { useEffect, useRef, useState } from "react";

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
  /** Mount the real content layer (hidden until `revealed` flips). */
  showContent: boolean;
  /** Wrapper is in the revealed state — drives the CSS cross-fade. */
  revealed: boolean;
}

/**
 * Orchestrates the `t-skel` cross-fade with two guards the naive
 * "skeleton while isPending" approach lacks:
 *
 * - **Fast loads skip the skeleton.** Nothing paints until a load outlasts
 *   `delayMs`; a quicker fetch jumps straight to revealed content, so it reads
 *   as instant instead of flashing a placeholder.
 * - **The reveal is a true cross-fade.** react-query yields no content while
 *   pending, and a CSS transition can't animate an element that mounts already
 *   in its final state. So on ready we mount the content hidden alongside the
 *   still-visible skeleton, then flip `revealed` on the next frame — giving the
 *   browser a start frame to animate from. The skeleton unmounts after the
 *   reveal window (`REVEAL_MS`) elapses.
 */
export function useSkeletonReveal(
  ready: boolean,
  { delayMs = DEFAULT_DELAY_MS, minVisibleMs = DEFAULT_MIN_VISIBLE_MS }: SkeletonRevealOptions = {},
): SkeletonRevealState {
  // Mounting already-ready (cached data) skips straight to content.
  const [phase, setPhase] = useState<Phase>(ready ? "done" : "pre");
  const [revealed, setRevealed] = useState(ready);
  const shownAt = useRef<number | null>(null);

  // pre: wait out the delay. If ready lands first, reveal instantly (no
  // skeleton); otherwise promote to the skeleton phase and remember when.
  useEffect(() => {
    if (phase !== "pre") return;
    if (ready) {
      setPhase("done");
      setRevealed(true);
      return;
    }
    const timer = setTimeout(() => {
      shownAt.current = Date.now();
      setPhase("skeleton");
    }, delayMs);
    return () => clearTimeout(timer);
  }, [phase, ready, delayMs]);

  // skeleton: once ready, hold for the min-visible window, then advance to the
  // reveal phase (which mounts the content). The frame-flip that starts the
  // cross-fade lives in the reveal effect below — doing it here would schedule
  // the rAF and then immediately cancel it, because setPhase("reveal") changes
  // `phase` and re-runs this effect's cleanup before the frame lands.
  useEffect(() => {
    if (phase !== "skeleton" || !ready) return;
    const elapsed = Date.now() - (shownAt.current ?? Date.now());
    const wait = Math.max(0, minVisibleMs - elapsed);
    const timer = setTimeout(() => setPhase("reveal"), wait);
    return () => clearTimeout(timer);
  }, [phase, ready, minVisibleMs]);

  // reveal: content is now mounted hidden alongside the skeleton. Flip revealed
  // on the next frame so the browser has a start frame to cross-fade from, then
  // drop the skeleton layer once the reveal window elapses. `revealed` is not a
  // dependency, so setting it does not re-run (and cancel) this effect.
  useEffect(() => {
    if (phase !== "reveal") return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setRevealed(true));
    });
    const timer = setTimeout(() => setPhase("done"), REVEAL_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [phase]);

  return {
    showSkeleton: phase === "skeleton" || phase === "reveal",
    showContent: phase === "reveal" || phase === "done",
    revealed,
  };
}
