import Link from "next/link";
import Nav from "@/components/Nav";
import EventTile from "@/components/EventTile";
import FigurePortrait from "@/components/FigurePortrait";
import HScroller from "@/components/HScroller";
import RecordCard from "@/components/RecordCard";
import { getFeed, getFigures, getSentimentHistory } from "@/lib/data";
import {
  dayBadge,
  firstName,
  formatCount,
  monthGroupLabel,
} from "@/lib/design";
import type { FeedItem, FigureSummary, SentimentPoint } from "@/lib/types";

// Read live at request time: the pipeline pushes to Neon on its own schedule,
// and prerendering would also require DATABASE_URL during the build.
export const dynamic = "force-dynamic";

type Trend = "up" | "down" | "flat";

/** Compare the newest daily mean against the oldest in the window. */
function trendFor(history: SentimentPoint[], figureId: string): Trend {
  const points = history
    .filter((p) => p.figure_id === figureId)
    .sort((a, b) => a.day.localeCompare(b.day));
  if (points.length < 2) return "flat";
  const delta = Number(points[points.length - 1].score) - Number(points[0].score);
  if (delta > 0.05) return "up";
  if (delta < -0.05) return "down";
  return "flat";
}

const TREND_MARK: Record<Trend, { glyph: string; color: string; label: string }> = {
  up: { glyph: "▲", color: "#2e7a52", label: "naik" },
  down: { glyph: "▼", color: "#c0392b", label: "turun" },
  flat: { glyph: "▬", color: "var(--color-stone-light)", label: "stabil" },
};

/** The day a feed card *shows*, which is the event's own date. */
function feedDate(item: FeedItem): string | null {
  return item.kind === "peristiwa" ? item.peristiwa.event_date : item.record.event_date;
}

/** Feed items split into consecutive same-day runs, in the order given. */
function byDay(rows: FeedItem[]): [string, FeedItem[]][] {
  const out: [string, FeedItem[]][] = [];
  for (const item of rows) {
    const key = (feedDate(item) ?? "").slice(0, 10);
    const last = out[out.length - 1];
    if (last && last[0] === key) last[1].push(item);
    else out.push([key, [item]]);
  }
  return out;
}

