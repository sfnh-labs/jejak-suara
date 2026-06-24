import Link from "next/link";
import TranslatedText from "@/components/TranslatedText";

const BULAN = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

interface EventRecord {
  id: number;
  tipe: string;
  kategori: string;
  outlet: string;
  tanggal: string;
  headline: string;
  summary: string;
  summaryOriginal?: string;
  summaryLang?: string;
  media: number;
  kut: number;
  score: number;
  c: string;
  pos: number;
  net: number;
  neg: number;
  src: { title: string; outlet: string; date: string }[];
  related?: { id: string; name: string }[];
  figures?: { id: string; name: string }[];
}

const figures: Record<string, { initials: string; name: string; role: string; catatan: string; outlet: string; avgScore: number }> = {
  "prabowo-subianto": { initials: "PS", name: "Prabowo Subianto", role: "Presiden Republik Indonesia", catatan: "37", outlet: "12", avgScore: 14 },
  "budiman-sudjatmiko": { initials: "BS", name: "Budiman Sudjatmiko", role: "Politisi / Mantan Anggota DPR", catatan: "1", outlet: "1", avgScore: -8 },
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

const catColors: Record<string, string> = {
  Politik: "#3a4a8b", Ekonomi: "#7a5a2e", Pertahanan: "#3d6b4a",
  "Kebijakan Sosial": "#7a5a2e", "Hubungan Luar Negeri": "#6b3a6b", Hukum: "#8b2e1f",
};

const tipeColors: Record<string, string> = {
  Pidato: "#8b5e3c", Debat: "#c0392b", Demonstrasi: "#a93226",
  Kebijakan: "#2e7a52", Kunjungan: "#3a7ca5", Pertemuan: "#5b6c8a",
  Wawancara: "#7a6f58", "Konferensi Pers": "#6b3a6b", Pernyataan: "#6b645b",
  Pelantikan: "#9b7b3f", Keputusan: "#c06a2b", "Pemilu": "#3a4a8b",
  Pencalonan: "#8b5e3c", "Pengunduran Diri": "#8b2e1f", other: "#6b645b",
};

const records: Record<string, EventRecord[]> = {
  "budiman-sudjatmiko": [
    { id: 29, tipe: "Wawancara", kategori: "Politik", outlet: "Official iNews", tanggal: "20 Jun 2026", headline: "DULU LAWAN, Kini DUKUNG? Alasan Budiman Pilih Prabowo", summary: "Budiman Sudjatmiko menyatakan dukungannya kepada Prabowo Subianto, menjelaskan alasannya berubah dari posisi kritis menjadi pendukung. Dalam wawancara, ia menekani faktor kepemimpinan dan arah kebijakan nasional.", media: 1, kut: 1, score: -8, c: "1,2 rb", pos: 35, net: 30, neg: 35, src: [{ title: "DULU LAWAN, Kini DUKUNG? Alasan Budiman Pilih Prabowo | BTF", outlet: "Official iNews", date: "20 Jun 2026" }], related: [{ id: "prabowo-subianto", name: "Prabowo Subianto" }] },
  ],
  "prabowo-subianto": [
    { id: 1, tipe: "Pernyataan", kategori: "Politik", outlet: "Detik.com", tanggal: "19 Jun 2026", headline: "PSI Pede Prabowo Tetap Gandeng Gibran di Pilpres 2029", summary: "Ketua Harian DPP PSI menyatakan yakin Prabowo dan Gibran akan kembali maju bersama pada Pemilu Presiden 2029 untuk memastikan kesinambungan program pemerintah. Hingga kini belum ada pernyataan langsung dari Prabowo terkait pencalonan tersebut.", media: 1, kut: 1, score: -15, c: "2,4 rb", pos: 28, net: 30, neg: 42, src: [{ title: "PSI Yakin Duet Prabowo-Gibran Berlanjut di 2029", outlet: "Detik.com", date: "19 Jun 2026" }] },
    { id: 2, tipe: "Kebijakan", kategori: "Pertahanan", outlet: "Kompas", tanggal: "12 Jun 2026", headline: "Prabowo Resmikan Tambahan Anggaran Modernisasi Alutsista", summary: "Presiden meresmikan alokasi tambahan untuk modernisasi alat utama sistem persenjataan, menekankan kemandirian industri pertahanan dalam negeri sebagai prioritas jangka panjang.", media: 5, kut: 3, score: 52, c: "8,1 rb", pos: 68, net: 20, neg: 12, src: [
      { title: "Prabowo Tambah Anggaran Modernisasi Alutsista", outlet: "Kompas", date: "12 Jun 2026" },
      { title: "Anggaran Pertahanan Naik, Fokus Industri Dalam Negeri", outlet: "Tempo", date: "12 Jun 2026" },
      { title: "Modernisasi Alutsista Jadi Prioritas Prabowo", outlet: "Antara", date: "12 Jun 2026" },
    ] },
    { id: 3, tipe: "Kebijakan", kategori: "Kebijakan Sosial", outlet: "Antara", tanggal: "5 Jun 2026", headline: "Program Makan Bergizi Gratis Tembus 20 Juta Penerima", summary: "Pemerintah melaporkan program Makan Bergizi Gratis telah menjangkau 20 juta penerima manfaat, meski sejumlah daerah masih melaporkan kendala distribusi dan kualitas pasokan.", media: 8, kut: 6, score: 8, c: "14 rb", pos: 41, net: 30, neg: 29, src: [
      { title: "MBG Capai 20 Juta Penerima", outlet: "Antara", date: "5 Jun 2026" },
      { title: "Program Makan Bergizi Hadapi Kendala Distribusi", outlet: "Kompas", date: "5 Jun 2026" },
    ] },
    { id: 4, tipe: "Pernyataan", kategori: "Ekonomi", outlet: "CNBC Indonesia", tanggal: "28 Mei 2026", headline: "Prabowo Targetkan Pertumbuhan Ekonomi 8 Persen pada 2027", summary: "Presiden menargetkan pertumbuhan ekonomi mencapai 8 persen pada 2027. Sejumlah ekonom menilai target tersebut ambisius di tengah tekanan global dan perlu didukung reformasi struktural.", media: 4, kut: 2, score: -28, c: "6,3 rb", pos: 24, net: 28, neg: 48, src: [
      { title: "Prabowo Patok Pertumbuhan 8 Persen", outlet: "CNBC Indonesia", date: "28 Mei 2026" },
      { title: "Ekonom Sebut Target 8 Persen Ambisius", outlet: "Bisnis.com", date: "28 Mei 2026" },
    ] },
    { id: 5, tipe: "Pidato", kategori: "Hubungan Luar Negeri", outlet: "Tempo", tanggal: "21 Mei 2026", headline: "Prabowo Tegaskan Politik Bebas-Aktif di KTT ASEAN", summary: "Dalam KTT ASEAN, Presiden menegaskan komitmen Indonesia pada prinsip politik luar negeri bebas-aktif dan mendorong sentralitas ASEAN di tengah rivalitas kekuatan besar.", media: 6, kut: 4, score: 34, c: "5,2 rb", pos: 58, net: 26, neg: 16, src: [
      { title: "Prabowo Tegaskan Bebas-Aktif di ASEAN", outlet: "Tempo", date: "21 Mei 2026" },
      { title: "Sentralitas ASEAN Disuarakan Indonesia", outlet: "Antara", date: "21 Mei 2026" },
    ] },
    { id: 6, tipe: "Pernyataan", kategori: "Hukum", outlet: "Republika", tanggal: "14 Mei 2026", headline: "Prabowo Minta Penegakan Hukum Tak Pandang Bulu", summary: "Presiden meminta aparat penegak hukum bekerja tanpa pandang bulu dan menindak tegas korupsi, sembari menekankan pentingnya kepastian hukum bagi investasi.", media: 3, kut: 2, score: 19, c: "4,1 rb", pos: 49, net: 29, neg: 22, src: [
      { title: "Prabowo: Hukum Tak Pandang Bulu", outlet: "Republika", date: "14 Mei 2026" },
      { title: "Presiden Tekankan Pemberantasan Korupsi", outlet: "Detik.com", date: "14 Mei 2026" },
    ] },
  ],
};

interface Group {
  year: string;
  month: string;
  key: string;
  records: (EventRecord & { dayBadge: string })[];
}

function groupRecords(recs: EventRecord[]): Group[] {
  const MONTH_MAP: Record<string, string> = {
    Jan: "Januari", Feb: "Februari", Mar: "Maret", Apr: "April", Mei: "Mei", Jun: "Juni",
    Jul: "Juli", Agu: "Agustus", Sep: "September", Okt: "Oktober", Nov: "November", Des: "Desember",
  };
  const groups: Group[] = [];
  recs.forEach((r) => {
    const p = r.tanggal.split(" ");
    const dayBadge = p[0] + " " + p[1];
    const key = p[2] + p[1];
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, year: p[2], month: MONTH_MAP[p[1]] || p[1], records: [] };
      groups.push(g);
    }
    g.records.push({ ...r, dayBadge });
  });
  return groups;
}

