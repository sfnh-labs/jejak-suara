import Link from "next/link";
import {
  getCandidateCounts,
  getCandidates,
  type CandidateFilter,
  type CandidateRow,
} from "@/lib/candidates";
import { annotate, decide } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kandidat Tokoh · Jejak Suara",
  robots: { index: false, follow: false },
};

const TABS: { key: CandidateFilter; label: string }[] = [
  { key: "undecided", label: "Belum diputus" },
  { key: "promote", label: "Diterima" },
  { key: "reject", label: "Ditolak" },
  { key: "all", label: "Semua" },
];

const INK = "#16130f";
const MUTED = "#7a7264";
const RULE = "#d8cfba";

function button(tone: "accept" | "danger" | "quiet") {
  const bg = { accept: "#3d6b4a", danger: "#8b2e1f", quiet: "transparent" }[tone];
  return {
    fontSize: 12.5,
    fontWeight: 600,
    padding: "6px 13px",
    borderRadius: 3,
    cursor: "pointer",
    border: `1px solid ${tone === "quiet" ? RULE : bg}`,
    background: bg,
    color: tone === "quiet" ? MUTED : "#f6f2e9",
  } as const;
}

const input = {
  fontSize: 13,
  padding: "6px 9px",
  border: `1px solid ${RULE}`,
  borderRadius: 3,
  background: "#fffdf8",
  color: INK,
  minWidth: 0,
} as const;

