import Link from "next/link";
import FigurePortrait from "./FigurePortrait";
import { SourcesDisclosure } from "./SourceList";
import StoryLine from "./StoryLine";
import SummaryList, { withoutTitleRepeats } from "./SummaryList";
import { dayBadge, firstName } from "@/lib/design";
import { topicChip, topicLabel, topicOf } from "@/lib/topics";
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
  return (
    <article
      style={{
        position: "relative",
        background: "var(--color-cream-dark)",
        border: "1px solid var(--color-parchment-light)",
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
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "var(--color-stone)", marginBottom: 8 }}>
            {dayBadge(peristiwa.event_date)}
          </div>
        )}
        <EventBody peristiwa={peristiwa} />
      </div>
    </article>
  );
}

/**
 * Everything a peristiwa says, without its frame: topic, title, summary,
 * sources and related figures. The card above wraps it in a tinted panel; the
 * home feed's EventTile shows it in a callout beside the tile.
 */
export function EventBody({
  peristiwa,
  size = 13.5,
  heading: Heading = "h3",
  titleSize = "clamp(18px, 3vw, 21px)",
}: {
  peristiwa: Peristiwa;
  /** Body text size; the summary's citations scale with it. */
  size?: number;
  heading?: "h3" | "h4";
  titleSize?: string;
}) {
  // The topic, not the model's KATEGORI: "Pernyataan" or "Penolakan" names the
  // kind of act and says nothing about what the event concerns.
  const topic = topicOf(peristiwa);
  const chip = topicChip(topic);
  const sources = peristiwa.sources ?? [];
  const related = peristiwa.related_figures ?? [];
  const { title, summary } = withoutTitleRepeats(peristiwa.title, peristiwa.summary);

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {topic !== "lainnya" ? (
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
            {topicLabel(topic)}
          </span>
        ) : null}
        {peristiwa.scope ? (
          <span style={{ fontSize: 11.5, color: "var(--color-stone)" }}>{peristiwa.scope}</span>
        ) : null}
      </div>

      <Heading
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 600,
          fontSize: titleSize,
          lineHeight: 1.2,
          margin: "0 0 8px",
          letterSpacing: "-0.01em",
        }}
      >
        {title || "Tanpa judul"}
      </Heading>

      {summary ? (
        <SummaryList summary={summary} sources={sources} size={size} />
      ) : null}

      {/* Same place and control as on a record card. */}
      <div style={{ marginBottom: related.length ? 12 : 0 }}>
        <SourcesDisclosure sources={sources} />
      </div>

      <RelatedFigures figures={related} />

      {peristiwa.story?.length ? (
        <div style={{ marginTop: 14 }}>
          <StoryLine steps={peristiwa.story} />
        </div>
      ) : null}
    </>
  );
}

/**
 * The figures an event names, as link pills: a small portrait and the name
 * they go by. The full name is the pill's tooltip.
 */
function RelatedFigures({ figures }: { figures: Peristiwa["related_figures"] }) {
  if (!figures.length) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--color-stone-light)" }}>
        Tokoh terkait
      </span>
      {figures.map((f) => (
        <Link
          key={f.id}
          href={`/tokoh/${f.id}`}
          className="pill-link"
          title={f.name}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontWeight: 600,
            lineHeight: 1,
            padding: "2px 9px 2px 2px",
          }}
        >
          <FigurePortrait figureId={f.id} name={f.name} width={18} round fontSize={8} hatchStep={3} />
          {firstName(f.name)}
        </Link>
      ))}
    </div>
  );
}
