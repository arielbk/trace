import { useEffect, useRef, useState } from "react";

// Must stay in sync with --reveal-dur in index.css's .t-skel block — the
// skeleton layer stays mounted for exactly one reveal cycle so the cross-fade
// (skeleton fading out while content fades in) has both layers to animate.
const REVEAL_MS = 400;

/**
 * Drives the `t-skel` cross-fade: react-query yields no content during
 * `isLoading`, but the reveal needs skeleton + real content mounted together
 * for one cycle. While not ready, only the skeleton is shown. Once ready
 * flips true, content stacks over the skeleton and `revealed` flips so CSS
 * cross-fades them; the skeleton unmounts after the reveal window elapses.
 */
export function useSkeletonReveal(ready: boolean): {
  showSkeleton: boolean;
  revealed: boolean;
} {
  const [showSkeleton, setShowSkeleton] = useState(!ready);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ready) {
      if (timer.current) clearTimeout(timer.current);
      setShowSkeleton(true);
      return;
    }

    timer.current = setTimeout(() => {
      timer.current = null;
      setShowSkeleton(false);
    }, REVEAL_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ready]);

  return { showSkeleton, revealed: ready };
}
