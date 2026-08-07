import Nav from "@/components/Nav";

export const metadata = {
  title: "Tentang & Dukung Kami · Jejak Suara",
  description: "Kenapa Jejak Suara ada, bagaimana cara kerjanya, dan peta jalannya.",
};

const PRINSIP = [
  {
    no: "01",
    judul: "Selalu bersumber",
    isi: "Setiap catatan ditarik dari pemberitaan media, bukan tulisan kami sendiri. Tautan ke artikel aslinya selalu ada, supaya siapa pun bisa memeriksa ulang.",
  },
  {
    no: "02",
    judul: "Berimbang",
    isi: "Kami menghitung berapa media yang memberitakan hal yang sama. Kalau cuma satu, catatannya kami tandai — bukan kami sembunyikan.",
  },
  {
    no: "03",
    judul: "Terbuka",
    isi: "Metode, kode, dan sumber data bisa ditinjau publik. Kami tidak menilai benar atau salah; kami menyusun catatannya.",
  },
];

const PETA_JALAN = [
  { status: "Sedang dikerjakan", warna: "#8b2e1f", isi: "Sentimen dari platform kedua, agar tidak bergantung pada satu sumber reaksi." },
  { status: "Terdekat", warna: "#e0a53b", isi: "Notifikasi dan langganan untuk tokoh yang diikuti." },
  { status: "Direncanakan", warna: "#7a7264", isi: "API publik dan ekspor data terbuka." },
];

export default function Tentang() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav active="/tentang" />
      <div className="container-page" style={{ maxWidth: 760 }}>
        <header className="rule-heavy" style={{ padding: "clamp(28px, 5vw, 48px) 0 26px" }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Tentang</div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 500,
              fontSize: "clamp(30px, 5.5vw, 44px)",
              lineHeight: 1.05,
              margin: "0 0 16px",
              letterSpacing: "-0.02em",
            }}
          >
            Catatan yang bisa ditelusuri, bukan penilaian.
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.65, color: "#4a443d", margin: 0 }}>
            Jejak Suara menyusun rekam jejak tokoh publik dari pemberitaan media,
            merangkumnya per peristiwa, dan menampilkan reaksi publik apa adanya.
          </p>
        </header>

        <section style={{ padding: "34px 0 0" }}>
          <h2 className="section-label" style={{ marginBottom: 14 }}>Latar Belakang</h2>
          <p style={{ fontFamily: "var(--font-serif)", fontSize: 19, lineHeight: 1.6, color: "#3e382f", margin: 0 }}>
            Rekam jejak pejabat publik tersebar di ribuan berita yang cepat
            tenggelam. Ketika sebuah isu muncul lagi, hampir tidak ada cara
            praktis untuk melihat urutan kejadiannya. Jejak Suara mengumpulkan
            pemberitaan itu, mengelompokkannya jadi peristiwa, dan menyusunnya
            sebagai linimasa yang bisa ditelusuri sampai ke artikel aslinya.
          </p>
        </section>

        <section style={{ padding: "40px 0 0" }}>
          <h2 className="section-label" style={{ marginBottom: 16 }}>Prinsip Kami</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 28 }}>
            {PRINSIP.map((p) => (
              <div key={p.no}>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 26, color: "#8b2e1f", lineHeight: 1 }}>{p.no}</div>
                <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 19, fontWeight: 600, margin: "10px 0 8px" }}>{p.judul}</h3>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: "#4a443d", margin: 0 }}>{p.isi}</p>
              </div>
            ))}
          </div>
        </section>

        <section style={{ background: "#16130f", color: "#f6f2e9", padding: "34px clamp(20px, 5vw, 40px)", margin: "48px 0 0" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "#e0a53b", marginBottom: 14 }}>
            Dukung Kami
          </div>
          <h2 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "clamp(24px, 4vw, 32px)", lineHeight: 1.15, margin: "0 0 14px" }}>
            100% untuk operasional.
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: "#d8cfba", margin: "0 0 22px" }}>
            Jejak Suara tidak memasang iklan dan tidak menerima dana dari partai
            maupun tokoh yang dipantau. Biaya server dan pengumpulan data
            ditanggung dari donasi pembaca.
          </p>
          <span
            style={{
              display: "inline-block",
              background: "#f6f2e9",
              color: "#16130f",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              padding: "12px 22px",
            }}
          >
            Tautan donasi menyusul
          </span>
        </section>

        <section style={{ padding: "44px 0 0" }}>
          <h2 className="section-label" style={{ marginBottom: 16 }}>Peta Jalan</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, borderLeft: "1.5px solid #d8cfba" }}>
            {PETA_JALAN.map((r) => (
              <li key={r.status} style={{ position: "relative", padding: "0 0 22px 26px" }}>
                <span
                  aria-hidden
                  style={{ position: "absolute", left: -5.5, top: 6, width: 9, height: 9, borderRadius: "50%", background: r.warna }}
                />
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: r.warna }}>
                  {r.status}
                </div>
                <div style={{ fontSize: 14.5, lineHeight: 1.6, color: "#3e382f", marginTop: 4 }}>{r.isi}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
