import Link from "next/link";
import SummaryList from "@/components/SummaryList";
import { getItem } from "@/lib/curation";
import { getPeristiwaCounts, getPeristiwaList, type PeristiwaFilter } from "@/lib/kurasiLists";
import { storyImageSource, storylines } from "@/lib/data";
import { curate, ruleLink } from "../actions";
import { EventBanner } from "../EventImage";
import { Chip, ChipNav, Group, Hidden, Page, PageHead, Pill, SearchBox, groupLabel, type PillTone } from "../kit";
import { ACCEPT, INK, MUTED, RULE, SURFACE, button, day, input } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Peristiwa · Kurasi",
  robots: { index: false, follow: false },
};

const FILTERS: { key: PeristiwaFilter; label: string }[] = [
  { key: "semua", label: "Tayang" },
  { key: "usulan", label: "Ada usulan catatan" },
  { key: "belum", label: "Belum diperiksa" },
  { key: "diturunkan", label: "Diturunkan" },
];

/**
 * Peristiwa: the list on the left, the selected one on the right with the
 * catatan in it to confirm or let go. Its judgement in full (sources, quotes,
 * curation points, Turunkan) stays on its curation page.
 */
export default async function PeristiwaPage({ searchParams }: { searchParams: Promise<{ id?: string; filter?: string; q?: string }> }) {
  const sp = await searchParams;
  const filter: PeristiwaFilter = FILTERS.find((f) => f.key === sp.filter)?.key ?? "semua";
  const q = (sp.q ?? "").slice(0, 100);
  const [list, counts] = await Promise.all([getPeristiwaList(filter, q), getPeristiwaCounts()]);
  const selectedId = Number(sp.id) || list[0]?.event_id || 0;
  const item = selectedId ? await getItem(selectedId) : null;
  const selected = item?.kind === "peristiwa" ? item : null;
  const image = selected
    ? storyImageSource(selected.event_id, (await storylines([selected.event_id], { evenHidden: [selected.event_id] })).get(selected.event_id) ?? [], selected.title)
    : null;
  const href = (o: { id?: number; filter?: PeristiwaFilter }) => {
    const p = new URLSearchParams();
    const f = o.filter ?? filter;
    if (f !== "semua") p.set("filter", f);
    if (q) p.set("q", q);
    if (o.id) p.set("id", String(o.id));
    const s = p.toString();
    return `/kurasi/peristiwa${s ? `?${s}` : ""}`;
  };

  return (
    <Page>
      <PageHead
        crumb="Kurasi · Peristiwa"
        title="Peristiwa."
        lede="Kejadian lintas tokoh. Pilih peristiwa di kiri; konfirmasi catatan di dalamnya di panel kanan."
        actions={<SearchBox action="/kurasi/peristiwa" q={q} placeholder="Cari judul peristiwa…" label="Cari judul peristiwa" keep={filter !== "semua" ? { filter } : undefined} />}
      />
      <div className="dir-filter">
        <ChipNav
          label="Saringan"
          small
          items={FILTERS.map((f) => ({ href: href({ filter: f.key }), label: f.label, count: counts[f.key].toLocaleString("id-ID"), current: filter === f.key }))}
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", columnGap: 44, rowGap: 24, alignItems: "flex-start" }}>
        <nav aria-label="Daftar peristiwa" style={{ flex: "1 1 300px", minWidth: 0, borderTop: `3px double ${INK}`, maxHeight: "calc(100vh - var(--strip-h) - 40px)", overflowY: "auto", position: "sticky", top: "calc(var(--strip-h) + 16px)" }}>
          {list.length === 0 ? <p style={{ fontSize: 13.5, color: MUTED, padding: 16, margin: 0 }}>Tidak ada peristiwa pada saringan ini.</p> : null}
          {list.map((p, i) => {
            const on = p.event_id === selected?.event_id;
            const [tone, label] = statusOf(p.curated);
            return (
              <Link key={p.event_id} href={href({ id: p.event_id })} aria-current={on ? "true" : undefined}
                style={{ display: "flex", flexDirection: "column", gap: 4, padding: "13px 12px", borderTop: i ? `1px solid ${RULE}` : "none", background: on ? INK : "transparent", color: on ? "var(--color-cream)" : INK, textDecoration: "none" }}>
                <span style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.35 }}>{p.title ?? `#${p.event_id}`}</span>
                <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: on ? "var(--color-parchment)" : MUTED }}>
                  <Pill tone={tone}>{label}</Pill>
                  {day(p.event_date)} · {p.confirmed} catatan
                  {p.proposed ? <span style={{ color: on ? "#f3dfa6" : "#7a5a12", fontWeight: 600 }}>· {p.proposed} usulan</span> : null}
                </span>
              </Link>
            );
          })}
        </nav>

        <section aria-label="Peristiwa terpilih" style={{ flex: "999 1 560px", minWidth: 0, borderTop: `3px double ${INK}` }}>
          {!selected ? (
            <p style={{ fontSize: 13.5, color: MUTED, padding: 20, margin: 0 }}>Pilih peristiwa di kiri.</p>
          ) : (
            <Selected item={selected} image={image} />
          )}
        </section>
      </div>
    </Page>
  );
}

function statusOf(curated: string | null): [PillTone, string] {
  return curated === "rejected" ? ["danger", "diturunkan"] : curated === "kept" ? ["accept", "diperiksa"] : ["pending", "belum diperiksa"];
}

