import Link from "next/link";
import { SourcesDisclosure } from "./SourceList";
import SummaryList, { withoutTitleRepeats } from "./SummaryList";
import { dayBadge, eventTypeChip } from "@/lib/design";
import type { Peristiwa } from "@/lib/types";

/**
 * A peristiwa — an event belonging to no figure.
 *
 * Visually lighter than a RecordCard: no sentiment track, because public
 * reaction is collected per figure record, and no owner line. How widely it
 * was reported — the reason it was published — shows in the sources toggle's
 * outlet marks; a separate "Dilaporkan N media" line only repeated it.
 *
 * `impact` is deliberately not shown. It is derived from outlet count alone, so
 * it repeats the sources while phrasing them as a judgement about the event's
 * consequence — a claim the data does not support.
 */
export default function EventCard({
  peristiwa,
  bare = false,
  showDate = true,
}: {
  peristiwa: Peristiwa;
  bare?: boolean;
  /** False when the card repeats the day of the one above it in the feed. */
  showDate?: boolean;
}) {
  const chip = eventTypeChip(peristiwa.event_type);
  const sources = peristiwa.sources ?? [];
  const related = peristiwa.related_figures ?? [];
  const { title, summary } = withoutTitleRepeats(peristiwa.title, peristiwa.summary);

  return (
    <article
      style={{
        position: "relative",
        background: "#efe9dc",
        border: "1px solid #ddd3bf",
        padding: peristiwa.image ? "0 0 16px" : "16px 18px",
        // No overflow clipping: it would cut off the citation tooltips. The
        // image is square-cornered and full-bleed, so it needs none.
      }}
    >
      {peristiwa.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={peristiwa.image}
          alt=""
          style={{ width: "100%", aspectRatio: "16 / 11", objectFit: "cover", display: "block", marginBottom: 14 }}
        />
      ) : null}

      <div style={{ padding: peristiwa.image ? "0 18px" : 0 }}>

      {bare || !showDate ? null : (
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "#7a7264", marginBottom: 8 }}>
          {dayBadge(peristiwa.event_date)}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {peristiwa.event_type ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: chip.color,
              background: chip.bg,
              border: `1px solid ${chip.border}`,
              // Square-cornered: rounded pills on this site are links.
              borderRadius: 2,
              padding: "2px 10px",
            }}
          >
            {peristiwa.event_type}
          </span>
        ) : null}
        {peristiwa.scope ? (
          <span style={{ fontSize: 11.5, color: "#7a7264" }}>{peristiwa.scope}</span>
        ) : null}
      </div>

      <h3
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 600,
          fontSize: "clamp(18px, 3vw, 21px)",
          lineHeight: 1.2,
          margin: "0 0 8px",
          letterSpacing: "-0.01em",
        }}
      >
        {title || "Tanpa judul"}
      </h3>

      {summary ? (
        <SummaryList summary={summary} sources={sources} size={13.5} />
      ) : null}

      {/* Same place and control as on a record card. */}
      <div style={{ marginBottom: related.length ? 12 : 0 }}>
        <SourcesDisclosure sources={sources} />
      </div>

      {related.length ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285" }}>
            Tokoh terkait
          </span>
          {related.map((f) => (
            <Link
              key={f.id}
              href={`/tokoh/${f.id}`}
              className="pill-link"
              style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 10px" }}
            >
              {f.name}
            </Link>
          ))}
        </div>
      ) : null}


      </div>
    </article>
  );
}
