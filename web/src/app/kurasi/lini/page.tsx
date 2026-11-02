import Link from "next/link";
import { getLiniProposals, getLinis, type LiniEvent } from "@/lib/kurasiLists";
import { ruleFollowup } from "../actions";
import { Card, Columns, Hidden, Page, PageHead } from "../kit";
import { INK, MUTED, RULE, button, day } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Lini cerita · Kurasi",
  robots: { index: false, follow: false },
};

/**
 * Lini cerita: proposals to rule on, and the chains already confirmed —
 * announced then revised, promised then kept. Sambungkan and Lepas happen on
 * a catatan's own page, where both ends can be read.
 */
export default async function LiniPage() {
  const [linis, proposals] = await Promise.all([getLinis(), getLiniProposals()]);
  const small = { minHeight: 30, padding: "4px 10px", fontSize: 12 } as const;
  return (
    <Page>
      <PageHead crumb="Kurasi · Lini cerita" title="Lini cerita." lede="Rangkaian catatan atau peristiwa yang saling melanjutkan. Usulan pipeline di kiri; lini yang sudah dikonfirmasi di kanan." />
      <Columns
        sideWidth={420}
        main={
          <Card title="Usulan" count={proposals.total.toLocaleString("id-ID")} note="Yang terkuat dulu. Buka salah satu ujungnya untuk membaca keduanya sebelum memutuskan." flush>
            {proposals.rows.length === 0 ? <p style={{ fontSize: 13.5, color: MUTED, padding: "18px 0", margin: 0 }}>Tidak ada usulan.</p> : null}
            {proposals.rows.map((p, i) => (
              <div key={`${p.earlier.event_id}-${p.later.event_id}`} style={{ padding: "14px 0", borderTop: i ? `1px solid ${RULE}` : "none", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 360px", minWidth: 0, display: "grid", gap: 4 }}>
                  <EventLine e={p.earlier} />
                  <EventLine e={p.later} arrow />
                  {p.evidence.length ? <span style={{ fontSize: 12, color: MUTED }}>kata yang sama: {p.evidence.slice(0, 5).join(", ")}{p.score !== null ? ` · skor ${p.score.toFixed(2)}` : ""}</span> : null}
                </div>
                <span style={{ display: "flex", gap: 6 }}>
                  <form action={ruleFollowup}>
                    <Hidden fields={{ earlier_id: p.earlier.event_id, later_id: p.later.event_id, verdict: "confirmed" }} />
                    <button type="submit" style={{ ...button("accept"), ...small }}>Ya</button>
                  </form>
                  <form action={ruleFollowup}>
                    <Hidden fields={{ earlier_id: p.earlier.event_id, later_id: p.later.event_id, verdict: "rejected" }} />
                    <button type="submit" style={{ ...button("quiet"), ...small }}>Bukan</button>
                  </form>
                </span>
              </div>
            ))}
            {proposals.total > proposals.rows.length ? (
              <p style={{ fontSize: 12, color: MUTED, padding: "10px 0", margin: 0, borderTop: `1px solid ${RULE}` }}>
                {proposals.rows.length} terkuat dari {proposals.total.toLocaleString("id-ID")}. Sisanya juga ada di <Link href="/kurasi?filter=followups" style={{ color: MUTED }}>antrean “Usulan kelanjutan”</Link>.
              </p>
            ) : null}
          </Card>
        }
        side={
          <Card title="Dikonfirmasi" count={linis.length} flush>
            {linis.length === 0 ? (
              <p style={{ fontSize: 13.5, color: MUTED, padding: "18px 0", margin: 0 }}>Belum ada. Sambungkan dari sebuah catatan, lewat “Sambungkan” di panel Relasi.</p>
            ) : null}
            {linis.map((l, i) => (
              <div key={l.events[0].event_id} style={{ padding: "14px 0", borderTop: i ? `1px solid ${RULE}` : "none" }}>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>{[...new Set(l.events.map((e) => e.figure_name).filter(Boolean))].join(", ") || "Peristiwa"}</div>
                <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {l.events.map((e, j) => (
                    <li key={e.event_id} style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
                      <span aria-hidden style={{ width: 12, flex: "none", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <span style={{ width: 10, height: 10, borderRadius: "50%", marginTop: 5, background: j === l.events.length - 1 ? INK : "var(--color-cream)", border: `2px solid ${INK}`, boxSizing: "border-box" }} />
                        {j < l.events.length - 1 ? <span style={{ flex: 1, width: 2, background: RULE }} /> : null}
                      </span>
                      <Link href={`/kurasi/${e.event_id}`} style={{ paddingBottom: 10, color: INK, textDecoration: "none", minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12, color: MUTED }}>{day(e.event_date)}</span>
                        <span style={{ display: "block", fontSize: 13.5, lineHeight: 1.4 }}>{e.title ?? `#${e.event_id}`}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </Card>
        }
      />
    </Page>
  );
}

function EventLine({ e, arrow = false }: { e: LiniEvent; arrow?: boolean }) {
  return (
    <Link href={`/kurasi/${e.event_id}`} style={{ color: INK, textDecoration: "none", fontSize: 13.5, lineHeight: 1.4 }}>
      <span style={{ color: MUTED, fontSize: 12 }}>{arrow ? "→ " : ""}{day(e.event_date)}{e.figure_name ? ` · ${e.figure_name}` : ""} · </span>
      {e.title ?? `#${e.event_id}`}
    </Link>
  );
}
