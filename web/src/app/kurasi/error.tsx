"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ACTION_ERROR_EVENT } from "./ActionFeedback";

/**
 * When a curation action or page throws (an answer missing its figure, a
 * record that went away), say what failed inside the tools' own chrome, and
 * tell ActionFeedback so its "Menyimpan…" note turns into the failure.
 */
export default function KurasiError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(ACTION_ERROR_EVENT, { detail: error.message }));
  }, [error]);
  return (
    <div style={{ padding: "40px var(--frame-pad) 120px" }}>
      <div style={{ maxWidth: 640, border: "1.5px solid var(--color-ink)", boxShadow: "4px 4px 0 var(--color-ink)", background: "var(--color-warn-bg)", padding: "20px 22px", display: "grid", gap: 12 }}>
        <div className="eyebrow">Gagal</div>
        <h1 style={{ margin: 0, fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 26 }}>Perubahan belum tersimpan.</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "var(--color-mud)" }}>
          {error.message || "Server menolak permintaan ini."}
          {error.digest ? <span style={{ color: "var(--color-stone)" }}> ({error.digest})</span> : null}
        </p>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={reset} className="dir-more-btn" style={{ cursor: "pointer" }}>Coba lagi</button>
          <Link href="/kurasi" className="link-subtle" style={{ fontSize: 13 }}>Kembali ke antrean</Link>
        </div>
      </div>
    </div>
  );
}
