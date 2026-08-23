import Link from "next/link";
import { notFound } from "next/navigation";
import FigurePortrait from "@/components/FigurePortrait";
import Nav from "@/components/Nav";
import RecordCard from "@/components/RecordCard";
import SentimentTrack from "@/components/SentimentTrack";
import { getFigure, getFigureEvents } from "@/lib/data";
import { getCv } from "@/lib/cv";
import {
  dayBadge,
  monthGroupLabel,
  sentimentLabel,
  toDisplayScore,
} from "@/lib/design";
import type { EventRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HalamanTokoh({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const [figure, events] = await Promise.all([getFigure(id), getFigureEvents(id)]);
  if (!figure) notFound();

  const cv = getCv(id);
  // The tab lives in the URL rather than client state, so the page stays a
  // server component and each tab is linkable.
  const activeTab = tab === "cv" && cv ? "cv" : "rekam";
  const avg = toDisplayScore(figure.avg_sentiment);

  const groups = new Map<string, EventRecord[]>();
  for (const ev of events) {
    const key = monthGroupLabel(ev.event_date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav />
      <div className="container-page" style={{ maxWidth: 1120 }}>
        <nav aria-label="Breadcrumb" style={{ padding: "20px 0 0", fontSize: 12.5, color: "#7a7264" }}>
          <Link href="/" style={{ color: "#7a7264" }}>Beranda</Link>
          <span aria-hidden> · </span>
          <span style={{ color: "#16130f" }}>{figure.name}</span>
        </nav>

        <div className="tokoh-grid">
          <aside className="tokoh-profile">
            <div style={{ marginBottom: 18 }}>
              <FigurePortrait
                figureId={id}
                name={figure.name}
                width={196}
                height={240}
                fontSize={64}
                align="flex-end"
              />
            </div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{figure.role}</div>
            <h1
              style={{
                fontFamily: "var(--font-serif)",
                fontWeight: 500,
                fontSize: "clamp(28px, 5vw, 34px)",
                lineHeight: 1.0,
                margin: "0 0 18px",
              }}
            >
              {figure.name}
            </h1>

            <dl style={{ display: "flex", gap: 22, margin: "0 0 20px", fontSize: 12.5, color: "#7a7264", flexWrap: "wrap" }}>
              <div>
                <dt style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285" }}>Catatan</dt>
                <dd style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 22, color: "#16130f" }}>{figure.event_count}</dd>
              </div>
              <div>
                <dt style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285" }}>Outlet</dt>
                <dd style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 22, color: "#16130f" }}>{figure.outlet_count}</dd>
              </div>
            </dl>

            {avg !== null ? (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285", marginBottom: 8 }}>
                  Rata-rata Sentimen
                </div>
                <SentimentTrack display={avg} height={10} thumb={30} />
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 15, marginTop: 8, color: "#4a443d" }}>
                  {avg > 0 ? "+" : ""}{avg} · {sentimentLabel(avg)}
                </div>
              </div>
            ) : null}
          </aside>

          <main style={{ minWidth: 0 }}>
            {cv ? (
              <div role="tablist" aria-label="Bagian" style={{ display: "flex", gap: 24, borderBottom: "1px solid #d8cfba", marginBottom: 22 }}>
                <TabLink href={`/tokoh/${id}`} active={activeTab === "rekam"}>Rekam Jejak</TabLink>
                <TabLink href={`/tokoh/${id}?tab=cv`} active={activeTab === "cv"}>CV</TabLink>
              </div>
            ) : (
              <div className="section-label rule-heavy" style={{ padding: "24px 0 12px", marginBottom: 22 }}>
                Rekam Jejak
              </div>
            )}

            {activeTab === "cv" && cv ? (
              <CvPanel cv={cv} />
            ) : events.length === 0 ? (
              <p style={{ fontSize: 15, color: "#7a7264", lineHeight: 1.6 }}>
                Belum ada catatan yang tayang untuk tokoh ini.
              </p>
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
                      margin: "10px 0 20px",
                      padding: "6px 0",
                      borderBottom: "1px solid #d8cfba",
                    }}
                  >
                    {month}
                  </h2>
                  {byDay(rows).map(([day, dayRows]) => (
                    <div className="day-group" key={day}>
                      <div className="day-rail" aria-hidden={false}>
                        <span className="day-pill">{dayBadge(dayRows[0].event_date)}</span>
                      </div>
                      {dayRows.map((ev, i) => (
                        // The day's pill already sits where the first card's
                        // marker would be; the rest keep a dot as their anchor.
                        <RecordCard
                          key={ev.event_id}
                          record={ev}
                          marker={i === 0 ? "none" : "dot"}
                        />
                      ))}
                    </div>
                  ))}
                </section>
              ))
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/** Records split into consecutive same-day runs, in the order given. */
function byDay(rows: EventRecord[]): [string, EventRecord[]][] {
  const out: [string, EventRecord[]][] = [];
  for (const ev of rows) {
    const key = (ev.event_date ?? "").slice(0, 10);
    const last = out[out.length - 1];
    if (last && last[0] === key) last[1].push(ev);
    else out.push([key, [ev]]);
  }
  return out;
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      style={{
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: active ? "#16130f" : "#7a7264",
        textDecoration: "none",
        padding: "10px 0",
        borderBottom: active ? "2px solid #8b2e1f" : "2px solid transparent",
        marginBottom: -1,
      }}
    >
      {children}
    </Link>
  );
}

function CvPanel({ cv }: { cv: NonNullable<ReturnType<typeof getCv>> }) {
  return (
    <div>
      <p style={{ fontFamily: "var(--font-serif)", fontSize: 19, lineHeight: 1.6, color: "#3e382f", marginTop: 0 }}>
        {cv.bio}
      </p>

      {cv.facts.length > 0 ? (
        <>
          <h2 className="section-label" style={{ margin: "32px 0 14px" }}>Fakta Ringkas</h2>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 1,
              background: "#d8cfba",
              border: "1px solid #d8cfba",
              margin: 0,
            }}
          >
            {cv.facts.map((f) => (
              <div key={f.label} style={{ background: "#f6f2e9", padding: 16 }}>
                <dt style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285" }}>
                  {f.label}
                </dt>
                <dd style={{ margin: "6px 0 0", fontSize: 14.5, color: "#16130f" }}>{f.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {cv.posts.length > 0 ? (
        <>
          <h2 className="section-label" style={{ margin: "32px 0 14px" }}>Riwayat Jabatan</h2>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, borderLeft: "1.5px solid #d8cfba" }}>
            {cv.posts.map((p) => (
              <li key={`${p.period}-${p.title}`} style={{ position: "relative", padding: "0 0 22px 26px" }}>
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: -5.5,
                    top: 6,
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: "#8b2e1f",
                  }}
                />
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", color: "#9b9285" }}>{p.period}</div>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 600, marginTop: 2 }}>{p.title}</div>
                {p.org ? <div style={{ fontSize: 13, color: "#7a7264" }}>{p.org}</div> : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {cv.education.length > 0 ? (
        <>
          <h2 className="section-label" style={{ margin: "32px 0 14px" }}>Pendidikan</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {cv.education.map((e) => (
              <li key={`${e.year}-${e.detail}`} style={{ display: "flex", gap: 16, padding: "10px 0", borderBottom: "1px solid #e4dcc9" }}>
                <span style={{ flex: "none", width: 70, fontSize: 12.5, color: "#9b9285" }}>{e.year}</span>
                <span style={{ fontSize: 14.5 }}>{e.detail}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
