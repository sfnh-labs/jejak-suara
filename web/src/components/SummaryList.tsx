/**
 * A generated summary, rendered as the list it actually is.
 *
 * Summaries come out of the summarize stage as one fact per line, each prefixed
 * with a marker. Printing that string in a paragraph with `white-space:
 * pre-line` put the raw "- " characters on screen and gave the lines no
 * semantics — a screen reader read one run-on block rather than N items.
 *
 * The model does not always comply: it sometimes returns a single paragraph, or
 * numbers the lines instead. Anything that does not parse as a list falls back
 * to a paragraph rather than being forced into one bogus bullet.
 */

import ActorText from "./ActorText";
import Citation from "./Citation";
import { formatDateShort } from "@/lib/design";
import type { EventRecord } from "@/lib/types";

type Source = EventRecord["sources"][number];

/** Leading list markers the model emits: "- ", "* ", "• ", "1. ", "1) ". */
const MARKER = /^\s*(?:[-*•–—]|\d+[.)])\s+/;

// The prompt asks for a JUDUL/KATEGORI header above a "---" line, and the
// summarize stage cuts the body at that line. When the model omits the divider
// — or glues it to the category, "KATEGORI: Penyelidikan---" — the cut misses
// and the header survives into the stored text. It is not a fact about the
// event, and the category is already shown as a chip, so drop it here instead
// of rendering it as the first bullet.
const HEADER = /^(?:\*\*)?(?:JUDUL|KATEGORI)(?:\*\*)?\s*:/i;
const RULE = /^-{3,}$/;

function contentLines(summary: string): string[] {
  return summary
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !HEADER.test(l) && !RULE.test(l));
}

/** Lowercased words only, for comparing a title with a bullet. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Function words that a rewording adds or drops without changing what it says.
const FILLER = new Set(
  (
    "yang para di ke dari dan untuk dengan pada dalam itu ini akan telah sudah " +
    "juga atas bagi oleh serta sebagai terhadap kepada tersebut sangat lebih " +
    "secara bahwa adalah agar karena saat"
  ).split(" ")
);

/** The distinct words that carry meaning. */
function contentWords(text: string): string[] {
  return [...new Set(words(text).split(" ").filter((w) => w && !FILLER.has(w)))];
}

/**
 * A bullet counts as a rewording of the title when at least this share of its
 * content words are already in the title. Measured on 3,000 records: at 0.8
 * the bullets hidden are paraphrases ("Menolak isu mengundurkan diri dari
 * jabatan Menteri Agama" under "Menolak isu pengunduran diri dari jabatan
 * sebagai Menteri Agama"), at the cost of the odd extra word such as a place.
 */
const REWORDED = 0.8;

/**
 * A lead bullet that says everything the title does and more replaces it, when
 * at least this share of the title's content words recur in it (allowing for
 * verb prefixes) and it is short enough to read as a heading. This catches the
 * repeats the prefix test misses: "Mengirim 3 Ekskavator" over "Andre Rosiade
 * kirim 3 ekskavator untuk bantu penanganan banjir di Kota Padang".
 */
const COVERED = 0.6;
const HEADING_MAX_WORDS = 20;

/**
 * The forms a word may take without its verb prefix. Indonesian meN- drops
 * the root's first consonant ("mengirim" from "kirim", "menyatakan" from
 * "nyatakan"/"satakan"), so each candidate root is kept.
 */
function roots(w: string): string[] {
  const out = [w];
  const m = /^(meng|meny|mem|men|me|ber|di|ter)(.+)$/.exec(w);
  if (m && m[2].length >= 3) {
    const [, pre, rest] = m;
    out.push(rest);
    if (/^[aeiou]/.test(rest)) {
      if (pre === "meng") out.push("k" + rest);
      if (pre === "meny") out.push("s" + rest);
      if (pre === "mem") out.push("p" + rest);
      if (pre === "men") out.push("t" + rest);
    }
  }
  return out;
}

/** Share of `title`'s content words that `text` also has, in some form. */
function coverage(title: string, text: string): number {
  const t = contentWords(title);
  if (!t.length) return 0;
  const have = new Set(contentWords(text).flatMap(roots));
  return t.filter((w) => roots(w).some((r) => have.has(r))).length / t.length;
}

