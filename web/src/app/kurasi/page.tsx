import Link from "next/link";
import { getCurationCounts, getCurationQueue, type Filter } from "@/lib/curation";
import { curate } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kurasi · Jejak Suara",
  robots: { index: false, follow: false },
};

const TABS: { key: Filter; label: string }[] = [
  { key: "live", label: "Tayang" },
  { key: "unreviewed", label: "Belum ditinjau" },
  { key: "rejected", label: "Diturunkan" },
];

const INK = "#16130f";
const MUTED = "#7a7264";
const RULE = "#d8cfba";

function button(tone: "danger" | "quiet") {
  return {
    fontSize: 12.5,
    fontWeight: 600,
    padding: "6px 13px",
    borderRadius: 3,
    cursor: "pointer",
    border: `1px solid ${tone === "danger" ? "#8b2e1f" : RULE}`,
    background: tone === "danger" ? "#8b2e1f" : "transparent",
    color: tone === "danger" ? "#f6f2e9" : MUTED,
  } as const;
}

export default async function Kurasi({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: raw } = await searchParams;
  const filter: Filter =
    raw === "rejected" || raw === "unreviewed" ? raw : "live";

  const [rows, counts] = await Promise.all([
    getCurationQueue(filter),
    getCurationCounts(),
  ]);

  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 820 }}>
        <header className="rule-heavy" style={{ padding: "clamp(24px, 4vw, 40px) 0 22px" }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Internal ·{" "}
            <Link href="/kurasi/kandidat" style={{ color: MUTED }}>Kandidat tokoh</Link>
          </div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 500,
              fontSize: "clamp(26px, 4.5vw, 36px)",
              margin: "0 0 12px",
              letterSpacing: "-0.02em",
            }}
          >
            Kurasi
          </h1>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "#4a443d", margin: 0, maxWidth: 560 }}>
            Semua catatan di sini <strong>sudah tayang</strong>. Menurunkan
            berlaku seketika di situs publik — tidak perlu sinkronisasi. Pipeline
            tidak pernah menimpa keputusan ini.
          </p>
        </header>

        <div style={{ display: "flex", gap: 18, padding: "18px 0", fontSize: 13, fontWeight: 600 }}>
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              href={`/kurasi?filter=${tab.key}`}
              style={{
                color: filter === tab.key ? INK : MUTED,
                textDecoration: "none",
                paddingBottom: 2,
                borderBottom: `2px solid ${filter === tab.key ? "#8b2e1f" : "transparent"}`,
              }}
            >
              {tab.label} <span style={{ color: MUTED, fontWeight: 400 }}>{counts[tab.key]}</span>
            </Link>
          ))}
        </div>

        {rows.length === 0 ? (
          <p style={{ fontSize: 14.5, color: MUTED, padding: "24px 0 60px" }}>
            Tidak ada catatan pada saringan ini.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 0, paddingBottom: 60 }}>
            {rows.map((r) => (
              <article
                key={r.event_id}
                style={{ padding: "18px 0", borderBottom: `1px solid ${RULE}` }}
              >
                <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span>{r.kind}</span>
                  <span>·</span>
                  <span>{r.figure_name ?? r.figure_id ?? "—"}</span>
                  <span>·</span>
                  <span>{r.event_date?.slice(0, 10) ?? "tanpa tanggal"}</span>
                  <span>·</span>
                  <span>{r.outlet_count} media</span>
                  {r.outlet_count <= 1 ? (
                    <span style={{ color: "#8b2e1f", fontWeight: 600 }}>⚠ satu sumber</span>
                  ) : null}
                  {r.curated ? (
                    <span style={{ fontWeight: 600, color: r.curated === "rejected" ? "#8b2e1f" : MUTED }}>
                      {r.curated === "rejected" ? "diturunkan" : "sudah diperiksa"}
                    </span>
                  ) : null}
                </div>

                <h2 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: 17, margin: "0 0 6px", lineHeight: 1.35 }}>
                  {r.title ?? `(tanpa judul) #${r.event_id}`}
                </h2>

                {r.summary ? (
                  <p style={{ fontSize: 14, lineHeight: 1.6, color: "#4a443d", margin: "0 0 8px", whiteSpace: "pre-line" }}>
                    {r.summary}
                  </p>
                ) : (
                  <p style={{ fontSize: 13.5, color: MUTED, margin: "0 0 8px", fontStyle: "italic" }}>
                    Belum dirangkum — tayang dari hasil klaster.
                  </p>
                )}

                {r.sources.length > 0 ? (
                  <details style={{ fontSize: 13, marginBottom: 10 }}>
                    <summary style={{ cursor: "pointer", color: MUTED }}>
                      Artikel sumber ({r.sources.length})
                    </summary>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                      {r.sources.map((a, i) => (
                        <li key={`${a.url}-${i}`}>
                          <strong style={{ fontSize: 12 }}>{a.source}</strong>{" "}
                          <a href={a.url} target="_blank" rel="noreferrer" style={{ color: "#4a443d" }}>
                            {a.title ?? a.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {r.curated === "rejected" ? (
                    <form action={curate}>
                      <input type="hidden" name="event_id" value={r.event_id} />
                      <input type="hidden" name="verdict" value="" />
                      <button type="submit" style={button("quiet")}>Tayangkan lagi</button>
                    </form>
                  ) : (
                    <>
                      <form action={curate}>
                        <input type="hidden" name="event_id" value={r.event_id} />
                        <input type="hidden" name="verdict" value="rejected" />
                        <button type="submit" style={button("danger")}>Turunkan</button>
                      </form>
                      {r.curated !== "kept" ? (
                        <form action={curate}>
                          <input type="hidden" name="event_id" value={r.event_id} />
                          <input type="hidden" name="verdict" value="kept" />
                          <button type="submit" style={button("quiet")}>Tandai sudah diperiksa</button>
                        </form>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