function Selected({ item, image }: { item: NonNullable<Awaited<ReturnType<typeof getItem>>>; image: ReturnType<typeof storyImageSource> }) {
  const [tone, label] = statusOf(item.curated);
  const links = item.links.filter((l) => l.verdict !== "rejected");
  const rejected = item.links.length - links.length;
  const figures = item.named.filter((p) => p.kind === "figure" && !p.struck);
  const small = { minHeight: 32, padding: "5px 11px", fontSize: 12 } as const;
  return (
    <>
      <div style={{ padding: "12px 20px", background: "var(--color-cream-dark)", borderBottom: `1px solid ${RULE}`, borderRadius: "7px 7px 0 0", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={tone}>{label}</Pill>
        <span style={{ fontSize: 12.5, color: "var(--color-mud)" }}>#{item.event_id} · {day(item.event_date)}{item.last_seen && day(item.last_seen) !== day(item.event_date) ? ` – ${day(item.last_seen)}` : ""} · {item.sources.length} artikel</span>
        <span style={{ flex: 1 }} />
        {item.curated !== "kept" ? (
          <form action={curate}>
            <Hidden fields={{ event_id: item.event_id, verdict: "kept" }} />
            <button type="submit" style={{ ...button("accept"), ...small }}>{item.curated === "rejected" ? "Tayangkan lagi" : "Selesai diperiksa"}</button>
          </form>
        ) : null}
        <Link href={`/kurasi/${item.event_id}`} style={{ ...button("ink"), ...small, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>Kurasi lengkap →</Link>
      </div>

      <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Text on the left, the whole picture beside it at a reading size. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
          <div style={{ flex: "999 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 26, lineHeight: 1.2, letterSpacing: "-0.01em" }}>{item.title ?? "(tanpa judul)"}</h2>
            {item.summary ? (
              <SummaryList summary={item.summary} />
            ) : (
              <p style={{ margin: 0, fontSize: 13.5, color: MUTED, fontStyle: "italic" }}>Belum dirangkum.</p>
            )}
          </div>
          <div style={{ flex: "1 1 220px", maxWidth: 280, minWidth: 0 }}>
            <EventBanner eventId={item.event_id} image={image} />
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: MUTED }}>
          Judul atau ringkasan keliru? Minta ditulis ulang lewat “Kerjakan ulang” di <Link href={`/kurasi/${item.event_id}`} style={{ color: MUTED }}>halaman kurasinya</Link>.
        </p>
      </div>

      <Group label={`Catatan · ${links.length}`} action={rejected ? <span style={{ fontSize: 12, color: MUTED }}>{rejected} ditolak</span> : undefined}>
        {links.length === 0 ? <div style={{ fontSize: 13, color: MUTED }}>Belum ada catatan. Tautkan dari panel Relasi sebuah catatan.</div> : null}
        {links.map((l, i) => {
          const pair = { record_id: l.event_id, peristiwa_id: item.event_id };
          return (
            <div key={l.event_id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", paddingTop: i ? 10 : 0, borderTop: i ? `1px solid ${RULE}` : "none" }}>
              <Link href={`/kurasi/${l.event_id}`} style={{ flex: "1 1 240px", minWidth: 0, color: INK, textDecoration: "none" }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{l.title ?? `#${l.event_id}`}</span>
                <span style={{ display: "block", fontSize: 12, color: MUTED }}>#{l.event_id}{l.figure_name ? ` · ${l.figure_name}` : ""} · {day(l.event_date)}{l.evidence.length ? ` · ${l.evidence.slice(0, 4).join(", ")}` : ""}</span>
              </Link>
              {l.verdict === "confirmed" ? (
                <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: ACCEPT }}>✓ dikonfirmasi</span>
                  <form action={ruleLink}>
                    <Hidden fields={{ ...pair, verdict: "rejected" }} />
                    <button type="submit" aria-label={`Lepas ${l.title ?? l.event_id} dari peristiwa`} style={{ fontSize: 12, background: "none", border: "none", padding: "6px 0", cursor: "pointer", color: "var(--color-mud)", textDecoration: "underline" }}>Lepas</button>
                  </form>
                </span>
              ) : (
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#7a5a12", marginRight: 4 }}>usulan pipeline</span>
                  <form action={ruleLink}>
                    <Hidden fields={{ ...pair, verdict: "confirmed" }} />
                    <button type="submit" style={{ ...button("accept"), ...small }}>Konfirmasi</button>
                  </form>
                  <form action={ruleLink}>
                    <Hidden fields={{ ...pair, verdict: "rejected" }} />
                    <button type="submit" style={{ ...button("quiet"), ...small }}>Bukan</button>
                  </form>
                </span>
              )}
            </div>
          );
        })}
      </Group>

      <Group label="Tokoh terkait" last>
        {figures.length === 0 ? <div style={{ fontSize: 13, color: MUTED }}>Belum ada.</div> : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {figures.slice(0, 30).map((f) => (
              <Chip key={f.id} href={`/kurasi/tokoh/${f.id}`}>{f.name} <span style={{ color: MUTED }}>· {f.articles}</span></Chip>
            ))}
          </div>
        )}
        <span style={{ ...groupLabel, letterSpacing: 0, textTransform: "none", fontWeight: 400 }}>
          Dari liputannya. Coret yang salah cocok di <Link href={`/kurasi/${item.event_id}?panel=disebut`} style={{ color: MUTED }}>halaman kurasinya</Link>.
        </span>
      </Group>
    </>
  );
}
