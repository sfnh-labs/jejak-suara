"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** The address parameters that name a drawer (lib/panels.ts and ?baca=). */
const PANEL_PARAMS = ["panel", "baca"];

/**
 * A drawer that shows the moment a panel link is clicked. Panels are URL
 * parameters rendered on the server, and a record page takes a few seconds
 * to render, so without this a click shows nothing until the panel arrives.
 * This catches clicks on any link to the same page with a panel named, puts
 * up an empty drawer saying what is opening, and steps aside as soon as the
 * address changes and the real drawer is there.
 */
export function PanelPending() {
  const path = usePathname();
  const search = useSearchParams().toString();
  const [pending, setPending] = useState<{ label: string; from: string } | null>(null);
  const here = `${path}?${search}`;

  // The page arrived (or the click went nowhere new): drop the placeholder.
  if (pending && pending.from !== here) setPending(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Capture phase, before next/link's own handler prevents the default.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a || a.target === "_blank" || !a.href) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return;
      if (!PANEL_PARAMS.some((p) => url.searchParams.has(p))) return;
      if (url.search === window.location.search) return;
      const label = (a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      setPending({ label, from: `${window.location.pathname}?${window.location.search.slice(1)}` });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  if (!pending) return null;
  return (
    <>
      <div aria-hidden style={{ position: "fixed", inset: 0, background: "rgba(22, 19, 15, 0.38)", zIndex: 42 }} />
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: 560, maxWidth: "100%", zIndex: 43,
          background: "var(--color-cream)", borderLeft: "3px double var(--color-ink)", boxShadow: "-12px 0 40px rgba(22, 19, 15, 0.25)",
          display: "flex", flexDirection: "column", animation: "panel-in 160ms ease-out",
        }}
      >
        <div className="rule-heavy" style={{ padding: "18px 24px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="eyebrow">Membuka panel</div>
          <div style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 26, lineHeight: 1.15 }}>{pending.label || "Memuat…"}</div>
        </div>
        <div style={{ padding: "22px 24px", display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, color: "var(--color-stone)" }}>
            <span className="panel-spinner" aria-hidden />
            Memuat…
          </div>
          {[92, 78, 85, 60].map((w, i) => (
            <span key={i} className="panel-skeleton" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </>
  );
}