/** `text` without a leading mention of `subject`, who the card already names. */
function withoutSubject(text: string, subject?: string): string {
  if (!subject) return text;
  const name = subject.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^${name}\\s+`, "i"), "");
}

/**
 * The title and summary without the bullets that only repeat the title.
 *
 * The model often opens the list by repeating the JUDUL with a few more words —
 * "Menandatangani Peraturan Daerah" over "Menandatangani peraturan daerah
 * terkait pemberdayaan masyarakat dan desa". Dropping that bullet would lose
 * those words, so it becomes the heading instead. Any bullet left that says
 * the heading again in other words is then dropped.
 */
export function withoutTitleRepeats(
  title: string | null,
  summary: string | null,
  /** The figure the card is about; a bullet opening with their name drops it. */
  subject?: string
): { title: string | null; summary: string | null } {
  // The model occasionally cites inside the JUDUL itself; a heading is no
  // place for "[Sumber 14], [Sumber 17]".
  if (title) title = title.replace(/\s*\[\s*Sumber[^\]]*\]\s*[,;.]?/gi, "").trim() || null;
  if (!title || !summary) return { title, summary };
  let lines = summary.split("\n");
  const lead = lines.findIndex((l) => {
    const t = l.trim();
    return t && !HEADER.test(t) && !RULE.test(t);
  });
  // A summary that came back as a paragraph has no bullet to compare.
  if (lead < 0 || !MARKER.test(lines[lead])) return { title, summary };

  const text = withoutSubject(
    lines[lead]
      .replace(MARKER, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/[\s.]+$/, "")
      .trim(),
    subject
  );
  const t = words(title);
  const b = words(text);
  if (
    b === t ||
    b.startsWith(t + " ") ||
    (coverage(title, text) >= COVERED && b.split(" ").length <= HEADING_MAX_WORDS)
  ) {
    title = text.charAt(0).toUpperCase() + text.slice(1);
    lines = lines.filter((_, i) => i !== lead);
  }

  const inTitle = new Set(contentWords(title));
  lines = lines.filter((l) => {
    if (!MARKER.test(l)) return true;
    const c = contentWords(l);
    return c.length === 0 || c.filter((w) => inTitle.has(w)).length / c.length < REWORDED;
  });

  const rest = lines.join("\n");
  return { title, summary: contentLines(rest).length > 0 ? rest : null };
}

export function toBullets(summary: string): string[] {
  const lines = contentLines(summary);
  if (!lines.some((l) => MARKER.test(l))) return [];
  return lines.map((l) => l.replace(MARKER, "").trim()).filter(Boolean);
}

// The model cites as "[Sumber 1], [Sumber 2]", which at three citations is
// longer than the fact it is attached to. The word carries no information the
// bracket does not, so only the number is kept: "[1][2]".
const CITE = /\[\s*Sumber\s*(\d+)\s*\]/gi;
const CITE_SPLIT = /(\[\d+\])/;

// Some summaries put several in one bracket: "[Sumber 2, Sumber 3]".
const CITE_GROUP = /\[\s*Sumber\s*\d+(?:\s*[,;]\s*(?:Sumber\s*)?\d+)+\s*\]/gi;

function shortenCitations(text: string): string {
  return text
    .replace(CITE_GROUP, (group) => (group.match(/\d+/g) ?? []).map((n) => `[${n}]`).join(""))
    .replace(CITE, "[$1]")
    // The model punctuates between citations; runs of them read as one group.
    .replace(/\]\s*[,;]?\s*\[/g, "][")
    // A trailing "." after the last citation, and the space before the first.
    .replace(/\s+\[/g, " [")
    .replace(/\]\s*\.\s*$/, "]")
    .trim();
}

/**
 * Text with each [n] citation rendered as a link to the nth source, with a
 * tooltip naming the article and outlet. The summarizer numbers its documents
 * in the same order the sources arrive here (see data.ts). A number with no
 * matching source — a model miscount — stays plain muted text.
 */
function withCitations(text: string, size: number, sources: Source[], figureId?: string | null) {
  return shortenCitations(text)
    .split(CITE_SPLIT)
    .filter(Boolean)
    .map((part, i) => {
      if (!CITE_SPLIT.test(part)) return <ActorText key={i} text={part} exclude={figureId} />;
      const source = sources[Number(part.slice(1, -1)) - 1];
      if (!source) {
        return (
          <span key={i} style={{ color: "var(--color-stone-light)", fontSize: size - 2 }}>
            {part}
          </span>
        );
      }
      return (
        <Citation
          key={i}
          label={part}
          href={source.url}
          title={source.title}
          meta={source.published_at ? `${source.source} · ${formatDateShort(source.published_at)}` : source.source}
          size={size - 2}
        />
      );
    });
}

export default function SummaryList({
  summary,
  sources = [],
  size = 14.5,
  color = "var(--color-body)",
  figureId,
}: {
  summary: string;
  /** The entry's sources, in the order the summary's [n] numbers refer to. */
  sources?: Source[];
  size?: number;
  color?: string;
  /** The entry's own figure: other figures named in it link to their pages, this one does not. */
  figureId?: string | null;
}) {
  const bullets = toBullets(summary);

  if (bullets.length === 0) {
    return (
      <p style={{ fontSize: size, lineHeight: 1.62, color, margin: "0 0 14px", whiteSpace: "pre-line" }}>
        {withCitations(contentLines(summary).join("\n"), size, sources, figureId)}
      </p>
    );
  }

  return (
    <ul
      style={{
        margin: "0 0 14px",
        // The marker sits in the padding so wrapped lines align under the text
        // rather than under the bullet.
        padding: "0 0 0 18px",
        listStyle: "none",
        display: "grid",
        gap: 6,
      }}
    >
      {bullets.map((text, i) => (
        <li
          key={i}
          style={{
            position: "relative",
            fontSize: size,
            lineHeight: 1.55,
            color,
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: -18,
              top: "0.62em",
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#b9ab93",
            }}
          />
          {withCitations(text, size, sources, figureId)}
        </li>
      ))}
    </ul>
  );
}
