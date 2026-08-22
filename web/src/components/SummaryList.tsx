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

function shortenCitations(text: string): string {
  return text
    .replace(CITE, "[$1]")
    // The model punctuates between citations; runs of them read as one group.
    .replace(/\]\s*[,;]?\s*\[/g, "][")
    // A trailing "." after the last citation, and the space before the first.
    .replace(/\s+\[/g, " [")
    .replace(/\]\s*\.\s*$/, "]")
    .trim();
}

/** Text with the citation markers rendered as their own muted spans. */
function withCitations(text: string, size: number) {
  return shortenCitations(text)
    .split(CITE_SPLIT)
    .filter(Boolean)
    .map((part, i) =>
      CITE_SPLIT.test(part) ? (
        <span key={i} style={{ color: "#9b9285", fontSize: size - 2 }}>
          {part}
        </span>
      ) : (
        part
      )
    );
}

export default function SummaryList({
  summary,
  size = 14.5,
  color = "#3e382f",
}: {
  summary: string;
  size?: number;
  color?: string;
}) {
  const bullets = toBullets(summary);

  if (bullets.length === 0) {
    return (
      <p style={{ fontSize: size, lineHeight: 1.62, color, margin: "0 0 14px", whiteSpace: "pre-line" }}>
        {withCitations(contentLines(summary).join("\n"), size)}
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
          {withCitations(text, size)}
        </li>
      ))}
    </ul>
  );
}
