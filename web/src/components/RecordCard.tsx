import Link from "next/link";
import FigurePortrait from "./FigurePortrait";
import OutletTile from "./OutletTile";
import SentimentTrack from "./SentimentTrack";
import SummaryList from "./SummaryList";
import {
  dayBadge,
  eventTypeChip,
  formatCount,
  formatDateShort,
  percent,
  toDisplayScore,
} from "@/lib/design";
import type { EventRecord } from "@/lib/types";

/**
 * The core timeline card.
 *
 * The whole card is clickable, but it is NOT wrapped in a link: it contains a
 * sources disclosure and an outbound figure link, and nesting those inside an
 * anchor is invalid HTML with unpredictable click behaviour. Instead the
 * headline's link is stretched over the card with an ::after overlay, and the
 * genuinely interactive children sit above it on the z-axis.
 */
export default function RecordCard({
  record,
  showFigure = false,
  showSummary = true,
  showDate = true,
  bare = false,
}: {
  record: EventRecord;
  showFigure?: boolean;
  showSummary?: boolean;
  /** False for a record that repeats the day above it — the rail keeps a dot
   *  so the card still has its anchor, but the dateline is not restated. */
  showDate?: boolean;
  bare?: boolean;
}) {
  const display = toDisplayScore(record.sentiment_score);
  const { positive, neutral, negative, total } = record.stance;
  const chip = eventTypeChip(record.event_type);
  const href = `/tokoh/${record.figure_id}/${record.event_id}`;
  const sources = record.sources ?? [];

  return (
    <article
      style={{
        position: "relative",
        // The badge overhangs the rail by 14px and runs ~60px wide, so the
        // body has to start clear of it or the dateline sits on the chip.
        paddingLeft: bare ? 0 : 68,
        paddingBottom: 34,
        borderLeft: bare ? undefined : "1.5px solid #d8cfba",
      }}
    >
      {bare ? (
        showDate ? (
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "#7a7264", marginBottom: 9 }}>
            {dayBadge(record.event_date)}
          </div>
        ) : null
      ) : (
        <div style={{ position: "absolute", left: -14, top: 0 }}>
          {showDate ? (
            <span
              style={{
                display: "inline-block",
                background: "#6b645b",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.04em",
                padding: "4px 12px",
                borderRadius: 99,
                whiteSpace: "nowrap",
                boxShadow: "0 0 0 4px #f6f2e9",
              }}
            >
              {dayBadge(record.event_date)}
            </span>
          ) : (
            <span
              aria-hidden
              style={{
                display: "block",
                width: 9,
                height: 9,
                marginLeft: 9,
                marginTop: 7,
                background: "#c9bfa8",
                borderRadius: "50%",
                boxShadow: "0 0 0 4px #f6f2e9",
              }}
            />
          )}
        </div>
      )}

      {showFigure ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10, flexWrap: "wrap" }}>
          <FigurePortrait
            figureId={record.figure_id}
            name={record.figure_name}
            width={24}
            round
            fontSize={9}
            hatchStep={4}
          />
          <Link
            href={`/tokoh/${record.figure_id}`}
            className="fig-link"
            style={{ position: "relative", zIndex: 1, fontSize: 13, fontWeight: 700, color: "#16130f", textDecoration: "none" }}
          >
            {record.figure_name}
          </Link>
          {record.event_type ? (
            <>
              <span aria-hidden style={{ color: "#cbc0aa" }}>·</span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: chip.color }}>
                {record.event_type}
              </span>
            </>
          ) : null}
          {sources[0] ? (
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#7a7264" }}>{sources[0].source}</span>
          ) : null}
        </div>
      ) : (
        record.event_type && (
          <div style={{ marginBottom: 8 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: chip.color,
              }}
            >
              {record.event_type}
            </span>
          </div>
        )
      )}

      <h3
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 600,
          fontSize: "clamp(21px, 3.4vw, 25px)",
          lineHeight: 1.16,
          margin: "0 0 10px",
          letterSpacing: "-0.01em",
        }}
      >
        <Link href={href} className="card-link" style={{ color: "inherit", textDecoration: "none" }}>
          {record.title || "Tanpa judul"}
        </Link>
      </h3>

      {showSummary && record.summary ? (
        <SummaryList summary={record.summary} />
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <details style={{ position: "relative", zIndex: 1, flex: 1, minWidth: 0 }}>
          <summary
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: "#8b2e1f",
              cursor: "pointer",
              padding: "3px 0",
              listStyle: "none",
            }}
          >
            Artikel Sumber ({sources.length})
          </summary>
          <div style={{ background: "#efe9dc", border: "1px solid #ddd3bf", padding: "4px 16px 6px", marginTop: 10 }}>
            {sources.map((s, i) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "11px 0",
                  borderBottom: i === sources.length - 1 ? "none" : "1px solid #e4dcc9",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div style={{ flex: "none", display: "flex", alignItems: "center", paddingTop: 1 }}>
                  <OutletTile source={s.source} size={24} ring="#efe9dc" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#16130f", lineHeight: 1.3 }}>{s.title}</div>
                  <div style={{ fontSize: 11.5, color: "#7a7264", marginTop: 2 }}>
                    {s.source} · {formatDateShort(s.published_at)}
                  </div>
                </div>
                <div style={{ flex: "none", fontSize: 11.5, fontWeight: 600, color: "#8b2e1f", alignSelf: "center" }}>
                  Buka ↗
                </div>
              </a>
            ))}
          </div>
        </details>
        <div aria-hidden style={{ display: "flex", alignItems: "center", flex: "none", paddingLeft: 5 }}>
          {sources.slice(0, 4).map((s) => (
            <OutletTile key={s.url} source={s.source} size={22} />
          ))}
        </div>
      </div>

      {/* A single-source record carries no badge. The sources disclosure above
          already says how many outlets there are, and a warning strip on the
          most common case read as an accusation against the record itself. */}
      {record.single_source_flag ? null : (
        <div style={{ marginBottom: 14 }}>
          <span
            style={{
              display: "inline-block",
              fontSize: 11,
              fontWeight: 600,
              color: "#3d6b4a",
              background: "#e6efe8",
              border: "1px solid #b6d0bd",
              borderRadius: 2,
              padding: "3px 8px",
            }}
          >
            ✓ Dikuatkan {record.corroboration_count} media
          </span>
        </div>
      )}

      {display === null ? null : (
        <>
          <div style={{ marginBottom: 7 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285" }}>
              Sentimen Publik
            </span>
          </div>
          <SentimentTrack display={display} />
          <div style={{ display: "flex", gap: 18, alignItems: "baseline", marginTop: 7, fontSize: 11.5, color: "#7a7264", flexWrap: "wrap" }}>
            <span>{percent(positive, total)}% positif</span>
            <span>{percent(neutral, total)}% netral</span>
            <span>{percent(negative, total)}% negatif</span>
            <span style={{ marginLeft: "auto", color: "#9b9285" }}>
              {formatCount(record.sentiment_sample_size ?? total)} komentar
            </span>
          </div>
        </>
      )}
    </article>
  );
}
