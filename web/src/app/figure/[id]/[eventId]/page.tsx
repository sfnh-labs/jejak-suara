import Link from "next/link";
import TranslatedText from "@/components/TranslatedText";

const eventData = {
  1: {
    kategori: "Politik", kategoriColor: "#3a4a8b",
    headline: "PSI Pede Prabowo Tetap Gandeng Gibran di Pilpres 2029",
    outlet: "Detik.com", tanggal: "19 Jun 2026", about: "Prabowo Subianto",
    summary: "Ketua Harian DPP PSI menyatakan yakin Prabowo dan Gibran akan kembali maju bersama pada Pemilu Presiden 2029 untuk memastikan kesinambungan program pemerintah. Hingga kini belum ada pernyataan langsung dari Prabowo terkait pencalonan tersebut.",
    score: -15, c: "2,4 rb",
    pos: 28, net: 30, neg: 42,
    media: 1, kut: 1,
    quote: "",
    src: [
      { title: "PSI Yakin Duet Prabowo-Gibran Berlanjut di 2029", outlet: "Detik.com", date: "19 Jun 2026" },
    ],
  },
  2: {
    kategori: "Pertahanan", kategoriColor: "#3d6b4a",
    headline: "Prabowo Resmikan Tambahan Anggaran Modernisasi Alutsista",
    outlet: "Kompas", tanggal: "12 Jun 2026", about: "Prabowo Subianto",
    summary: "Presiden meresmikan alokasi tambahan untuk modernisasi alat utama sistem persenjataan, menekankan kemandirian industri pertahanan dalam negeri sebagai prioritas jangka panjang.",
    score: 52, c: "8,1 rb",
    pos: 68, net: 20, neg: 12,
    media: 5, kut: 3,
    quote: "Pertahanan yang kuat adalah syarat mutlak kedaulatan bangsa.",
    src: [
      { title: "Prabowo Tambah Anggaran Modernisasi Alutsista", outlet: "Kompas", date: "12 Jun 2026" },
      { title: "Anggaran Pertahanan Naik, Fokus Industri Dalam Negeri", outlet: "Tempo", date: "12 Jun 2026" },
      { title: "Modernisasi Alutsista Jadi Prioritas Prabowo", outlet: "Antara", date: "12 Jun 2026" },
      { title: "Presiden Resmikan Tambahan Belanja Pertahanan", outlet: "CNN Indonesia", date: "13 Jun 2026" },
      { title: "Kemandirian Pertahanan Ditegaskan Prabowo", outlet: "Republika", date: "13 Jun 2026" },
    ],
  },
};

function emoji(s: number): string {
  return s <= -40 ? "😡" : s <= -10 ? "🙁" : s < 16 ? "😐" : s < 46 ? "🙂" : "😄";
}

function left(s: number): string {
  return ((s + 100) / 2).toFixed(1) + "%";
}

function disp(s: number): string {
  return (s < 0 ? "−" : "+") + Math.abs(s);
}

function scol(s: number): string {
  return s <= -10 ? "#c0392b" : s < 16 ? "#9b7b3f" : "#2e7a52";
}

function slbl(s: number): string {
  return s <= -40 ? "Mayoritas menolak" : s <= -10 ? "Cenderung negatif" : s < 16 ? "Terbelah / netral" : s < 46 ? "Cenderung positif" : "Mayoritas mendukung";
}

