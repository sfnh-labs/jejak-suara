import Nav from "@/components/Nav";
import EventCard from "@/components/EventCard";
import { getPeristiwa } from "@/lib/data";
import { monthGroupLabel } from "@/lib/design";
import type { Peristiwa } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Linimasa · Jejak Suara",
  description: "Peristiwa yang diberitakan banyak media, berurutan dari yang terbaru.",
};

export default async function Linimasa() {
  const peristiwa = await getPeristiwa(120);

  const groups = new Map<string, Peristiwa[]>();
  for (const p of peristiwa) {
    const key = monthGroupLabel(p.event_date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const types = [...new Set(peristiwa.map((p) => p.event_type).filter(Boolean))] as string[];

  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav active="/linimasa" />
      <div className="container-page" style={{ maxWidth: 820 }}>
        <header className="rule-heavy" style={{ padding: "clamp(28px, 5vw, 48px) 0 26px" }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Peristiwa</div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 500,
              fontSize: "clamp(30px, 5.5vw, 44px)",
              lineHeight: 1.05,
              margin: "0 0 14px",
              letterSpacing: "-0.02em",
            }}
          >
            Linimasa
          </h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.6, color: "#4a443d", margin: 0, maxWidth: 580 }}>
            Peristiwa yang diberitakan secara independen oleh beberapa media.
            Kami tidak menilai mana yang penting — yang tampil di sini adalah
            yang diliput luas.
          </p>
        </header>

        {types.length > 0 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "22px 0 6px" }}>
            {types.map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "#6b645b",
                  background: "#efe9dc",
                  border: "1px solid #ddd3bf",
                  borderRadius: 99,
                  padding: "4px 11px",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}

        {peristiwa.length === 0 ? (
          <p style={{ fontSize: 15, color: "#7a7264", padding: "28px 0 60px", lineHeight: 1.6 }}>
            Belum ada peristiwa yang cukup diberitakan untuk ditampilkan.
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
                  margin: "22px 0 16px",
                  padding: "6px 0",
                  borderBottom: "1px solid #d8cfba",
                }}
              >
                {month}
              </h2>
              <div style={{ display: "grid", gap: 16 }}>
                {rows.map((p) => (
                  <EventCard key={p.event_id} peristiwa={p} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
