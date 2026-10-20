import Link from "next/link";
import { Suspense } from "react";
import type { ReadingArticle } from "@/lib/curation";
import { fetchLiveArticle, type LiveBlock } from "@/lib/liveArticle";
import { INK, MUTED, RULE, SURFACE, day } from "./ui";

/** A name to mark in the text, and why it is there. */
export interface ReaderTerm {
  text: string;
  /** owner: the record's own figure · figure: another tracked one · candidate: a new name */
  kind: "owner" | "figure" | "candidate";
  /** Who it marks, for the hover title. */
  label: string;
}

const MARK: Record<ReaderTerm["kind"], React.CSSProperties> = {
  owner: { background: "#f3e6c9", color: INK },
  figure: { background: "#dfe9e0", color: INK },
  candidate: { background: "transparent", color: INK, borderBottom: "2px dashed var(--color-clay)" },
};

const KIND_LABEL: Record<ReaderTerm["kind"], string> = {
  owner: "pelaku",
  figure: "tokoh terlacak",
  candidate: "nama baru",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where the terms occur in one paragraph. Tracked names match regardless of
 * case, as attribution does; a new name only as mined, since its capital is
 * all that made it a name. Overlaps go to the longer match ("Ahmad Muzani"
 * over "Muzani").
 */
function marks(text: string, terms: ReaderTerm[]): { start: number; end: number; term: ReaderTerm }[] {
  const found: { start: number; end: number; term: ReaderTerm }[] = [];
  for (const term of terms) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(term.text)}(?![\\p{L}\\p{N}])`,
      term.kind === "candidate" ? "gu" : "giu"
    );
    for (const m of text.matchAll(re)) {
      found.push({ start: m.index, end: m.index + m[0].length, term });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof found = [];
  for (const f of found) {
    if (kept.length && f.start < kept[kept.length - 1].end) continue;
    kept.push(f);
  }
  return kept;
}

function Paragraph({ text, terms }: { text: string; terms: ReaderTerm[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of marks(text, terms)) {
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(
      <mark key={m.start} title={`${m.term.label} · ${KIND_LABEL[m.term.kind]}`} style={{ ...MARK[m.term.kind], padding: "0 1px", borderRadius: 2 }}>
        {text.slice(m.start, m.end)}
      </mark>
    );
    at = m.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  // Site furniture the fetcher kept ("Baca juga: …", bylines) reads as noise
  // at body size; it stays, quieter, since it is sometimes the only date.
  const furniture = text.length < 60 || /^baca (juga|berita)/i.test(text);
  return (
    <p style={furniture
      ? { fontSize: 12.5, color: MUTED, margin: "0 0 8px", lineHeight: 1.5 }
      : { fontSize: 15.5, lineHeight: 1.7, color: INK, margin: "0 0 14px" }}>
      {parts}
    </p>
  );
}

/**
 * The reading pane: an article's text beside the curation forms, so a record
 * can be judged without leaving it. Server-rendered from the URL (?baca=), so
 * it needs no client script — /kurasi keeps working when an Access session
 * has lapsed.
 */
export function ArticleReader({ article, terms, closeHref }: {
  article: ReadingArticle;
  terms: ReaderTerm[];
  closeHref: string;
}) {
  const kinds = [...new Set(terms.map((t) => t.kind))];
  return (
    <article style={{ background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 6, padding: "18px 22px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, letterSpacing: "0.04em" }}>
          {article.source} · {day(article.published_at)}
        </span>
        <span style={{ display: "flex", gap: 14, fontSize: 12.5 }}>
          <a href={article.url} target="_blank" rel="noreferrer" style={{ color: MUTED }}>Buka di situs asli ↗</a>
          <Link href={closeHref} scroll={false} style={{ color: MUTED }}>Tutup ✕</Link>
        </span>
      </div>
      <h2 style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 21, lineHeight: 1.3, margin: "0 0 10px" }}>
        {article.title ?? article.url}
      </h2>
      {article.lang ? (
        <p style={{ fontSize: 12.5, color: "var(--color-clay)", margin: "0 0 12px" }}>
          Terjemahan mesin dari bahasa “{article.lang}”. Periksa kutipan di situs asli.
        </p>
      ) : null}
      {kinds.length ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, color: MUTED, margin: "0 0 14px", paddingBottom: 12, borderBottom: `1px solid ${RULE}` }}>
          {kinds.map((k) => (
            <span key={k}><mark style={{ ...MARK[k], padding: "0 4px", borderRadius: 2 }}>Nama</mark> {KIND_LABEL[k]}</span>
          ))}
        </div>
      ) : null}
      <Suspense fallback={<p style={{ fontSize: 13.5, color: MUTED, fontStyle: "italic" }}>Mengambil artikel dari {article.source}…</p>}>
        <ReaderBody article={article} terms={terms} />
      </Suspense>
    </article>
  );
}

/** Stored text this long is taken as the article; shorter, the site is asked. */
const ENOUGH = 1200;

/**
 * The article's text: what the pipeline stored, or — when it stored nothing,
 * a stub, or a paywall's first paragraphs — the page as its site serves it
 * now. Streamed, so a slow outlet holds up the pane and not the forms.
 */
async function ReaderBody({ article, terms }: { article: ReadingArticle; terms: ReaderTerm[] }) {
  const stored = article.paragraphs.join(" ").length;
  const live = article.truncated || stored < ENOUGH ? await fetchLiveArticle(article.url) : null;
  if (live && live.length > stored) {
    return (
      <>
        <p style={{ fontSize: 12, color: MUTED, margin: "0 0 14px" }}>
          {stored ? "Teks tersimpan terpotong; ini" : "Pipeline belum mengambil teksnya; ini"} dibaca langsung dari {article.source} barusan.
        </p>
        {live.blocks.map((b, i) => <LiveBlockView key={i} block={b} terms={terms} />)}
      </>
    );
  }
  if (article.paragraphs.length) {
    return (
      <>
        {article.truncated ? (
          <p style={{ fontSize: 12.5, color: "var(--color-clay)", margin: "0 0 12px" }}>
            Terpotong paywall {article.source}. Lanjutannya hanya di situs asli.
          </p>
        ) : null}
        {article.paragraphs.map((p, i) => <Paragraph key={i} text={p} terms={terms} />)}
      </>
    );
  }
  return (
    <>
      {article.lead ? <Paragraph text={article.lead} terms={terms} /> : null}
      <p style={{ fontSize: 13.5, color: MUTED, fontStyle: "italic", margin: 0 }}>
        Teksnya tidak bisa diambil, dari pipeline maupun langsung dari {article.source}. Baca di situs asli.
      </p>
    </>
  );
}

function LiveBlockView({ block: b, terms }: { block: LiveBlock; terms: ReaderTerm[] }) {
  if (b.kind === "img") {
    return (
      <figure style={{ margin: "4px 0 16px" }}>
        {/* The outlet's own photo, hotlinked: nothing is copied or stored. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={b.src} alt={b.caption} loading="lazy" referrerPolicy="no-referrer" style={{ width: "100%", height: "auto", borderRadius: 4, display: "block" }} />
        {b.caption ? <figcaption style={{ fontSize: 12, color: MUTED, marginTop: 5, lineHeight: 1.45 }}>{b.caption}</figcaption> : null}
      </figure>
    );
  }
  if (b.kind === "h") {
    return <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 600, margin: "18px 0 8px" }}>{b.text}</h3>;
  }
  if (b.kind === "quote") {
    return (
      <blockquote style={{ margin: "0 0 14px", padding: "2px 0 2px 14px", borderLeft: `3px solid ${RULE}` }}>
        <Paragraph text={b.text} terms={terms} />
      </blockquote>
    );
  }
  return <Paragraph text={b.text} terms={terms} />;
}