export default async function HalamanTokoh({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fig = figures[id];
  if (!fig) return <div>Figure not found</div>;

  const groups = groupRecords(records[id] || []);

  return (
    <div style={{ minHeight: "100vh", background: "#f6f2e9", fontFamily: "'Public Sans', system-ui, sans-serif", color: "#16130f" }}>
      <Nav />

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 48px 80px" }}>
        <div style={{ padding: "22px 0 16px", fontSize: 12.5, fontWeight: 600, color: "#7a7264" }}>
          <Link href="/" style={{ cursor: "pointer", color: "#8b2e1f", textDecoration: "none" }}>Beranda</Link>
          <span style={{ margin: "0 8px", color: "#bcb3a0" }}>/</span>
          <span style={{ color: "#16130f" }}>{fig.name}</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 52, alignItems: "start", paddingTop: 8 }}>
          <ProfileSidebar fig={fig} />
          <TimelineContent groups={groups} figId={id} />
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
        <Link href="/" style={{ color: "#16130f", borderBottom: "2px solid #8b2e1f", paddingBottom: 2, textDecoration: "none" }}>Rekam Jejak</Link>
        <Link href="/timeline" style={{ color: "#7a7264", textDecoration: "none" }}>Lini Masa</Link>
        <Link href="/review" style={{ color: "#7a7264", textDecoration: "none" }}>Antrean Tinjauan</Link>
      </div>
    </div>
  );
}