export default async function KandidatTokoh({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: raw } = await searchParams;
  const filter: CandidateFilter =
    raw === "promote" || raw === "reject" || raw === "all" ? raw : "undecided";

  const [rows, counts] = await Promise.all([
    getCandidates(filter),
    getCandidateCounts(),
  ]);

  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 860 }}>
        <header className="rule-heavy" style={{ padding: "clamp(24px, 4vw, 40px) 0 22px" }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Internal · <Link href="/kurasi" style={{ color: MUTED }}>Kurasi catatan</Link>
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
            Kandidat Tokoh
          </h1>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "#4a443d", margin: 0, maxWidth: 620 }}>
            Nama-nama yang cukup sering disebut media, tapi <strong>tidak bisa
            diputus otomatis</strong> — sebagian besar bernama satu kata, dan
            dalam kalimat bahasa Indonesia kata pertama selalu berhuruf besar,
            sehingga &ldquo;Dasar&rdquo; terlihat sama seperti &ldquo;Dasco&rdquo;.
            Keputusan di sini <strong>belum langsung berlaku</strong>: pipeline
            menerapkannya lewat{" "}
            <code style={{ fontSize: 13 }}>scripts/apply_candidate_verdicts.py</code>.
          </p>
        </header>

        <div style={{ display: "flex", gap: 18, padding: "18px 0", fontSize: 13, fontWeight: 600, flexWrap: "wrap" }}>
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              href={`/kurasi/kandidat?filter=${tab.key}`}
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
            Tidak ada kandidat pada saringan ini. Jalankan{" "}
            <code>python scripts/sync_to_neon.py --push</code> kalau antrean
            lokal belum terkirim.
          </p>
        ) : (
          <div style={{ paddingBottom: 60 }}>
            {rows.map((r) => (
              <CandidateItem key={r.slug} row={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateItem({ row: r }: { row: CandidateRow }) {
  const decided = r.verdict !== null;
  return (
    <article style={{ padding: "18px 0", borderBottom: `1px solid ${RULE}` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 19, margin: 0 }}>
          {r.name}
        </h2>
        <span style={{ fontSize: 12, color: MUTED }}>{r.slug}</span>
        {r.verdict ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: r.verdict === "promote" ? "#3d6b4a" : "#8b2e1f",
            }}
          >
            {r.verdict === "promote" ? "diterima" : "ditolak"}
            {r.applied_at ? " · sudah diterapkan" : " · menunggu pipeline"}
          </span>
        ) : null}
      </div>

      <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span>{r.outlets} media</span>
        <span>·</span>
        <span>{r.mentions} penyebutan</span>
        <span>·</span>
        <span>{r.role ? `disebut sebagai ${r.role}` : "tidak pernah disebut jabatannya"}</span>
      </div>

      {r.records.length > 0 ? (
        // What the coverage became on the site. This is the thing accepting a
        // candidate really creates — the articles below are only the evidence
        // it was built from.
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285", marginBottom: 5 }}>
            Catatan terkait
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.55, fontFamily: "var(--font-serif)" }}>
            {r.records.map((rec) => (
              <li key={rec.id}>
                {rec.figure_id ? (
                  <Link
                    href={`/tokoh/${rec.figure_id}/${rec.id}`}
                    target="_blank"
                    style={{ color: INK }}
                  >
                    {rec.title}
                  </Link>
                ) : (
                  // A peristiwa belongs to no figure and has no detail page.
                  <span style={{ color: INK }}>{rec.title}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.headlines.length > 0 ? (
        // Openable, because a name mined from an article's body often does not
        // appear in its headline at all — judging "Agung" needs the sentence,
        // not the title.
        <details style={{ marginBottom: 12 }}>
          <summary style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, cursor: "pointer" }}>
            Artikel bukti ({r.headlines.length})
          </summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, color: "#4a443d" }}>
          {r.headlines.map((h, i) => (
            <li key={i}>
              {h.source ? (
                <span style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, marginRight: 6 }}>
                  {h.source}
                </span>
              ) : null}
              {h.url ? (
                <a href={h.url} target="_blank" rel="noreferrer" style={{ color: "#4a443d" }}>
                  {h.title}
                </a>
              ) : (
                h.title
              )}
            </li>
          ))}
        </ul>
        </details>
      ) : null}

      <form action={annotate} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12, flexWrap: "wrap" }}>
        <input type="hidden" name="slug" value={r.slug} />
        <label style={{ fontSize: 11.5, color: MUTED, display: "grid", gap: 3, flex: "1 1 420px", minWidth: 0 }}>
          Catatan — apa yang kamu lihat di sini
          <textarea
            name="notes"
            rows={2}
            defaultValue={r.notes ?? ""}
            placeholder="mis. ini pangkat polisi, bukan nama · orang yang sama dengan tokoh X · cuma pernah dikutip, tidak pernah jadi pelaku"
            style={{ ...input, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
            aria-label={`Catatan untuk ${r.name}`}
          />
        </label>
        <button type="submit" style={button("quiet")}>Simpan catatan</button>
      </form>

      {decided ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {r.verdict === "promote" ? (
            <span style={{ fontSize: 13, color: "#4a443d" }}>
              Akan tampil sebagai <strong>{r.full_name || r.name}</strong>
              {r.aliases ? ` · alias: ${r.aliases.split("|").join(", ")}` : ""}
            </span>
          ) : null}
          <form action={decide}>
            <input type="hidden" name="slug" value={r.slug} />
            <input type="hidden" name="verdict" value="" />
            <button type="submit" style={button("quiet")}>Batalkan keputusan</button>
          </form>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          {/* One form for accepting, because the name and aliases have to
              travel with the verdict; rejecting needs neither. */}
          <form action={decide} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <input type="hidden" name="slug" value={r.slug} />
            <input type="hidden" name="verdict" value="promote" />
            <label style={{ fontSize: 11.5, color: MUTED, display: "grid", gap: 3 }}>
              Nama lengkap
              <input
                name="full_name"
                defaultValue={r.name}
                style={{ ...input, width: 200 }}
                aria-label={`Nama lengkap untuk ${r.name}`}
              />
            </label>
            <label style={{ fontSize: 11.5, color: MUTED, display: "grid", gap: 3 }}>
              Alias lain (pisahkan dengan |)
              <input
                name="aliases"
                placeholder="Jokowi|Mulyono"
                style={{ ...input, width: 220 }}
                aria-label={`Alias untuk ${r.name}`}
              />
            </label>
            <button type="submit" style={button("accept")}>Terima</button>
          </form>
          <form action={decide}>
            <input type="hidden" name="slug" value={r.slug} />
            <input type="hidden" name="verdict" value="reject" />
            <button type="submit" style={button("danger")}>Tolak</button>
          </form>
        </div>
      )}
    </article>
  );
}
