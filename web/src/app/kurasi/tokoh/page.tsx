import Link from "next/link";
import FigurePortrait from "@/components/FigurePortrait";
import WeekStrip from "@/components/WeekStrip";
import { getFigureList, getFigureWeeksLocal } from "@/lib/kurasiLists";
import { figureTitle } from "@/lib/curation";
import { daysAgoLabel } from "@/lib/design";
import { GROUPS, groupLabel, groupOf, isGroupId } from "@/lib/groups";
import { ChipNav, Page, PageHead, SearchBox } from "../kit";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tokoh · Kurasi",
  robots: { index: false, follow: false },
};

const WEEKS = 12;

/**
 * Every tracked figure on the public /tokoh board's rows (globals.css .dir-*),
 * the busiest first; each opens its curation page. Counts come from jejak.db,
 * so they include records not yet curated.
 */
export default async function TokohList({ searchParams }: { searchParams: Promise<{ q?: string; grup?: string }> }) {
  const params = await searchParams;
  const q = (params.q ?? "").slice(0, 100);
  const group = isGroupId(params.grup) ? params.grup : null;
  const [figures, weeks] = await Promise.all([getFigureList(q), getFigureWeeksLocal(WEEKS)]);
  const empty = Array<number>(WEEKS).fill(0);
  const rows = figures
    .map((f) => ({ f, group: groupOf({ id: f.id, role: f.role ?? "", positions: JSON.stringify(f.positions) }), weeks: weeks.get(f.id) ?? empty }))
    .filter((r) => !group || r.group === group);
  const href = (g: string | null) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (g) p.set("grup", g);
    const s = p.toString();
    return s ? `/kurasi/tokoh?${s}` : "/kurasi/tokoh";
  };

  return (
    <Page>
      <PageHead
        crumb="Kurasi · Tokoh"
        title="Tokoh."
        lede="Nama, alias, jabatan dan CV setiap tokoh yang dilacak. Gabungkan duplikat atau nonaktifkan yang bukan orang dari halamannya."
        actions={<SearchBox action="/kurasi/tokoh" q={q} placeholder="Cari nama, alias, atau jabatan…" label="Cari tokoh" keep={group ? { grup: group } : undefined} />}
      />
      <section aria-label="Daftar tokoh">
        <div className="dir-filter">
          <ChipNav
            label="Kelompok"
            small
            items={[{ href: href(null), label: "Semua", current: !group }, ...GROUPS.map((g) => ({ href: href(g.id), label: g.label, current: group === g.id }))]}
          />
          <span className="dir-legend" aria-hidden>
            0
            {[0, 1, 2, 3, 4].map((l) => <span key={l} className="wk-cell" data-level={l} />)}
            10+ catatan / minggu
          </span>
        </div>
        <div className="dir-row dir-row--head" aria-hidden>
          <span>#</span>
          <span>Tokoh</span>
          <span>{WEEKS} minggu terakhir</span>
          <span>Catatan</span>
          <span>Kutipan</span>
          <span>Terakhir</span>
        </div>
        {rows.length ? (
          <ol className="dir-list">
            {rows.map(({ f, group: g, weeks: w }, i) => {
              const thisWeek = w[WEEKS - 1] > 0;
              const title = figureTitle(f);
              return (
                <li key={f.id} className="dir-row" data-week={thisWeek ? "" : undefined}>
                  <span className="dir-rank">{String(i + 1).padStart(2, "0")}</span>
                  <span className="dir-who">
                    <FigurePortrait figureId={f.id} name={f.name} width={38} round fontSize={13} hatchStep={4} />
                    <span style={{ minWidth: 0 }}>
                      <span className="dir-name-line">
                        <Link href={`/kurasi/tokoh/${f.id}`} className="dir-name">{f.name}</Link>
                        {thisWeek ? <span className="dir-badge">Minggu ini</span> : null}
                      </span>
                      <span className="dir-role">{title ? `${title} · ` : "jabatan belum diisi · "}{groupLabel(g)}</span>
                    </span>
                  </span>
                  <span className="dir-weeks"><WeekStrip counts={w} /></span>
                  <span className="dir-count">
                    {Number(f.records).toLocaleString("id-ID")}
                    <span className="dir-count-unit"> catatan</span>
                  </span>
                  <span className="dir-react dir-last">{Number(f.quotes).toLocaleString("id-ID")}</span>
                  <span className="dir-last">{daysAgoLabel(f.last_seen)}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="dir-empty">
            Tidak ada tokoh yang cocok{q ? ` dengan “${q}”` : ""}. <Link href="/kurasi/tokoh" className="link-subtle">Lihat semua tokoh</Link>
          </p>
        )}
        <div className="dir-more">
          <span>{rows.length.toLocaleString("id-ID")} tokoh</span>
        </div>
      </section>
    </Page>
  );
}