function ProfileSidebar({ fig }: { fig: { initials: string; name: string; role: string; catatan: string; outlet: string; avgScore: number } }) {
  return (
    <div style={{ position: "sticky", top: 72, alignSelf: "start" }}>
      <div style={{ width: 108, height: 132, background: "repeating-linear-gradient(135deg,#e4ddcf,#e4ddcf 6px,#ece6d9 6px,#ece6d9 12px)", border: "1px solid #16130f", display: "flex", alignItems: "flex-end", justifyContent: "center", marginBottom: 18 }}>
        <span style={{ fontFamily: "'Newsreader', serif", fontSize: 40, color: "#b9ab93", paddingBottom: 8 }}>{fig.initials}</span>
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "#8b2e1f", marginBottom: 8 }}>{fig.role}</div>
      <h2 style={{ fontFamily: "'Newsreader', serif", fontWeight: 500, fontSize: 34, lineHeight: 1.0, margin: "0 0 16px", letterSpacing: "-0.015em" }}>{fig.name}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13, color: "#4a443d", paddingBottom: 18, borderBottom: "1px solid #d8cfba" }}>
        <span><strong style={{ color: "#16130f" }}>{fig.catatan}</strong> catatan</span>
        <span><strong style={{ color: "#16130f" }}>{fig.outlet}</strong> outlet meliput</span>
      </div>
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#6b645b", marginBottom: 12 }}>Sentimen rata-rata</div>
        <div style={{ position: "relative", height: 10, borderRadius: 99, background: "linear-gradient(90deg,#d6453e,#e0a53b 50%,#2e9e6b)", marginBottom: 12 }}>
          <div style={{ position: "absolute", left: left(fig.avgScore), top: "50%", transform: "translate(-50%,-50%)", width: 30, height: 30, borderRadius: "50%", background: "#f6f2e9", border: "1px solid #16130f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>{emoji(fig.avgScore)}</div>
        </div>
        <div style={{ fontFamily: "'Newsreader', serif", fontSize: 16 }}>{disp(fig.avgScore)} · {slbl(fig.avgScore)}</div>
      </div>
    </div>
  );
}

