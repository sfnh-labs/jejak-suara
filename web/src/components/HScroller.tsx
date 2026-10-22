"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A horizontal row that scrolls, with previous/next arrows at its ends.
 *
 * Each arrow shows only while there is more to see in its direction, so a row
 * that fits shows none. Trackpad, touch and shift-wheel scrolling still work;
 * the arrows are for a mouse, which has no other way to reach the rest.
 */
export default function HScroller({
  children,
  label,
  inset = 0,
}: {
  children: React.ReactNode;
  label: string;
  /** How far the row starts in from its container's left edge (a label column
   *  beside it, say), so the prev arrow clears the container, not just the row. */
  inset?: number;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const update = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setCanPrev(el.scrollLeft > 1);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [update]);

  // Most of a screenful, so the last item of one step stays in view at the
  // start of the next and the reader keeps their place.
  const step = (dir: 1 | -1) => {
    const el = row.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="hscroller" style={{ ["--hs-inset" as string]: `${inset}px` }}>
      {/* A horizontal scroller clips vertically too, so the row gets 4px of
          headroom (taken back by the margin) for the bubble's hover lift. */}
      <div
        ref={row}
        role="group"
        aria-label={label}
        className="hscroller-row"
        style={{
          display: "flex",
          gap: 18,
          overflowX: "auto",
          padding: "4px 0 8px",
          marginTop: -4,
          scrollbarWidth: "none",
          // Each edge fades out only while there is more past it, so the
          // first and last items sit crisp once the row reaches its end.
          ["--fade-l" as string]: canPrev ? "56px" : "0px",
          ["--fade-r" as string]: canNext ? "56px" : "0px",
        }}
      >
        {children}
      </div>
      {canPrev ? (
        <button type="button" className="hscroller-arrow is-prev" aria-label="Sebelumnya" onClick={() => step(-1)}>
          ‹
        </button>
      ) : null}
      {canNext ? (
        <button type="button" className="hscroller-arrow is-next" aria-label="Berikutnya" onClick={() => step(1)}>
          ›
        </button>
      ) : null}
    </div>
  );
}
