import Link from "next/link";

const BULAN = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function fdate(raw: string | null): string {
  if (!raw) return "";
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return raw;
  const y = m[1], mo = parseInt(m[2]), d = parseInt(m[3]);
  return `${d} ${BULAN[mo]} ${y}`;
}

const figures: Record<string, string> = {
  "prabowo-subianto": "Prabowo Subianto",
  "budiman-sudjatmiko": "Budiman Sudjatmiko",
};

const reviewQueue = [
  {
    id: 7,
    figure_id: "prabowo-subianto",
    event_date: "2026-06-20",
    title: "Prabowo Sambut Baik Kerja Sama Ekonomi dengan Brasil",
    summary: "Presiden Prabowo menyambut baik peningkatan kerja sama ekonomi dengan Brasil, terutama di bidang pertanian dan energi terbarukan. Pertemuan bilateral dilakukan di sela-sela kunjungan kenegaraan.\n\nKutipan: \"Ini adalah langkah strategis untuk diversifikasi mitra dagang Indonesia.\" — Prabowo Subianto, Antara",
    articles: [
      { source: "Antara", title: "Prabowo Sambut Baik Kerja Sama Ekonomi dengan Brasil", url: "https://antaranews.com/berita/1", published_at: "2026-06-20" },
      { source: "Detik.com", title: "RI-Brasil Perkuat Kerja Sama Pertanian", url: "https://detik.com/news/1", published_at: "2026-06-20" },
      { source: "Kompas", title: "Energi Terbarukan Jadi Fokus Kerja Sama RI-Brasil", url: "https://kompas.com/1", published_at: "2026-06-21" },
    ],
    corroboration: 3,
    n_citations: 2,
    single_source: false,
  },
  {
    id: 8,
    figure_id: "budiman-sudjatmiko",
    event_date: "2026-06-18",
    title: "Budiman Sudjatmiko Dorong Ekonomi Digital di Daerah",
    summary: "Budiman Sudjatmiko mendorong pengembangan ekonomi digital di daerah melalui pelatihan dan pendampingan UMKM. Ia menekankan pentingnya literasi digital bagi pelaku usaha kecil.",
    articles: [
      { source: "Republika", title: "Budiman Dorong Ekonomi Digital di Daerah", url: "https://republika.co.id/1", published_at: "2026-06-18" },
    ],
    corroboration: 1,
    n_citations: 1,
    single_source: true,
  },
];

export default function ReviewPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#f6f2e9", fontFamily: "'Public Sans', system-ui, sans-serif", color: "#16130f" }}>
      <Nav />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 48px 60px" }}>
        <h1 style={{ fontFamily: "'Newsreader', serif", fontWeight: 500, fontSize: 40, lineHeight: 1.1, margin: "32px 0 8px", letterSpacing: "-0.015em" }}>Antrean Tinjauan</h1>
        <p style={{ fontSize: 14.5, color: "#4a443d", margin: "0 0 32px", lineHeight: 1.6 }}>
          Draf hasil rangkuman menunggu persetujuan. Periksa kutipan sumber dan tanda
          <span style={{ color: "#8b2e1f", fontWeight: 600 }}> satu sumber</span> sebelum menyetujui. Tidak ada yang tayang tanpa persetujuan.
        </p>

        {reviewQueue.map((r) => (
          <div key={r.id} style={{ background: "#efe9dc", border: "1px solid #ddd3bf", padding: "24px 28px", marginBottom: 20 }}>
            <div style={{ fontSize: 12.5, color: "#7a7264", marginBottom: 8 }}>
              {figures[r.figure_id] || r.figure_id} · {fdate(r.event_date)}
            </div>
            <h3 style={{ fontFamily: "'Newsreader', serif", fontWeight: 600, fontSize: 22, lineHeight: 1.2, margin: "0 0 12px" }}>{r.title}</h3>
            <div style={{ fontSize: 14.5, lineHeight: 1.62, color: "#3e382f", marginBottom: 16, whiteSpace: "pre-line" }}>{r.summary}</div>

            <details style={{ marginBottom: 16 }}>
              <summary style={{ fontSize: 12.5, fontWeight: 600, color: "#8b2e1f", cursor: "pointer" }}>Artikel sumber ({r.articles.length})</summary>
              {r.articles.map((a, i) => (
                <div key={i} style={{ borderLeft: "2px solid #d8cfba", padding: "8px 14px", marginTop: 8, fontSize: 13.5, color: "#4a443d" }}>
                  <strong>{a.source}</strong> · {fdate(a.published_at ?? null)}
                  <br />
                  <a href={a.url} target="_blank" style={{ color: "#8b2e1f", textDecoration: "underline" }}>{a.title}</a>
                </div>
              ))}
            </details>

            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#7a7264", marginBottom: 16 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "#3d6b4a", border: "1px solid #b6d0bd", background: "#e6efe8", padding: "3px 9px", borderRadius: 2 }}>Dikuatkan {r.corroboration} media</span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "#6b645b", border: "1px solid #d8cfba", padding: "3px 9px", borderRadius: 2 }}>{r.n_citations} kutipan</span>
              {r.single_source && (
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#8b2e1f", border: "1px solid #d8a99f", background: "#f5e7e3", padding: "3px 9px", borderRadius: 2 }}>⚠ satu sumber</span>
              )}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <form method="post" action={`/review/${r.id}/approve`}>
                <button type="submit" style={{ fontFamily: "'Public Sans'", fontSize: 13, fontWeight: 600, color: "#f6f2e9", background: "#2e7a52", border: "none", padding: "8px 20px", borderRadius: 2, cursor: "pointer" }}>Setujui</button>
              </form>
              <form method="post" action={`/review/${r.id}/reject`}>
                <button type="submit" style={{ fontFamily: "'Public Sans'", fontSize: 13, fontWeight: 600, color: "#f6f2e9", background: "#8b2e1f", border: "none", padding: "8px 20px", borderRadius: 2, cursor: "pointer" }}>Tolak</button>
              </form>
            </div>
          </div>
        ))}

        {reviewQueue.length === 0 && (
          <div style={{ fontSize: 14.5, color: "#7a7264", padding: 32, textAlign: "center" }}>Antrean kosong — tidak ada draf menunggu tinjauan.</div>
        )}
      </div>
    </div>
  );
}

function Nav() {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "15px 48px", background: "#f6f2e9", borderBottom: "1px solid #16130f" }}>
      <div style={{ fontFamily: "'Newsreader', serif", fontWeight: 700, fontSize: 22, letterSpacing: "-0.01em", cursor: "pointer" }}>
        <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>Jejak Suara</Link>
      </div>
      <div style={{ display: "flex", gap: 28, fontSize: 13, fontWeight: 600, color: "#7a7264" }}>
        <Link href="/" style={{ color: "#7a7264", textDecoration: "none" }}>Beranda</Link>
        <Link href="/" style={{ color: "#7a7264", textDecoration: "none" }}>Tokoh</Link>
        <Link href="/review" style={{ color: "#16130f", borderBottom: "2px solid #8b2e1f", paddingBottom: 2, textDecoration: "none" }}>Antrean Tinjauan</Link>
      </div>
    </div>
  );
}