function TimelineContent({ groups, figId }: { groups: Group[]; figId: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0 14px", borderBottom: "3px double #16130f", position: "sticky", top: 72, zIndex: 6, background: "#f6f2e9", boxShadow: "0 -20px 0 #f6f2e9" }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#16130f" }}>Rekam Jejak</span>
        <span style={{ fontSize: 12.5, color: "#7a7264" }}>Terbaru lebih dulu</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "18px 0 4px" }}>
        {["Semua", "Politik", "Ekonomi", "Pertahanan", "Kebijakan Sosial", "Hukum"].map((chip) => (
          <span key={chip} style={{
            fontSize: 11.5, fontWeight: 600,
            color: chip === "Semua" ? "#f6f2e9" : "#6b645b",
            background: chip === "Semua" ? "#16130f" : "transparent",
            border: chip === "Semua" ? "none" : "1px solid #d8cfba",
            padding: "5px 12px", borderRadius: 2, cursor: "pointer",
          }}>{chip}</span>
        ))}
      </div>

      <div style={{ marginTop: 8 }}>
        {groups.map((g) => (
          <div key={g.key}>
            <div style={{ position: "sticky", top: 104, zIndex: 5, background: "#f6f2e9", marginLeft: -44, padding: "16px 0 12px 44px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "'Newsreader', serif", fontWeight: 600, fontSize: 20, color: "#16130f" }}>{g.year}</span>
              <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#b9ab93" }} />
              <span style={{ fontFamily: "'Newsreader', serif", fontSize: 20, color: "#9b8f7d" }}>{g.month}</span>
              <span style={{ flex: 1, height: 1, background: "#d8cfba", marginLeft: 6 }} />
            </div>
            <div style={{ marginLeft: 14 }}>
              {g.records.map((r) => (
                <RecordCard key={r.id} r={r} figId={figId} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function logoFor(outlet: string): { mono: string; color: string; name: string } {
  const map: Record<string, { mono: string; color: string; name: string }> = {
    "Detik.com": { mono: "d", color: "#1467c8", name: "detikcom" },
    "Kompas": { mono: "K", color: "#1a6aa8", name: "Kompas" },
    "Antara": { mono: "A", color: "#c8102e", name: "ANTARA" },
    "CNBC Indonesia": { mono: "C", color: "#13314f", name: "CNBC Indonesia" },
    "Tempo": { mono: "T", color: "#b01e2e", name: "TEMPO" },
    "Republika": { mono: "R", color: "#1f7a4d", name: "Republika" },
    "Bisnis.com": { mono: "B", color: "#1f6fb2", name: "Bisnis.com" },
    "CNN Indonesia": { mono: "C", color: "#cc0000", name: "CNN Indonesia" },
    "Kontan": { mono: "K", color: "#e07b00", name: "Kontan" },
    "Bloomberg": { mono: "B", color: "#1e1e1e", name: "Bloomberg" },
    "Al Jazeera": { mono: "AJ", color: "#c8102e", name: "Al Jazeera" },
    "Reuters": { mono: "R", color: "#ff8000", name: "Reuters" },
    "Associated Press": { mono: "AP", color: "#1a1a1a", name: "Associated Press" },
    "AFP": { mono: "A", color: "#003776", name: "Agence France-Presse" },
    "The Guardian": { mono: "G", color: "#052962", name: "The Guardian" },
    "BBC News": { mono: "BBC", color: "#bb1919", name: "BBC News" },
    "The New York Times": { mono: "NYT", color: "#000000", name: "The New York Times" },
  };
  return map[outlet] || { mono: (outlet || "?").charAt(0), color: "#6b645b", name: outlet };
}

function summaryWithLinks(summary: string, related: { id: string; name: string }[]): React.ReactNode {
  let text = summary;
  const nodes: React.ReactNode[] = [];
  let key = 0;
  while (text.length > 0) {
    let found: { id: string; name: string; idx: number } | null = null;
    for (const fig of related) {
      const idx = text.indexOf(fig.name);
      if (idx !== -1 && (found === null || idx < found.idx)) {
        found = { ...fig, idx };
      }
    }
    if (found === null) {
      nodes.push(text);
      break;
    }
    if (found.idx > 0) nodes.push(text.slice(0, found.idx));
    nodes.push(<Link key={key++} href={`/figure/${found.id}`} style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2, textDecorationColor: "#bcb3a0" }} className="fig-link">{found.name}</Link>);
    text = text.slice(found.idx + found.name.length);
  }
  return nodes.length === 1 ? nodes[0] : nodes;
}

function RecordCard({ r, figId }: { r: EventRecord & { dayBadge: string }; figId: string }) {
  const badgeColor = r.media >= 2 ? { color: "#3d6b4a", border: "#b6d0bd", bg: "#e6efe8", label: `✓ Dikuatkan ${r.media} media` } : { color: "#8b2e1f", border: "#d8a99f", bg: "#f5e7e3", label: "⚠ Satu sumber" };

  const uniqueLogos = Array.from(new Map((r.src || []).map((s) => [s.outlet, logoFor(s.outlet)])).values());

  return (
    <Link href={`/figure/${figId}/${r.id}`} style={{ position: "relative", display: "block", borderLeft: "1.5px solid #d8cfba", padding: "36px 0 34px 42px", textDecoration: "none", color: "inherit" }}>
      <div style={{ position: "absolute", left: -14, top: 0 }}>
        <span style={{ display: "inline-block", background: "#6b645b", color: "#ffffff", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", padding: "4px 12px", borderRadius: 99, whiteSpace: "nowrap", boxShadow: "0 0 0 4px #f6f2e9" }}>{r.dayBadge}</span>
      </div>
      <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: catColors[r.kategori] || "#6b645b" }}>{r.kategori}</span>
        {r.tipe && (
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#f6f2e9", background: tipeColors[r.tipe] || "#6b645b", padding: "2px 8px", borderRadius: 2 }}>{r.tipe}</span>
        )}
      </div>
      <h3 style={{ fontFamily: "'Newsreader', serif", fontWeight: 600, fontSize: 25, lineHeight: 1.16, margin: "0 0 10px", letterSpacing: "-0.01em" }}>{r.headline}</h3>
      <p style={{ fontSize: 14.5, lineHeight: 1.62, color: "#3e382f", margin: "0 0 14px" }}>
        {r.related ? summaryWithLinks(r.summary, r.related) : (
          <TranslatedText
            translated={r.summary}
            original={r.summaryOriginal || null}
            originalLang={r.summaryLang || null}
            as="span"
          />
        )}
      </p>

      <details style={{ marginBottom: 16, cursor: "default" }}>
        <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, listStyle: "none", cursor: "pointer" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#8b2e1f", padding: "3px 0" }}>
              ▸ Show Sources ({r.media})
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", flex: "none", paddingLeft: 5 }}>
            {uniqueLogos.map((lg, i) => (
              <div key={i} title={lg.name} style={{
                width: 22, height: 22, borderRadius: 5, background: lg.color, color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "'Newsreader', serif", fontSize: 12, fontWeight: 600, lineHeight: 1,
                border: "1.5px solid #f6f2e9", marginLeft: i > 0 ? -5 : 0,
              }}>{lg.mono}</div>
            ))}
          </div>
        </summary>
        <div style={{ background: "#efe9dc", border: "1px solid #ddd3bf", padding: "4px 16px 6px", marginTop: 12 }}>
          {r.src.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "11px 0", borderBottom: i < r.src.length - 1 ? "1px solid #ddd3bf" : "none" }}>
              <div style={{ flex: "none", fontFamily: "'Newsreader', serif", fontSize: 13, color: "#bcb3a0", width: 22 }}>{String(i + 1).padStart(2, "0")}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#16130f", lineHeight: 1.3 }}>{s.title}</div>
                <div style={{ fontSize: 11.5, color: "#7a7264", marginTop: 2 }}>{s.outlet} · {s.date}</div>
              </div>
              <div style={{ flex: "none", fontSize: 11.5, fontWeight: 600, color: "#8b2e1f", alignSelf: "center" }}>Buka ↗</div>
            </div>
          ))}
        </div>
      </details>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#9b9285" }}>Sentimen Publik</span>
        <span style={{ fontSize: 12, color: "#7a7264" }}>{r.c} komentar dari YouTube</span>
      </div>

      <div style={{ position: "relative", height: 8, borderRadius: 99, background: "linear-gradient(90deg,#d6453e,#e0a53b 50%,#2e9e6b)" }}>
        <div style={{ position: "absolute", left: left(r.score), top: "50%", transform: "translate(-50%,-50%)", width: 26, height: 26, borderRadius: "50%", background: "#f6f2e9", border: "1px solid #16130f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>{emoji(r.score)}</div>
      </div>

      <div style={{ display: "flex", gap: 18, marginTop: 7, fontSize: 11.5, color: "#7a7264" }}>
        <span>{r.pos}% positif</span><span>{r.net}% netral</span><span>{r.neg}% negatif</span>
      </div>
    </Link>
  );
}