export default async function Beranda() {
  const [figures, feed, history] = await Promise.all([
    getFigures(),
    getFeed(40),
    getSentimentHistory(7),
  ]);

  const totalEvents = figures.reduce((n, f) => n + Number(f.event_count ?? 0), 0);
  const totalComments = figures.reduce((n, f) => n + Number(f.comment_count ?? 0), 0);

  const groups = new Map<string, FeedItem[]>();
  for (const item of feed) {
    const key = monthGroupLabel(item.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav
        active="/"
        stats={[
          `${figures.length} tokoh dipantau`,
          `${formatCount(totalEvents)} catatan`,
          ...(totalComments > 0 ? [`${formatCount(totalComments)} komentar dianalisis`] : []),
        ]}
      />

      <div className="container-page" style={{ maxWidth: 1184 }}>
        <header className="rule-heavy" style={{ padding: "28px 0 26px" }}>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 600,
              fontSize: "clamp(32px, 5.4vw, 52px)",
              lineHeight: 1.08,
              margin: "0 0 14px",
              letterSpacing: "-0.015em",
            }}
          >
            Setiap suara meninggalkan jejak. Kami mencatatnya.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: "var(--color-mud)", margin: 0, maxWidth: 640 }}>
            Setiap catatan dirangkum dari pemberitaan dengan sumber yang bisa
            ditelusuri — dilengkapi reaksi publik dari komentar, apa adanya.
          </p>
        </header>

        {figures.length > 0 ? <StoryBubbles figures={figures} history={history} /> : null}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "30px 0 14px", gap: 16, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontFamily: "var(--font-serif)", fontWeight: 700, fontSize: 28 }}>Catatan Terbaru</h2>
          <div style={{ display: "flex", gap: 18, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span aria-hidden style={{ width: 14, height: 14, background: "var(--color-event)" }} />
              Peristiwa
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span aria-hidden style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--color-ink)" }} />
              Catatan tokoh
            </span>
          </div>
        </div>

        {feed.length === 0 ? (
          <Empty />
        ) : (
          [...groups.entries()].map(([month, rows]) => (
            <section key={month}>
              <h2 className="month-heading" style={{ margin: "18px 0 20px" }}>
                {month}
              </h2>
              <div className="rail">
                {byDay(rows).map(([day, items]) => (
                  // One dateline per day, and it rides the rail for as long as
                  // that day's cards do. The dot each row keeps is what carries
                  // the kind: a square peristiwa, a ring record, as in the legend.
                  <div className="rail-day" key={day}>
                    <div className="day-rail">
                      <span className="day-pill">{dayBadge(feedDate(items[0]))}</span>
                    </div>
                    {items.map((item) =>
                      item.kind === "peristiwa" ? (
                        <div className="rail-row" key={`p-${item.peristiwa.event_id}`}>
                          <span className="rail-dot is-event" aria-hidden />
                          <div className="rail-event">
                            <EventTile peristiwa={item.peristiwa} />
                          </div>
                        </div>
                      ) : (
                        <div className="rail-row" key={`r-${item.record.event_id}`}>
                          <span className="rail-dot is-record" aria-hidden />
                          <div className="rail-record">
                            <RecordCard record={item.record} showFigure bare marker="none" />
                          </div>
                        </div>
                      )
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** Newest record first; figures with no live record go to the end. */
function byLatestRecord(figures: FigureSummary[]): FigureSummary[] {
  const at = (f: FigureSummary) => (f.last_record_at ? Date.parse(f.last_record_at) : -Infinity);
  return [...figures].sort((a, b) => at(b) - at(a) || a.name.localeCompare(b.name));
}

function StoryBubbles({ figures, history }: { figures: FigureSummary[]; history: SentimentPoint[] }) {
  return (
    <section
      aria-label="Tokoh dipantau"
      style={{
        display: "grid",
        gridTemplateColumns: "34px minmax(0, 1fr)",
        columnGap: 16,
        padding: "20px 0",
        borderBottom: "1px solid var(--color-ink)",
      }}
    >
      {/* Set to the avatar plus its name line, top to bottom. */}
      <div
        aria-hidden
        style={{
          alignSelf: "start",
          height: 89,
          writingMode: "vertical-rl",
          fontFamily: "var(--font-serif)",
          fontWeight: 700,
          fontSize: 21,
          lineHeight: 1,
          textAlignLast: "justify",
          whiteSpace: "nowrap",
          overflow: "hidden",
          borderRight: "2px solid var(--color-ink)",
          paddingRight: 6,
        }}
      >
        TOKOH
      </div>
      <HScroller label="Daftar tokoh, terbaru lebih dulu">
        {byLatestRecord(figures).map((fig) => {
          const trend = TREND_MARK[trendFor(history, fig.id)];
          const recent = Number(fig.recent_count);
          return (
            <Link
              key={fig.id}
              href={`/tokoh/${fig.id}`}
              className="bubble-link"
              style={{ flex: "none", width: 74, textAlign: "center" }}
            >
              <div
                className="bubble-ring"
                style={{ position: "relative", width: 66, height: 66, margin: "0 auto", padding: 5 }}
              >
                <StoryRing count={recent} size={66} />
                <FigurePortrait
                  figureId={fig.id}
                  name={fig.name}
                  width="100%"
                  height="100%"
                  round
                  fontSize={18}
                  hatchStep={5}
                />
              </div>
              <div className="bubble-name" style={{ fontSize: 12, fontWeight: 700, marginTop: 7, lineHeight: "16px", height: 16, whiteSpace: "nowrap" }}>
                {firstName(fig.name)}
              </div>
              <div style={{ fontSize: 11, color: trend.color, marginTop: 2 }}>
                <span aria-hidden>{trend.glyph}</span>
                <span className="sr-only">
                  {" "}{trend.label}
                  {recent > 0 ? `, ${recent} catatan baru dalam 24 jam` : ""}
                </span>
              </div>
            </Link>
          );
        })}
      </HScroller>
    </section>
  );
}

/** More segments than this would be too short to tell apart at 66px. */
const STORY_MAX_SEGMENTS = 20;

/**
 * The ring around a story bubble, Instagram-style: one segment per record with
 * coverage in the last 24 hours, always in the site's red so "new" reads the
 * same on every bubble. Sentiment stays off the ring — colouring it red for a
 * negative score made a figure look flagged. Nothing new: no ring at all.
 */
function StoryRing({ count, size }: { count: number; size: number }) {
  if (count <= 0) return null;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const segments = Math.min(count, STORY_MAX_SEGMENTS);
  const gap = segments > 1 ? (segments > 12 ? 2.5 : 4) : 0;
  const dash = circumference / segments - gap;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      // Rotated so the first segment starts at twelve o'clock.
      style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#8b2e1f"
        strokeWidth={stroke}
        strokeDasharray={gap ? `${dash} ${gap}` : undefined}
        // A gap is left at the end of each dash, so shift by half a gap to
        // centre the gaps on the segment boundaries.
        strokeDashoffset={gap ? -gap / 2 : undefined}
      />
    </svg>
  );
}

function Empty() {
  return (
    <p style={{ fontSize: 15, color: "var(--color-stone)", padding: "28px 0 60px", lineHeight: 1.6 }}>
      Belum ada catatan yang tayang. Jalankan tahap peringkasan lalu sinkronkan ke
      basis data untuk mengisi halaman ini.
    </p>
  );
}
