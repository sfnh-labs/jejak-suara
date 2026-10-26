import Link from "next/link";
import { Suspense } from "react";
import type { ReadingArticle } from "@/lib/curation";
import { fetchLiveArticle, type LiveBlock } from "@/lib/liveArticle";
import { FocusScroll } from "./FocusScroll";
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

/** The text with its names marked; `offset` keeps keys unique across pieces of one paragraph. */
function named(text: string, terms: ReaderTerm[], offset = 0): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of marks(text, terms)) {
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(
      <mark key={offset + m.start} title={`${m.term.label} · ${KIND_LABEL[m.term.kind]}`} style={{ ...MARK[m.term.kind], padding: "0 1px", borderRadius: 2 }}>
        {text.slice(m.start, m.end)}
      </mark>
    );
    at = m.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * The passage a curation point rests on, opened with "baca beritanya": the
 * paragraph it quotes gets a bar, and the sentence it turns on a highlight.
 */
export interface ReaderFocus {
  /** The point's paragraph, as stored (trimmed with "…" at either end). */
  paragraph: string;
  /** The sentence inside it the point turns on. */
  highlight: string | null;
}

function fold(s: string): string {
  return s.replace(/^…\s*|\s*…$/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Which of the paragraphs the focus is in. The stored paragraph was cut from
 * the same text, so its opening words (or its highlighted sentence, which
 * survives a different paragraph split) are found inside one of them.
 */
function focusAt(texts: string[], focus: ReaderFocus | undefined): number {
  if (!focus) return -1;
  const folded = texts.map(fold);
  const needles = [focus.highlight, focus.paragraph.replace(/^…\s*/, "").slice(0, 90), focus.paragraph.replace(/^…\s*/, "").slice(0, 40)]
    .map((n) => (n ? fold(n) : ""))
    .filter((n) => n.length >= 20);
  for (const n of needles) {
    const i = folded.findIndex((t) => t.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

/** Where the highlighted sentence is in the paragraph, whitespace and case aside. */
function highlightIn(text: string, highlight: string | null): [number, number] | null {
  const words = highlight?.trim().split(/\s+/).filter(Boolean);
  if (!words?.length) return null;
  const m = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "iu").exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

function Paragraph({ text, terms, focus }: { text: string; terms: ReaderTerm[]; focus?: ReaderFocus }) {
  let parts: React.ReactNode[];
  const hl = focus ? highlightIn(text, focus.highlight) : null;
  if (hl) {
    parts = [
      ...named(text.slice(0, hl[0]), terms),
      <mark key="fokus" style={{ background: "#f3dfa6", color: INK, padding: "1px 2px", borderRadius: 2 }}>
        {named(text.slice(hl[0], hl[1]), terms, hl[0])}
      </mark>,
      ...named(text.slice(hl[1]), terms, hl[1]),
    ];
  } else {
    parts = named(text, terms);
  }
  // Site furniture the fetcher kept ("Baca juga: …", bylines) reads as noise
  // at body size; it stays, quieter, since it is sometimes the only date.
  const furniture = !focus && (text.length < 60 || /^baca (juga|berita)/i.test(text));
  return (
    <p
      data-reader-focus={focus ? "" : undefined}
      style={furniture
        ? { fontSize: 12.5, color: MUTED, margin: "0 0 8px", lineHeight: 1.5 }
        : {
            fontSize: 15.5, lineHeight: 1.7, color: INK, margin: "0 0 14px",
            ...(focus ? { boxShadow: "-12px 0 0 -9px var(--color-clay)", scrollMarginTop: 120 } : {}),
          }}
    >
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
export function ArticleReader({ article, terms, closeHref, focus }: {
  article: ReadingArticle;
  terms: ReaderTerm[];
  closeHref: string;
  focus?: ReaderFocus;
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
        <ReaderBody article={article} terms={terms} focus={focus} />
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
async function ReaderBody({ article, terms, focus }: { article: ReadingArticle; terms: ReaderTerm[]; focus?: ReaderFocus }) {
  const stored = article.paragraphs.join(" ").length;
  const live = article.truncated || stored < ENOUGH ? await fetchLiveArticle(article.url) : null;
  if (live && live.length > stored) {
    const at = focusAt(live.blocks.map((b) => (b.kind === "img" ? "" : b.text)), focus);
    return (
      <>
        <p style={{ fontSize: 12, color: MUTED, margin: "0 0 14px" }}>
          {stored ? "Teks tersimpan terpotong; ini" : "Pipeline belum mengambil teksnya; ini"} dibaca langsung dari {article.source} barusan.
        </p>
        <FocusMissing focus={focus} at={at} />
        {live.blocks.map((b, i) => <LiveBlockView key={i} block={b} terms={terms} focus={i === at ? focus : undefined} />)}
        {at >= 0 ? <FocusScroll token={`${article.id}:${at}`} /> : null}
      </>
    );
  }
  if (article.paragraphs.length) {
    const at = focusAt(article.paragraphs, focus);
    return (
      <>
        {article.truncated ? (
          <p style={{ fontSize: 12.5, color: "var(--color-clay)", margin: "0 0 12px" }}>
            Terpotong paywall {article.source}. Lanjutannya hanya di situs asli.
          </p>
        ) : null}
        <FocusMissing focus={focus} at={at} />
        {article.paragraphs.map((p, i) => <Paragraph key={i} text={p} terms={terms} focus={i === at ? focus : undefined} />)}
        {at >= 0 ? <FocusScroll token={`${article.id}:${at}`} /> : null}
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

/** When the point's paragraph is not in this text (the site changed it since), say so rather than mark nothing silently. */
function FocusMissing({ focus, at }: { focus?: ReaderFocus; at: number }) {
  if (!focus || at >= 0) return null;
  return (
    <p style={{ fontSize: 12.5, color: "var(--color-clay)", margin: "0 0 12px" }}>
      Paragraf poin kurasi tidak ditemukan di teks ini; mungkin sudah diubah situsnya.
    </p>
  );
}

function LiveBlockView({ block: b, terms, focus }: { block: LiveBlock; terms: ReaderTerm[]; focus?: ReaderFocus }) {
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
        <Paragraph text={b.text} terms={terms} focus={focus} />
      </blockquote>
    );
  }
  return <Paragraph text={b.text} terms={terms} focus={focus} />;
}