export default async function DetailCatatan({ params }: { params: Promise<{ id: string; eventId: string }> }) {
  const { id, eventId } = await params;
  const rec = eventData[Number(eventId) as keyof typeof eventData];
  if (!rec) return <div>Event not found</div>;

  const badge = rec.media >= 2
    ? { label: `✓ Dikuatkan ${rec.media} media`, color: "#3d6b4a", border: "#b6d0bd", bg: "#e6efe8" }
    : { label: "⚠ Satu sumber", color: "#8b2e1f", border: "#d8a99f", bg: "#f5e7e3" };

  const commentSamples = [
    { initial: "A", name: "Andi Pratama", text: "Akhirnya ada langkah konkret. Lanjutkan, Pak!", tag: "Positif", tagColor: "#2e7a52", tagBg: "#e6efe8", tagBorder: "#b6d0bd", time: "2 jam lalu", likes: 412 },
    { initial: "S", name: "Siti Rahma", text: "Semoga programnya benar-benar sampai ke rakyat kecil.", tag: "Positif", tagColor: "#2e7a52", tagBg: "#e6efe8", tagBorder: "#b6d0bd", time: "5 jam lalu", likes: 86 },
    { initial: "B", name: "Bagus Wicaksono", text: "Ini baru pemimpin yang berani ambil keputusan.", tag: "Positif", tagColor: "#2e7a52", tagBg: "#e6efe8", tagBorder: "#b6d0bd", time: "9 jam lalu", likes: 153 },
    { initial: "R", name: "Rizky Maulana", text: "Kita tunggu realisasinya dulu, jangan cepat menilai.", tag: "Netral", tagColor: "#7a6a45", tagBg: "#efe9dc", tagBorder: "#ddd3bf", time: "14 jam lalu", likes: 47 },
    { initial: "H", name: "Hendra Saputra", text: "Perlu data yang lebih jelas soal angka-angkanya.", tag: "Netral", tagColor: "#7a6a45", tagBg: "#efe9dc", tagBorder: "#ddd3bf", time: "1 hari lalu", likes: 239 },
    { initial: "J", name: "Joko Susilo", text: "Janji manis lagi, buktinya mana di lapangan?", tag: "Negatif", tagColor: "#c0392b", tagBg: "#f5e7e3", tagBorder: "#d8a99f", time: "1 hari lalu", likes: 21 },
    { initial: "M", name: "Maria Fransiska", text: "Anggarannya dari mana? Jangan sampai nambah utang.", tag: "Negatif", tagColor: "#c0392b", tagBg: "#f5e7e3", tagBorder: "#d8a99f", time: "2 hari lalu", likes: 98 },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#f6f2e9", fontFamily: "'Public Sans', system-ui, sans-serif", color: "#16130f" }}>
      <Nav />

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 48px 80px" }}>
        <div style={{ padding: "22px 0 16px", fontSize: 12.5, fontWeight: 600, color: "#7a7264" }}>
          <Link href="/" style={{ cursor: "pointer", color: "#8b2e1f", textDecoration: "none" }}>Beranda</Link>
          <span style={{ margin: "0 8px", color: "#bcb3a0" }}>/</span>
          <Link href={`/figure/${id}`} style={{ cursor: "pointer", color: "#8b2e1f", textDecoration: "none" }}>{rec.about}</Link>
          <span style={{ margin: "0 8px", color: "#bcb3a0" }}>/</span>
          <span style={{ color: "#7a7264" }}>{rec.kategori}</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 52, alignItems: "start", paddingTop: 8 }}>
          <div />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: rec.kategoriColor, marginBottom: 14 }}>{rec.kategori}</div>
            <h1 style={{ fontFamily: "'Newsreader', serif", fontWeight: 600, fontSize: 40, lineHeight: 1.1, margin: "0 0 16px", letterSpacing: "-0.015em" }}>{rec.headline}</h1>
            <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 13, color: "#7a7264", paddingBottom: 22, borderBottom: "1px solid #d8cfba", marginBottom: 28 }}>
              <span style={{ fontWeight: 600, color: "#16130f" }}>{rec.outlet}</span><span>·</span><span>{rec.tanggal}</span><span>·</span><span>tentang {rec.about}</span>
            </div>

            {/* Sentiment */}
            <div style={{ marginBottom: 30 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285" }}>Sentimen Publik · YouTube</span>
                <span style={{ fontSize: 12, color: "#7a7264" }}>{rec.c} komentar · {slbl(rec.score)}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <span style={{ fontFamily: "'Newsreader', serif", fontSize: 34, lineHeight: 1, color: scol(rec.score), flex: "none" }}>{disp(rec.score)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ position: "relative", height: 8, borderRadius: 99, background: "linear-gradient(90deg,#d6453e,#e0a53b 50%,#2e9e6b)" }}>
                    <div style={{ position: "absolute", left: left(rec.score), top: "50%", transform: "translate(-50%,-50%)", width: 26, height: 26, borderRadius: "50%", background: "#f6f2e9", border: "1px solid #16130f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>{emoji(rec.score)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 16, marginTop: 9, fontSize: 11.5, color: "#7a7264" }}>
                    <span><strong style={{ color: "#2e7a52" }}>{rec.pos}%</strong> positif</span>
                    <span><strong style={{ color: "#9b8a5e" }}>{rec.net}%</strong> netral</span>
                    <span><strong style={{ color: "#c0392b" }}>{rec.neg}%</strong> negatif</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Summary */}
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285", marginBottom: 12 }}>Ringkasan</div>
            <p style={{ fontFamily: "'Newsreader', serif", fontWeight: 400, fontSize: 19, lineHeight: 1.6, color: "#16130f", margin: "0 0 22px" }}>
              <TranslatedText translated={rec.summary} original={null} originalLang={null} as="span" />
            </p>

            {/* Quote */}
            {rec.quote && (
              <blockquote style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontWeight: 500, fontSize: 24, lineHeight: 1.4, color: "#16130f", borderLeft: "3px solid #8b2e1f", padding: "4px 0 4px 22px", margin: "0 0 28px" }}>
                {rec.quote}
                <div style={{ fontFamily: "'Public Sans'", fontStyle: "normal", fontSize: 12.5, fontWeight: 600, color: "#7a7264", marginTop: 10 }}>— {rec.about}, {rec.outlet}</div>
              </blockquote>
            )}

            {/* Badges */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 30 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: badge.color, border: `1px solid ${badge.border}`, background: badge.bg, padding: "4px 10px", borderRadius: 2 }}>{badge.label}</span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "#6b645b", border: "1px solid #d8cfba", padding: "4px 10px", borderRadius: 2 }}>{rec.kut} kutipan terverifikasi</span>
            </div>

            {/* Sources */}
            <div style={{ borderTop: "3px double #16130f", paddingTop: 22 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#16130f", marginBottom: 16 }}>Artikel Sumber ({rec.src.length})</div>
              {rec.src.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: i === rec.src.length - 1 ? "none" : "1px solid #d8cfba", cursor: "pointer" }}>
                  <div style={{ flex: "none", fontSize: 15, fontWeight: 600, lineHeight: 1.3, color: "#bcb3a0", width: 28 }}>{String(i + 1).padStart(2, "0")}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#16130f", lineHeight: 1.3, marginBottom: 4 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: "#7a7264" }}>{s.outlet} · {s.date}</div>
                  </div>
                  <div style={{ flex: "none", fontSize: 15, fontWeight: 600, lineHeight: 1.3, color: "#8b2e1f" }}>↗</div>
                </div>
              ))}
            </div>

            {/* Comments */}
            <div style={{ borderTop: "3px double #16130f", paddingTop: 22, marginTop: 30 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#16130f", marginBottom: 6 }}>Komentar Publik</div>
              <div style={{ fontSize: 13, color: "#7a7264", marginBottom: 18 }}>Contoh dari {rec.c} komentar YouTube pada liputan ini</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
                {["koalisi", "2029", "rakyat"].map((t) => (
                  <span key={t} style={{ fontSize: 12.5, fontWeight: 600, color: "#6b3a6b", background: "#efe6ef", border: "1px solid #d9c5d9", padding: "4px 11px", borderRadius: 99 }}>#{t}</span>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid #d8cfba", paddingBottom: 14, marginBottom: 6 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#f6f2e9", background: "#16130f", padding: "5px 12px", borderRadius: 2, cursor: "pointer" }}>Semua</span>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#2e7a52", border: "1px solid #b6d0bd", padding: "5px 12px", borderRadius: 2, cursor: "pointer" }}>Positif</span>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#7a6a45", border: "1px solid #ddd3bf", padding: "5px 12px", borderRadius: 2, cursor: "pointer" }}>Netral</span>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#c0392b", border: "1px solid #d8a99f", padding: "5px 12px", borderRadius: 2, cursor: "pointer" }}>Negatif</span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#9b9285" }}>Paling relevan</span>
              </div>
              {commentSamples.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 14, padding: "18px 0", borderBottom: "1px solid #d8cfba" }}>
                  <div style={{ flex: "none", width: 38, height: 38, borderRadius: "50%", background: "#e4ddcf", border: "1px solid #c9bfa8", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Newsreader', serif", fontSize: 16, color: "#7a6f58" }}>{c.initial}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: "#16130f" }}>{c.name}</span>
                      <span style={{ fontSize: 12, color: "#9b9285" }}>{c.time}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: c.tagColor, background: c.tagBg, border: `1px solid ${c.tagBorder}`, padding: "2px 8px", borderRadius: 2 }}>{c.tag}</span>
                    </div>
                    <p style={{ fontSize: 14.5, lineHeight: 1.55, color: "#3e382f", margin: "0 0 8px" }}>{c.text}</p>
                    <div style={{ fontSize: 12, color: "#9b9285" }}>♥ {c.likes} · Balas</div>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 16, fontSize: 12.5, color: "#9b9285" }}>Menampilkan 7 dari {rec.c} komentar</div>
            </div>

            <Link href={`/figure/${id}`} style={{ marginTop: 32, fontSize: 13, fontWeight: 600, color: "#8b2e1f", cursor: "pointer", textDecoration: "none", display: "inline-block" }}>
              ← Kembali ke rekam jejak
            </Link>
          </div>
        </div>
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
        <Link href="/review" style={{ color: "#7a7264", textDecoration: "none" }}>Antrean Tinjauan</Link>
      </div>
    </div>
  );
}
