import Link from "next/link";

const figures = [
  { id: "prabowo-subianto", name: "Prabowo Subianto", role: "Presiden RI", initials: "PS" },
  { id: "budiman-sudjatmiko", name: "Budiman Sudjatmiko", role: "Politisi", initials: "BS" },
];

const BULAN = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function today() {
  const d = new Date();
  return `${d.getDate()} ${BULAN[d.getMonth() + 1]} ${d.getFullYear()}`;
}

export default function Beranda() {
  return (
    <div style={{ minHeight: "100vh", background: "#f6f2e9", fontFamily: "'Public Sans', system-ui, sans-serif", color: "#16130f" }}>
      <Nav />

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 48px 80px" }}>
        <div style={{ padding: "56px 0 32px", borderBottom: "3px double #16130f" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 40 }}>
            <div style={{ maxWidth: 680 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "#8b2e1f", marginBottom: 16 }}>
                Portal Rekam Jejak Tokoh Publik
              </div>
              <h1 style={{ fontFamily: "'Newsreader', serif", fontWeight: 500, fontSize: 58, lineHeight: "0.98", margin: "0 0 18px", letterSpacing: "-0.02em" }}>
                Lacak bagaimana tokoh bertindak di mata media.
              </h1>
              <p style={{ fontSize: 16, lineHeight: 1.6, color: "#4a443d", margin: 0, maxWidth: 560 }}>
                Setiap catatan dirangkum dari pemberitaan terverifikasi sumber — lengkap dengan sentimen publik dari komentar YouTube pada skala merah ke hijau.
              </p>
            </div>
            <div style={{ flex: "none", textAlign: "right", fontSize: 12.5, color: "#7a7264", lineHeight: 1.7, borderLeft: "1px solid #d8cfba", paddingLeft: 24 }}>
              <div style={{ fontWeight: 700, color: "#16130f" }}>{today()}</div>
              <div>2 tokoh dipantau</div>
              <div>17 catatan</div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "32px 0 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#16130f" }}>
            Tokoh Dipantau
          </div>
          <div style={{ fontSize: 12.5, color: "#7a7264" }}>Diurutkan berdasarkan aktivitas terbaru</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "#d8cfba", border: "1px solid #d8cfba" }}>
          {figures.map((fig) => (
            <Link
              key={fig.id}
              href={`/figure/${fig.id}`}
              style={{ background: "#f6f2e9", padding: 24, cursor: "pointer", display: "flex", gap: 16, alignItems: "flex-start", textDecoration: "none", color: "inherit" }}
            >
              <div style={{ flex: "none", width: 54, height: 64, background: "repeating-linear-gradient(135deg,#e4ddcf,#e4ddcf 5px,#ece6d9 5px,#ece6d9 10px)", border: "1px solid #16130f", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                <span style={{ fontFamily: "'Newsreader', serif", fontSize: 20, color: "#b9ab93", paddingBottom: 4 }}>{fig.initials}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8b2e1f", marginBottom: 4 }}>{fig.role}</div>
                <div style={{ fontFamily: "'Newsreader', serif", fontWeight: 600, fontSize: 21, lineHeight: 1.1 }}>{fig.name}</div>
              </div>
            </Link>
          ))}
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
        <Link href="/" style={{ color: "#16130f", textDecoration: "none" }}>Beranda</Link>
        <Link href="/" style={{ color: "#7a7264", textDecoration: "none" }}>Tokoh</Link>
        <Link href="/review" style={{ color: "#7a7264", textDecoration: "none" }}>Antrean Tinjauan</Link>
        <span style={{ cursor: "pointer" }}>Tentang</span>
      </div>
    </div>
  );
}
