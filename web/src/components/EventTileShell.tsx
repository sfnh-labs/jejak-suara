"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * The interactive frame of an EventTile: the tile is a button that pins its
 * callout open, for keyboard and touch. A pointer needs none of this — hover
 * opens the callout in CSS — so the state here only covers a click, and a
 * click elsewhere or Escape lets it go again.
 */
export default function EventTileShell({
  label,
  tile,
  children,
}: {
  label: string;
  tile: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cell = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!cell.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={cell} className="ev-cell" data-open={open ? "" : undefined}>
      <button
        type="button"
        className="ev-tile-button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${label} — detail peristiwa`}
        onClick={() => setOpen((v) => !v)}
      >
        {tile}
      </button>
      <div id={id} className="ev-detail" role="region" aria-label="Detail peristiwa">
        <div className="ev-detail-inner">
          <div className="callout">{children}</div>
        </div>
      </div>
    </div>
  );
}
