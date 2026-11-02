import Link from "next/link";
import { notFound } from "next/navigation";
import { getFigureOptions, getOrganizations, positionTitle } from "@/lib/curation";
import { getFigureFull } from "@/lib/kurasiLists";
import { FigureForm, FigureOptions, NotAPersonForm, OrgOptions, SamePerson, type Open } from "../../FigureEdit";
import { Card, Columns, Page, PageHead, Pill, RowLink } from "../../kit";
import { INK, MUTED, day } from "../../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tokoh · Kurasi",
  robots: { index: false, follow: false },
};

/**
 * One figure: its identity and offices, the same form the record page's
 * drawer opens; whether it is someone else already tracked; and the records
 * it acts in, filed under it or added as a Pelaku.
 */
export default async function TokohPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9-]{1,128}$/.test(id)) notFound();
  const [full, figures, orgs] = await Promise.all([getFigureFull(id), getFigureOptions(), getOrganizations()]);
  if (!full) notFound();
  const { person: p, records, recordCount, quotes, quoteCount } = full;
  const title = p.positions[0] ? positionTitle(p.positions[0]) : p.role;
  // Links inside the shared forms name a panel; here every figure has a page.
  const open: Open = (panel) => (panel.startsWith("tokoh:") ? `/kurasi/tokoh/${panel.slice(6)}` : `/kurasi/tokoh/${id}`);
  return (
    <Page>
      <PageHead
        crumb={<><Link href="/kurasi/tokoh" style={{ color: "inherit" }}>Tokoh</Link> · {p.id}</>}
        title={p.name}
        lede={<>{title ?? "Jabatan belum diisi"}{p.active === false ? <> · <Pill tone="danger">nonaktif</Pill></> : null}</>}
        actions={<Link href={`/tokoh/${p.id}`} target="_blank" style={{ fontSize: 12.5, color: MUTED }}>Lihat di situs ↗</Link>}
      />
      <FigureOptions figures={figures} />
      <OrgOptions orgs={orgs} />
      <Columns
        sideWidth={400}
        main={
          <>
            <Card title="Identitas & jabatan" note="Nama, jabatan, CV dan alias. Berlaku di seluruh situs dan dipakai pipeline untuk artikel berikutnya.">
              <FigureForm figure={p} eventId={0} />
              <NotAPersonForm figureId={p.id} eventId={0} />
            </Card>
            {p.active !== false ? (
              <Card title="Gabung duplikat" note="Bila tokoh ini orang yang sama dengan tokoh lain, gabungkan: catatannya pindah dan namanya jadi alias.">
                <SamePerson person={p} eventId={0} figures={figures} open={open} />
              </Card>
            ) : null}
          </>
        }
        side={
          <>
            <Card title="Catatan" count={recordCount} flush>
              {records.length === 0 ? <p style={{ fontSize: 13, color: MUTED, padding: "18px 0", margin: 0 }}>Belum ada catatan.</p> : null}
              {records.map((r, i) => (
                <RowLink key={r.event_id} href={`/kurasi/${r.event_id}`} first={i === 0}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13.5, lineHeight: 1.4, color: INK, opacity: r.curated === "rejected" ? 0.6 : 1 }}>{r.title ?? `#${r.event_id}`}</span>
                    <span style={{ display: "block", fontSize: 12, color: MUTED }}>
                      {day(r.event_date)}{r.filed ? "" : " · pelaku tambahan"}
                      {r.open_points ? <span style={{ color: "#7a5a12", fontWeight: 600 }}> · {r.open_points} poin</span> : null}
                    </span>
                  </span>
                  {r.curated === "rejected" ? <Pill tone="danger">diturunkan</Pill> : r.curated === "kept" ? <Pill tone="accept">diperiksa</Pill> : null}
                </RowLink>
              ))}
              {recordCount > records.length ? (
                <p style={{ fontSize: 12, color: MUTED, padding: "10px 0", margin: 0 }}>{records.length} terbaru dari {recordCount}.</p>
              ) : null}
            </Card>
            <Card title="Kutipan terbaru" count={quoteCount}>
              {quotes.length === 0 ? <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>Belum ada kutipan.</p> : null}
              {quotes.map((q, i) => (
                <div key={q.id} style={{ marginTop: i ? 12 : 0 }}>
                  <p style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 14.5, lineHeight: 1.5, color: "var(--color-mud)" }}>“{q.quote}”</p>
                  <Link href={`/kurasi/${q.event_id}#kutipan`} style={{ fontSize: 12, color: MUTED }}>{q.source ?? "sumber"} · catatan #{q.event_id}</Link>
                </div>
              ))}
            </Card>
          </>
        }
      />
    </Page>
  );
}
