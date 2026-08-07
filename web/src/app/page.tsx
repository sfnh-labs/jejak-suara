import Link from "next/link";
import Nav from "@/components/Nav";
import EventCard from "@/components/EventCard";
import RecordCard from "@/components/RecordCard";
import { getFeed, getFigures, getSentimentHistory } from "@/lib/data";
import {
  formatCount,
  formatDate,
  hatch,
  initials,
  monthGroupLabel,
  sentimentRing,
  toDisplayScore,
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
  flat: { glyph: "▬", color: "#9b9285", label: "stabil" },
};

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
      <Nav active="/" />

      <div className="container-page" style={{ maxWidth: 1100 }}>
        <header className="rule-heavy" style={{ padding: "clamp(32px, 6vw, 56px) 0 32px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 40, flexWrap: "wrap" }}>
            <div style={{ maxWidth: 680, flex: "1 1 320px" }}>
              <div className="eyebrow" style={{ marginBottom: 16 }}>
                Portal Rekam Jejak Tokoh Publik
              </div>
              <h1
                style={{
                  fontFamily: "var(--font-serif)",
                  fontWeight: 500,
                  fontSize: "clamp(34px, 6vw, 58px)",
                  lineHeight: 1.0,
                  margin: "0 0 18px",
                  letterSpacing: "-0.02em",
                }}
              >
                Lacak bagaimana tokoh bertindak di mata media.
              </h1>
              <p style={{ fontSize: 16, lineHeight: 1.6, color: "#4a443d", margin: 0, maxWidth: 560 }}>
                Setiap catatan dirangkum dari pemberitaan dengan sumber yang bisa
                ditelusuri — dilengkapi reaksi publik dari komentar, apa adanya.
              </p>
            </div>
            <div
              style={{
                flex: "0 1 auto",
                textAlign: "right",
                fontSize: 12.5,
                color: "#7a7264",
                lineHeight: 1.7,
                borderLeft: "1px solid #d8cfba",
                paddingLeft: 24,
              }}
            >
              <div style={{ fontWeight: 700, color: "#16130f" }}>{formatDate(new Date().toISOString())}</div>
              <div>{figures.length} tokoh dipantau</div>
              <div>{formatCount(totalEvents)} catatan</div>
              {totalComments > 0 ? <div>{formatCount(totalComments)} komentar dianalisis</div> : null}
            </div>
          </div>
        </header>

        {figures.length > 0 ? <StoryBubbles figures={figures} history={history} /> : null}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "32px 0 18px", gap: 16, flexWrap: "wrap" }}>
          <div className="section-label">Catatan Terbaru</div>
          <div style={{ fontSize: 12.5, color: "#7a7264" }}>Diurutkan dari yang terbaru</div>
        </div>

        {feed.length === 0 ? (
          <Empty />
        ) : (
          [...groups.entries()].map(([month, rows]) => (
            <section key={month}>
              <h2
                style={{
                  position: "sticky",
                  top: 57,
                  zIndex: 5,
                  background: "#f6f2e9",
                  boxShadow: "0 -18px 0 #f6f2e9",
                  fontFamily: "var(--font-serif)",
                  fontWeight: 500,
                  fontSize: 20,
                  color: "#9b8f7d",
                  margin: "18px 0 20px",
                  padding: "6px 0",
                  borderBottom: "1px solid #d8cfba",
                }}
              >
                {month}
              </h2>
              <div className="rail">
                {rows.map((item) =>
                  item.kind === "peristiwa" ? (
                    <div className="rail-row" key={`p-${item.peristiwa.event_id}`}>
                      <span className="rail-dot" style={{ background: "#8b2e1f" }} aria-hidden />
                      <div className="rail-event">
                        <EventCard peristiwa={item.peristiwa} />
                      </div>
                    </div>
                  ) : (
                    <div className="rail-row" key={`r-${item.record.event_id}`}>
                      <span className="rail-dot" style={{ background: "#6b645b" }} aria-hidden />
                      <div className="rail-record">
                        <RecordCard record={item.record} showFigure bare />
                      </div>
                    </div>
                  )
                )}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function StoryBubbles({ figures, history }: { figures: FigureSummary[]; history: SentimentPoint[] }) {
  return (
    <section aria-label="Tokoh dipantau" style={{ padding: "28px 0 4px" }}>
      <div style={{ display: "flex", gap: 18, overflowX: "auto", paddingBottom: 8 }}>
        {figures.map((fig) => {
          const display = toDisplayScore(fig.avg_sentiment);
          const trend = TREND_MARK[trendFor(history, fig.id)];
          return (
            <Link
              key={fig.id}
              href={`/tokoh/${fig.id}`}
              style={{ flex: "none", width: 74, textAlign: "center", textDecoration: "none", color: "inherit" }}
            >
              <div
                style={{
                  width: 66,
                  height: 66,
                  margin: "0 auto",
                  borderRadius: "50%",
                  background: sentimentRing(display),
                  padding: 3,
                }}
              >
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: "50%",
                    background: hatch(5),
                    border: "1px solid #16130f",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ fontFamily: "var(--font-serif)", fontSize: 18, color: "#b9ab93" }}>
                    {initials(fig.name)}
                  </span>
                </div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 7, lineHeight: 1.25 }}>
                {fig.name.split(/\s+/)[0]}
              </div>
              <div style={{ fontSize: 11, color: trend.color, marginTop: 2 }}>
                <span aria-hidden>{trend.glyph}</span>
                <span className="sr-only"> {trend.label}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Empty() {
  return (
    <p style={{ fontSize: 15, color: "#7a7264", padding: "28px 0 60px", lineHeight: 1.6 }}>
      Belum ada catatan yang tayang. Jalankan tahap peringkasan lalu sinkronkan ke
      basis data untuk mengisi halaman ini.
    </p>
  );
}
