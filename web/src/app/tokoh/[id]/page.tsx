import Link from "next/link";
import { notFound } from "next/navigation";
import FigurePortrait from "@/components/FigurePortrait";
import Nav from "@/components/Nav";
import RecordCard from "@/components/RecordCard";
import SentimentTrack from "@/components/SentimentTrack";
import { FIGURE_PAGE_SIZE, getFigure, getFigureEvents } from "@/lib/data";
import { getCv } from "@/lib/cv";
import {
  dayBadge,
  formatDate,
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
  searchParams: Promise<{ tab?: string; hal?: string }>;
}) {
  const { id } = await params;
  const { tab, hal } = await searchParams;
  const page = Math.max(1, Math.floor(Number(hal)) || 1);
  const [figure, events, cv] = await Promise.all([getFigure(id), getFigureEvents(id, page), getCv(id)]);
  if (!figure) notFound();
  const pageCount = Math.max(1, Math.ceil(Number(figure.event_count) / FIGURE_PAGE_SIZE));

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
      <Nav crumbs={[{ label: "Beranda", href: "/" }, { label: figure.name }]} />
      <div className="container-page" style={{ maxWidth: 1184 }}>
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

            <dl style={{ display: "flex", gap: 22, margin: "0 0 20px", fontSize: 12.5, color: "var(--color-stone)", flexWrap: "wrap" }}>
              <div>
                <dt style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--color-stone-light)" }}>Catatan</dt>
                <dd style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 22, color: "var(--color-ink)" }}>{figure.event_count}</dd>
              </div>
            </dl>

            {avg !== null ? (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--color-stone-light)", marginBottom: 8 }}>
                  Rata-rata Sentimen
                </div>
                <SentimentTrack display={avg} height={10} thumb={30} />
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 15, marginTop: 8, color: "var(--color-mud)" }}>
                  {avg > 0 ? "+" : ""}{avg} · {sentimentLabel(avg)}
                </div>
              </div>
            ) : null}
          </aside>

          <main style={{ minWidth: 0 }}>
            {cv ? (
              <div role="tablist" aria-label="Bagian" style={{ display: "flex", gap: 24, borderBottom: "1px solid var(--color-parchment)", marginBottom: 22 }}>
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
              <p style={{ fontSize: 15, color: "var(--color-stone)", lineHeight: 1.6 }}>
                {page > 1 ? (
                  <>
                    Tidak ada catatan di halaman ini.{" "}
                    <Link href={`/tokoh/${id}`} className="link">Kembali ke halaman 1</Link>
                  </>
                ) : (
                  "Belum ada catatan yang tayang untuk tokoh ini."
                )}
              </p>
            ) : (
              <>
              {[...groups.entries()].map(([month, rows], mi) => (
                <section key={month}>
                  {/* The first month sits right under the tab bar's rule, so
                      its own top rule only drew a second line beneath it. */}
                  <h2 className="month-heading" style={{ margin: "10px 0 20px", ...(mi === 0 ? { borderTop: "none" } : null) }}>
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
              ))}
              <Pager id={id} page={page} pageCount={pageCount} />
              </>
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

/** Newer/older links under the record list; hidden when it all fits on one page. */
function Pager({ id, page, pageCount }: { id: string; page: number; pageCount: number }) {
  if (pageCount <= 1) return null;
  const href = (n: number) => (n === 1 ? `/tokoh/${id}` : `/tokoh/${id}?hal=${n}`);
  return (
    <nav
      aria-label="Halaman catatan"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        borderTop: "1px solid var(--color-parchment)",
        margin: "28px 0 48px",
        paddingTop: 16,
      }}
    >
      <span style={{ minWidth: 0 }}>
        {page > 1 ? <Link href={href(page - 1)} className="link" style={{ fontSize: 13 }}>← Lebih baru</Link> : null}
      </span>
      <span style={{ fontSize: 12.5, color: "var(--color-stone)" }}>
        Halaman {Math.min(page, pageCount)} dari {pageCount}
      </span>
      <span style={{ minWidth: 0, textAlign: "right" }}>
        {page < pageCount ? <Link href={href(page + 1)} className="link" style={{ fontSize: 13 }}>Lebih lama →</Link> : null}
      </span>
    </nav>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className="tab-link"
      style={{
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        padding: "10px 0",
        marginBottom: -1,
      }}
    >
      {children}
    </Link>
  );
}

function CvPanel({ cv }: { cv: NonNullable<Awaited<ReturnType<typeof getCv>>> }) {
  const eduHasYears = cv.education.some((e) => e.year);
  return (
    <div>
      {/* No bio: a figure is read from their records and current office,
          which the page already leads with. */}
      {cv.facts.length > 0 ? (
        <>
          <h2 className="section-label" style={{ margin: "32px 0 14px" }}>Fakta Ringkas</h2>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 1,
              background: "var(--color-parchment)",
              border: "1px solid var(--color-parchment)",
              margin: 0,
            }}
          >
            {cv.facts.map((f) => (
              <div key={f.label} style={{ background: "var(--color-cream)", padding: 16 }}>
                <dt style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--color-stone-light)" }}>
                  {f.label}
                </dt>
                <dd style={{ margin: "6px 0 0", fontSize: 14.5, color: "var(--color-ink)" }}>{f.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {cv.posts.length > 0 ? (
        <>
          <h2 className="section-label" style={{ margin: "32px 0 14px" }}>Riwayat Jabatan</h2>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, borderLeft: "1.5px solid var(--color-parchment)" }}>
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
                    background: "var(--color-clay)",
                  }}
                />
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", color: "var(--color-stone-light)" }}>{p.period}</div>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 600, marginTop: 2 }}>{p.title}</div>
                {p.org ? <div style={{ fontSize: 13, color: "var(--color-stone)" }}>{p.org}</div> : null}
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
              <li key={`${e.year ?? ""}-${e.detail}`} style={{ display: "flex", gap: 16, padding: "10px 0", borderBottom: "1px solid #e4dcc9" }}>
                {/* The year column only exists when some entry has a year;
                    otherwise it is an empty gutter in front of every line. */}
                {eduHasYears ? (
                  <span style={{ flex: "none", width: 44, fontSize: 12.5, color: "var(--color-stone-light)" }}>{e.year ?? ""}</span>
                ) : null}
                <span style={{ fontSize: 14.5 }}>{e.detail}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* Offices typed in by a curator may come with no source yet. */}
      {cv.sources.length > 0 ? (
      <p style={{ fontSize: 12, color: "var(--color-stone-light)", margin: "28px 0 0", lineHeight: 1.6 }}>
        Sumber:{" "}
        {cv.sources.map((src, i) => (
          <span key={src.url ?? src.label}>
            {i > 0 ? "; " : ""}
            {src.url ? (
              <a href={src.url} target="_blank" rel="noopener noreferrer" className="link-subtle">
                {src.label}
              </a>
            ) : (
              src.label
            )}
          </span>
        ))}
        {cv.checkedAt ? <>. Diperiksa {formatDate(cv.checkedAt)}</> : null}.
      </p>
      ) : null}
    </div>
  );
}
