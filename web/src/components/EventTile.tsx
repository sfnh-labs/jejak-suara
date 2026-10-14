import EventTileShell from "./EventTileShell";
import OutletTile from "./OutletTile";
import { EventBody } from "./EventCard";
import { withoutTitleRepeats } from "./SummaryList";
import { topicBanner, topicLabel, topicOf } from "@/lib/topics";
import type { Peristiwa } from "@/lib/types";

/**
 * A peristiwa on the home feed: only its banner and title. Everything else
 * opens in a callout beside it, over the record column — on hover, on focus,
 * or on a tap. The callout's content is the same EventBody the full card
 * shows, so the two never drift apart.
 */
export default function EventTile({ peristiwa }: { peristiwa: Peristiwa }) {
  const topic = topicOf(peristiwa);
  const { title } = withoutTitleRepeats(peristiwa.title, peristiwa.summary);
  const sources = peristiwa.sources ?? [];
  const outlets = [...new Map(sources.map((s) => [s.source, s])).values()];

  // Spans throughout: this sits inside a <button>, which takes phrasing
  // content only. The button's label carries the title for a screen reader.
  const tile = (
    <span className="ev-card">
      <span className="ev-banner" style={{ background: topicBanner(topic) }}>
        {peristiwa.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={peristiwa.image} alt="" className="ev-banner-img" />
        ) : (
          <span aria-hidden className="ev-banner-waves waves" />
        )}
        <span aria-hidden className="ev-banner-shade" />
        <span className="ev-banner-text">
          <span className="ev-kicker">Peristiwa — {topicLabel(topic)}</span>
          <span className="ev-title">{title || "Tanpa judul"}</span>
        </span>
      </span>
      <span className="ev-foot">
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden style={{ display: "flex", alignItems: "center", paddingLeft: 5 }}>
            {outlets.slice(0, 5).map((s) => (
              <OutletTile key={s.source} source={s.source} size={20} ring="var(--color-event)" />
            ))}
          </span>
          <span className="ev-count">{outlets.length} media</span>
        </span>
        <span aria-hidden className="ev-hint">Detail →</span>
      </span>
    </span>
  );

  return (
    <EventTileShell label={title || "Peristiwa"} tile={tile}>
      <EventBody peristiwa={peristiwa} size={14.5} heading="h4" titleSize="24px" />
    </EventTileShell>
  );
}
