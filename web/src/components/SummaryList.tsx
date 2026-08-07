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

export function toBullets(summary: string): string[] {
  const lines = summary
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.some((l) => MARKER.test(l))) return [];
  return lines.map((l) => l.replace(MARKER, "").trim()).filter(Boolean);
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
        {summary}
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
          {text}
        </li>
      ))}
    </ul>
  );
}
