"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** Fired by kurasi/error.tsx when an action or a page fails to render. */
export const ACTION_ERROR_EVENT = "kurasi:action-error";

/** Past this with no new page, say so rather than spin forever. */
const SLOW_MS = 15_000;

type Busy = { kind: "save" | "nav"; label: string; at: number };
type Toast = { tone: "ok" | "error" | "slow"; text: string };

/**
 * What the curator sees between a click and the server's answer, everywhere
 * in /kurasi. Every form here is a plain server action and every page a
 * server render, each a few seconds on a busy record, and on their own they
 * show nothing until the new page lands. This sits once in the layout:
 *
 * - a form submit marks its button (spinner, no second click), puts a clay
 *   bar across the top and a "Menyimpan…" note in the corner;
 * - a link to another page puts up the same bar ("Memuat…");
 * - when the new render arrives (the layout's `stamp` changes, or the
 *   address does), the marks come off and a save says "Tersimpan";
 * - when it fails, error.tsx fires ACTION_ERROR_EVENT and the note says so.
 *
 * Panel links are PanelPending's; this leaves them alone. Without script
 * the forms and links work as before, only silent.
 */
export function ActionFeedback({ stamp }: { stamp: string }) {
  const path = usePathname();
  const here = `${path}?${useSearchParams().toString()}`;
  const [busy, setBusy] = useState<Busy | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const seen = useRef({ stamp, here });
  const busyRef = useRef<Busy | null>(null);
  busyRef.current = busy;

  // A new render or a new address ends whatever was waiting.
  useEffect(() => {
    if (seen.current.stamp === stamp && seen.current.here === here) return;
    seen.current = { stamp, here };
    const b = busyRef.current;
    if (b) {
      setBusy(null);
      if (b.kind === "save") setToast({ tone: "ok", text: `Tersimpan · ${b.label}` });
    }
    clearMarks();
  }, [stamp, here]);

  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement;
      if (form.dataset.busy) {
        // Already on its way: a second click would answer twice.
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const isGet = (form.getAttribute("method") ?? "").toLowerCase() === "get";
      const submitter = e.submitter as HTMLElement | null;
      const label = clip(submitter?.textContent || form.getAttribute("aria-label") || (isGet ? "Mencari" : "Jawaban"));
      form.dataset.busy = "1";
      // After React has read the submitter for the form data.
      setTimeout(() => submitter?.setAttribute("data-pending", ""), 0);
      setToast(null);
      setBusy({ kind: isGet ? "nav" : "save", label, at: Date.now() });
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a || a.target === "_blank" || !a.href) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page: a hash jump, or a panel (PanelPending shows those).
      if (url.pathname === window.location.pathname) return;
      setToast(null);
      setBusy({ kind: "nav", label: clip(ownText(a) || "Halaman"), at: Date.now() });
    };
    const onError = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      clearMarks();
      setBusy(null);
      setToast({ tone: "error", text: message ? `Gagal: ${message}` : "Gagal menyimpan." });
    };
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener(ACTION_ERROR_EVENT, onError);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(ACTION_ERROR_EVENT, onError);
    };
  }, []);

  // Too long: let go of the button and say the server has not answered.
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => {
      clearMarks();
      setBusy(null);
      setToast({ tone: "slow", text: "Server belum menjawab. Muat ulang halaman untuk melihat apakah sudah tersimpan." });
    }, SLOW_MS);
    return () => clearTimeout(t);
  }, [busy]);

  // A result stays a moment, an error until dismissed.
  useEffect(() => {
    if (!toast || toast.tone === "error") return;
    const t = setTimeout(() => setToast(null), toast.tone === "ok" ? 2600 : 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const note: Toast | { tone: "busy"; text: string } | null = busy
    ? { tone: "busy", text: busy.kind === "save" ? `Menyimpan · ${busy.label}` : `Memuat · ${busy.label}` }
    : toast;

  return (
    <>
      {busy ? <div className="kurasi-progress" role="progressbar" aria-label="Memuat" /> : null}
      <div aria-live="polite" style={{ position: "fixed", right: 20, bottom: 20, zIndex: 60, maxWidth: "min(440px, calc(100vw - 32px))" }}>
        {note ? (
          <div
            role={note.tone === "error" ? "alert" : "status"}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
              fontSize: 13.5, lineHeight: 1.4, border: "1.5px solid var(--color-ink)", boxShadow: "4px 4px 0 var(--color-ink)",
              background: note.tone === "ok" ? "var(--color-sage-bg)" : note.tone === "error" ? "var(--color-warn-bg)" : "var(--color-cream)",
              color: note.tone === "ok" ? "var(--color-sage)" : note.tone === "error" ? "var(--color-clay)" : "var(--color-ink)",
              fontWeight: note.tone === "busy" ? 500 : 600,
            }}
          >
            {note.tone === "busy" ? <span className="panel-spinner" aria-hidden /> : note.tone === "ok" ? <span aria-hidden>✓</span> : <span aria-hidden>!</span>}
            <span style={{ flex: 1, minWidth: 0 }}>{note.text}</span>
            {note.tone === "error" || note.tone === "slow" ? (
              <button type="button" onClick={() => setToast(null)} aria-label="Tutup" style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", fontSize: 15, padding: 0 }}>✕</button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * A link's name for the note: its aria-label, else its own text without the
 * count a nav tab nests beside it ("Tokoh", not "Tokoh193"), else all of it.
 */
function ownText(a: HTMLAnchorElement): string {
  const label = a.getAttribute("aria-label");
  if (label) return label;
  const own = [...a.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(" ").trim();
  return own || a.textContent || "";
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/** Take the waiting marks off: React keeps the same elements across a refresh. */
function clearMarks() {
  document.querySelectorAll("[data-pending]").forEach((el) => el.removeAttribute("data-pending"));
  document.querySelectorAll<HTMLFormElement>("form[data-busy]").forEach((f) => delete f.dataset.busy);
}
