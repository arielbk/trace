import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

// Where the engine can interpolate max-height to an intrinsic keyword
// (Chrome/Edge 129+), expand to `max-content` so the open state tracks the
// content's real height even if it changes after the scrollHeight snapshot
// below (fonts, wrapping). Elsewhere, fall back to the measured pixel value —
// same animation, just pinned to the snapshot.
const EXPAND_TO_MAX_CONTENT =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("interpolate-size", "allow-keywords");

/**
 * Clamps long content to a max height with a bottom fade and a Show more / less
 * toggle. When the content fits, it renders the children untouched (no toggle).
 * Used to keep verbose state.md sections scannable on the task detail page.
 */
export function ClampedSection({
  children,
  maxHeight = 240,
}: {
  children: ReactNode;
  maxHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [children]);

  const overflows = contentHeight !== null && contentHeight > maxHeight + 8;
  const clamped = overflows && !expanded;

  return (
    <div>
      <div
        className={cn("left-off-clamp", clamped && "left-off-clamp-fade")}
        style={
          overflows
            ? {
                maxHeight: expanded
                  ? EXPAND_TO_MAX_CONTENT
                    ? "max-content"
                    : contentHeight
                  : maxHeight,
              }
            : undefined
        }
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {overflows ? (
        <button
          type="button"
          className="mt-2.5 inline-flex items-center gap-1 bg-transparent border-0 p-0 font-mono text-crumb text-text-muted cursor-pointer hover:text-accent"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
          <ChevronIcon up={expanded} />
        </button>
      ) : null}
    </div>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={up ? { transform: "rotate(180deg)" } : undefined}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
