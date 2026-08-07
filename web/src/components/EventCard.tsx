import Link from "next/link";
import OutletTile from "./OutletTile";
import SummaryList from "./SummaryList";
import { dayBadge, eventTypeChip, formatDateShort } from "@/lib/design";
import type { Peristiwa } from "@/lib/types";

/**
 * A peristiwa — an event belonging to no figure.
 *
 * Visually lighter than a RecordCard: no sentiment track, because public
 * reaction is collected per figure record, and no owner line. What it carries
 * instead is how widely it was reported, which is the reason it was published.
 *
 * `impact` is deliberately not shown. It is derived from outlet count alone, so
 * it duplicated "Dilaporkan N media" while phrasing it as a judgement about the
 * event's consequence — a claim the data does not support.
 */
export default function EventCard({
  peristiwa,
  bare = false,
}: {
  peristiwa: Peristiwa;
  bare?: boolean;
}) {
  const chip = eventTypeChip(peristiwa.event_type);
  const sources = peristiwa.sources ?? [];
  const related = peristiwa.related_figures ?? [];

  return (
    <article
      style={{
        position: "relative",
        background: "#efe9dc",
        border: "1px solid #ddd3bf",
        padding: peristiwa.image ? "0 0 16px" : "16px 18px",
        overflow: "hidden",
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

      {bare ? null : (
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
              borderRadius: 99,
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
        {peristiwa.title || "Tanpa judul"}
      </h3>

      {peristiwa.summary ? (
        <SummaryList summary={peristiwa.summary} size={13.5} />
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: related.length ? 10 : 0 }}>
        <span style={{ fontSize: 11.5, color: "#6b645b", fontWeight: 600 }}>
          Dilaporkan {peristiwa.outlet_count} media
        </span>
        <span aria-hidden style={{ display: "flex", alignItems: "center" }}>
          {sources.slice(0, 5).map((s) => (
            <OutletTile key={s.url} source={s.source} size={20} ring="#efe9dc" />
          ))}
        </span>
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
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: "#16130f",
                background: "#f6f2e9",
                border: "1px solid #d8cfba",
                borderRadius: 99,
                padding: "2px 10px",
                textDecoration: "none",
              }}
            >
              {f.name}
            </Link>
          ))}
        </div>
      ) : null}

      <details style={{ marginTop: 12 }}>
        <summary style={{ fontSize: 11.5, fontWeight: 700, color: "#8b2e1f", cursor: "pointer" }}>
          Artikel Sumber ({sources.length})
        </summary>
        <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
          {sources.map((s, i) => (
            <li key={s.url} style={{ borderTop: i ? "1px solid #e4dcc9" : "none" }}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "flex", gap: 11, padding: "9px 0", textDecoration: "none", color: "inherit" }}
              >
                <span style={{ flex: "none", display: "flex", alignItems: "center", paddingTop: 1 }}>
                  <OutletTile source={s.source} size={22} ring="#efe9dc" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{s.title}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "#7a7264", marginTop: 2 }}>
                    {s.source} · {formatDateShort(s.published_at)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </details>

      </div>
    </article>
  );
}
