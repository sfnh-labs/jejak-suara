import Link from "next/link";
import FigurePortrait from "@/components/FigurePortrait";
import { notFound } from "next/navigation";
import { REASONS, figureTitle, positionLine, getRelated, getFigureOptions, getOrgChoices, getFollowupCandidates, getItem, getReading, reasonLabel, type Related, type FigureOption, type FollowupCandidate, type FollowupRow, type Item, type Rework, type ReworkSnapshot, type LinkRow, type NamedPerson, type QuoteRow } from "@/lib/curation";
import { decide } from "../kandidat/actions";
import { AboutEditor, FigurePicker, SpeakerEditor } from "../FigurePicker";
import { ArticleReader, type ReaderFocus, type ReaderTerm } from "../ArticleReader";
import { EventPanel, FigurePanel, type Relation } from "../SidePanel";
import { eventPanel, getEventPeek, getFigurePeek, parsePanel, type EventPeek, type FigurePeek, type PanelRef } from "@/lib/panels";
import { PointList } from "../CurationPoints";
import { AUTO_MIN_AGREEMENT, AUTO_MIN_ANSWERS, getPoints, getUncheckedCount } from "@/lib/curationPoints";
import { addFollowup, curate, relateFigure, ruleFollowup, ruleLink, rework, decideRework, setQuoteSpeaker, setQuoteAbout, pickQuote, newQuote, setRecordRelated, openDecisionPoints } from "../actions";
import { storyImageSource, storylines } from "@/lib/data";
import { EventBanner } from "../EventImage";
import { placeGroups, provinceLabel, provincesIn } from "@/lib/places";
import { CandidateRow, FIGURE_LIST, FigureForm, FigureOptions, NotAPersonForm, OrgOptions, SamePerson, SubPanel, type Open } from "../FigureEdit";
import { Card, Chip, Columns, Drawer, Group, Hidden, Page, Pill, TextLink, eyebrow, groupLabel, headline, type PillTone } from "../kit";
import OutletTile from "@/components/OutletTile";
import SummaryList from "@/components/SummaryList";
import { ACCEPT, INK, MUTED, RULE, SURFACE, button, day, input, label } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kurasi · Jejak Suara",
  robots: { index: false, follow: false },
};

/**
 * The page is a summary; anything long is read in the drawer. Nama di liputan shows
 * this many names, Relasi this many peristiwa or lini rows, Isi this many
 * sources and Kutipan this many quotes; each drawer has the rest.
 */
const MENTIONS_SHOWN = 8;
const RELATIONS_SHOWN = 3;
const SOURCES_SHOWN = 3;
const QUOTES_SHOWN = 3;

/**
 * One catatan or peristiwa, as in the Kurasi Workflow prototype: the decision
 * on top; curation points, its content and its quotes in the main column;
 * everything it relates to summarised on the right. Changing a relation opens
 * that data's own form in a drawer (?panel=), and an article opens there too
 * (?baca=), so the curator never leaves the page.
 */
export default async function KurasiItem({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ perlu?: string; cari?: string; baca?: string; p?: string; panel?: string }>;
}) {
  const { id } = await params;
  const { perlu, cari = "", baca, p: pointParam, panel: panelParam } = await searchParams;
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0) notFound();
  const [item, figures, orgs] = await Promise.all([getItem(eventId), getFigureOptions(), getOrgChoices()]);
  if (!item) notFound();
  const isRecord = item.kind === "record";
  // One drawer at a time: an article, or a panel; opening either closes the other.
  const panelRef = baca ? null : parsePanel(panelParam);
  const [candidates, reading, points, peek, actors, unchecked] = await Promise.all([
    panelRef?.kind === "lini" ? getFollowupCandidates(item, cari.slice(0, 100)) : Promise.resolve([] as FollowupCandidate[]),
    baca ? getReading(eventId, baca.slice(0, 128)) : null,
    getPoints(eventId),
    panelRef?.kind === "tokoh" ? getFigurePeek(panelRef.id)
      : panelRef?.kind === "peristiwa" || panelRef?.kind === "catatan" ? getEventPeek(panelRef.id)
      : null,
    isRecord ? getRelated(eventId, item.figure_id) : Promise.resolve([] as Related[]),
    getUncheckedCount(eventId),
  ]);
  const openPoints = points.filter((p) => p.status === "open" || p.status === "lewati").length;
  // A lini point can be corrected to another suggestion; read them only when one waits.
  const liniChoices = panelRef?.kind === "lini" && !cari
    ? candidates
    : points.some((p) => p.kind === "lini" && (p.status === "open" || p.status === "lewati"))
      ? await getFollowupCandidates(item, "")
      : [];
  // The page's own address with the drawer set or cleared; the other
  // parameters ride along so opening an article or a panel loses nothing.
  const at = (side: { baca?: string; p?: number; panel?: string } = {}) => {
    const q = new URLSearchParams();
    if (perlu) q.set("perlu", perlu);
    if (side.baca) q.set("baca", side.baca);
    if (side.baca && side.p) q.set("p", String(side.p));
    if (side.panel) q.set("panel", side.panel);
    if (side.panel === "lini" && cari) q.set("cari", cari);
    const qs = q.toString();
    return `/kurasi/${eventId}${qs ? `?${qs}` : ""}`;
  };
  const read = (article: string) => at({ baca: article });
  const open: Open = (panel) => at({ panel });
  const terms = readerTerms(item, actors);
  // "baca beritanya" on a point: the reader opens at the paragraph it quotes.
  const focused = reading ? points.find((p) => String(p.id) === pointParam && p.article_id === reading.id) : undefined;
  const focus: ReaderFocus | undefined = focused?.paragraph
    ? {
        paragraph: focused.paragraph,
        highlight: focused.hl_start !== null && focused.hl_end !== null ? focused.paragraph.slice(focused.hl_start, focused.hl_end) : null,
      }
    : undefined;
  // The banner the site would show, borrowed ones included (peristiwa only).
  const image = isRecord
    ? null
    : storyImageSource(eventId, (await storylines([eventId], { evenHidden: [eventId] })).get(eventId) ?? [], item.title);

  const outlets = new Set(item.sources.map((s) => s.source)).size;
  const queue = `/kurasi?kind=${item.kind}`;
  // Headlines set in provinces nothing connects: the commonest sign that
  // clustering merged two stories (a Lokon wildfire with a Tangerang factory
  // fire). Peristiwa only; a record follows one person around the country.
  const places = isRecord ? [] : placeGroups(item.sources.map((s) => s.title));
  const scattered = places.length > 1;
  const what = isRecord ? "Catatan" : "Peristiwa";

  return (
    <Page>
      <header className="rule-heavy" style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
          <div style={eyebrow}>
            <Link href={queue} className="link-subtle">Antrean</Link>
            {" · "}{what} #{item.event_id}
            {item.event_type && item.event_type !== "other" ? ` · ${item.event_type}` : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {isRecord && item.figure_id && item.curated !== "rejected" ? (
              <Link href={`/tokoh/${item.figure_id}/${item.event_id}`} target="_blank" className="pill-link" style={pillNav}>Lihat di situs ↗</Link>
            ) : null}
            {item.next_id ? <Link href={`/kurasi/${item.next_id}`} className="pill-link is-primary" style={pillNav}>Lewati →</Link> : null}
          </div>
        </div>
        <h1 style={{ ...headline, fontSize: "clamp(28px, 5vw, 40px)" }}>
          {item.title ?? "(tanpa judul)"}
        </h1>
        <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
          {day(item.event_date)}
          {item.last_seen && day(item.last_seen) !== day(item.event_date) ? ` – ${day(item.last_seen)}` : ""}
          {isRecord ? (
            actors.length ? (
              <> · terkait {actors.map((a, i) => (
                <span key={a.id}>{i ? ", " : ""}<Link href={open(`tokoh:${a.id}`)} scroll={false} className="link-subtle" style={{ color: INK, fontWeight: 600 }}>{a.name}</Link></span>
              ))}</>
            ) : <> · belum ada tokoh terkait</>
          ) : null}
          {` · ${outlets} media · ${item.sources.length} artikel`}
        </p>
        {outlets <= 1 || scattered ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {outlets <= 1 ? (
              <Pill tone="danger" title="Semua artikelnya dari satu media. Belum ada redaksi lain yang ikut melaporkan, jadi periksa lebih teliti.">⚠ hanya 1 media</Pill>
            ) : null}
            {scattered ? <Pill tone="danger">⚠ beda provinsi</Pill> : null}
          </div>
        ) : null}
        {scattered ? (
          <p style={{ fontSize: 13, color: "var(--color-clay)", margin: 0, lineHeight: 1.5 }}>
            Judul artikelnya menyebut tempat yang berbeda:{" "}
            {places.map((g) => `${g.provinces.map(provinceLabel).join(" / ")} (${g.count})`).join(" · ")}.
            {" "}Bisa jadi beberapa kejadian yang tergabung; periksa artikel sumbernya. Bila ya, turunkan dengan alasan “Campuran beberapa kejadian”.
          </p>
        ) : null}
      </header>

      <VerdictBar item={item} missing={perlu} figures={figures} open={open} openPoints={openPoints} />
      <FigureOptions figures={figures} />
      <OrgOptions orgs={orgs} />

      <Columns
        main={
          <>
            <Card
              id="poin"
              title="Poin kurasi"
              count={points.length ? `${openPoints} terbuka · ${points.length - openPoints} terjawab` : undefined}
              note="Penilaian pipeline yang belum yakin, dan keputusan otomatisnya yang kamu buka untuk dicek. Jawabanmu langsung mengubah isi dan relasi catatan ini, dan mengukur keyakinan untuk poin sejenis."
            >
              {unchecked ? <CheckOffer eventId={eventId} count={unchecked} /> : null}
              {points.length ? (
                <PointList
                  points={points}
                  figures={figures}
                  nearby={item.nearby}
                  liniChoices={liniChoices}
                  listId={FIGURE_LIST}
                  readHref={(a, p) => at({ baca: a, p })}
                  open={open}
                  liniPanel={isRecord ? "catatan" : "peristiwa"}
                />
              ) : (
                <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
                  Pipeline tidak punya pertanyaan untuk {isRecord ? "catatan" : "peristiwa"} ini.
                  {unchecked ? " Itu belum berarti benar: keputusan otomatisnya belum dicek." : ""}
                </p>
              )}
            </Card>

            <Card id="isi" title="Isi">
              <Isi item={item} read={read} open={open} scattered={scattered} />
            </Card>

            <Card
              id="kutipan"
              title="Kutipan"
              count={item.quotes.length}
              action={<Link href={open("kutipan")} scroll={false} style={{ ...button("quiet"), minHeight: 32, padding: "6px 12px", fontSize: 12.5, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>+ Tambah kutipan</Link>}
            >
              <QuotePreview item={item} actors={actors} figures={figures} open={open} />
            </Card>
          </>
        }
        side={
          <>
            {isRecord ? null : (
              <Card title="Gambar">
                <EventBanner eventId={item.event_id} image={image} />
              </Card>
            )}
            <Relasi item={item} actors={actors} open={open} />
          </>
        }
      />

      <p style={{ fontSize: 12, color: MUTED, margin: 0, lineHeight: 1.6, maxWidth: 640 }}>
        Keputusan di sini langsung tersimpan di <code>jejak.db</code> dan dipakai pipeline pada putaran
        berikutnya. Situs publik mengikutinya setelah push ke Neon.
      </p>

      {reading ? (
        <Drawer crumb={<>{what} #{item.event_id} › Artikel</>} title={reading.source} closeHref={at()} width={760}>
          <ArticleReader article={reading} terms={terms} closeHref={at()} focus={focus} bare />
        </Drawer>
      ) : panelRef ? (
        <PanelDrawer
          panel={panelRef}
          item={item}
          actors={actors}
          figures={figures}
          peek={peek}
          candidates={candidates}
          search={cari}
          open={open}
          read={read}
          scattered={scattered}
          closeHref={at()}
        />
      ) : null}
    </Page>
  );
}

/** The site's prev/next pills: small tracked capitals in an outline pill. */
const pillNav = { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", padding: "5px 12px" } as const;

/** How another event stands to this one, for ruling it from its panel. */
function relationTo(item: Item, otherId: number): Relation | null {
  const link = item.links.find((l) => l.event_id === otherId);
  if (link) {
    const pair = item.kind === "record"
      ? { record_id: item.event_id, peristiwa_id: otherId }
      : { record_id: otherId, peristiwa_id: item.event_id };
    return { kind: "link", pair, verdict: link.verdict };
  }
  const earlier = item.followups.earlier.find((f) => f.event_id === otherId);
  if (earlier) return { kind: "lini", pair: { earlier_id: otherId, later_id: item.event_id }, verdict: earlier.verdict };
  const later = item.followups.later.find((f) => f.event_id === otherId);
  if (later) return { kind: "lini", pair: { earlier_id: item.event_id, later_id: otherId }, verdict: later.verdict };
  return null;
}

/**
 * The names the reading pane marks: the record's own figure, the other
 * tracked figures this coverage names, and the new names waiting for a
 * verdict. Two-letter terms are skipped; they would mark half of every page.
 */
function readerTerms(item: Item, actors: Related[]): ReaderTerm[] {
  const out: ReaderTerm[] = [];
  const add = (texts: string[], kind: ReaderTerm["kind"], label: string) => {
    for (const text of new Set(texts.map((t) => t.trim()))) {
      if (text.length > 2) out.push({ text, kind, label });
    }
  };
  // Marked strongest is whoever is on the record's Terkait list, not the
  // figure it is filed under; that one is just another tracked name unless listed.
  const pelaku = new Set(actors.map((a) => a.id));
  const seen = new Set<string>();
  const figure = (id: string, name: string, aliases: string[]) => {
    seen.add(id);
    add([name, ...aliases], pelaku.has(id) ? "owner" : "figure", name);
  };
  if (item.owner) figure(item.owner.id, item.owner.name, item.owner.aliases);
  for (const p of item.named) {
    if (p.kind === "figure") figure(p.id, p.name, p.aliases);
    else if (!p.verdict) add([p.name], "candidate", p.name);
  }
  for (const a of actors) if (!seen.has(a.id)) add([a.name], "owner", a.name);
  return out;
}

/** One source article as the site lists it: outlet mark, headline, date; Baca opens it in the drawer. */
function SourceRow({ a, read, scattered, first }: { a: Item["sources"][number]; read: (article: string) => string; scattered: boolean; first?: boolean }) {
  return (
    <li style={{ borderTop: first ? "none" : "1px solid #e4dcc9" }}>
      <Link href={read(a.id)} scroll={false} className="source-row">
        <span style={{ flex: "none", display: "flex", paddingLeft: 5 }}><OutletTile source={a.source} /></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="source-row-title" style={{ display: "block", fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title ?? a.url}</span>
          {!a.has_body || (scattered && provincesIn(a.title).size > 0) ? (
            <span style={{ display: "block", fontSize: 11.5, color: MUTED }}>
              {a.has_body ? null : "hanya ringkasan"}
              {scattered && provincesIn(a.title).size > 0
                ? <span style={{ color: "var(--color-clay)" }}>{a.has_body ? "" : " · "}{[...provincesIn(a.title)].map(provinceLabel).join(", ")}</span>
                : null}
            </span>
          ) : null}
        </span>
        <span style={{ flex: "none", fontSize: 11.5, color: MUTED, whiteSpace: "nowrap" }}>{day(a.published_at)}</span>
      </Link>
    </li>
  );
}

/**
 * The summary, cut to a few lines, and the first sources. The whole summary
 * and every source are read in the drawer.
 */
function Isi({ item, read, open, scattered }: { item: Item; read: (article: string) => string; open: Open; scattered: boolean }) {
  const long = (item.summary ?? "").length > 360 || (item.summary ?? "").split("\n").length > 3;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {item.summary ? (
        <div>
          <div style={long ? { maxHeight: "7.6em", overflow: "hidden", WebkitMaskImage: "linear-gradient(#000 60%, transparent)", maskImage: "linear-gradient(#000 60%, transparent)" } : undefined}>
            <SummaryList summary={item.summary} sources={siteSources(item)} figureId={item.figure_id} />
          </div>
          {long ? <TextLink href={open("isi")} tone="muted">Baca ringkasan lengkap</TextLink> : null}
        </div>
      ) : (
        <p style={{ fontSize: 13.5, color: MUTED, margin: 0, fontStyle: "italic" }}>Belum dirangkum. Yang tayang adalah judul dari hasil klaster.</p>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {item.sources.slice(0, SOURCES_SHOWN).map((a, i) => <SourceRow key={`${a.url}-${i}`} a={a} read={read} scattered={scattered} first={i === 0} />)}
      </ul>
      {item.sources.length > SOURCES_SHOWN ? (
        <TextLink href={open("sumber")} tone="muted">Semua {item.sources.length} artikel →</TextLink>
      ) : null}
    </div>
  );
}

/** The sources in the shape the site's summary takes, for its [n] citations. */
function siteSources(item: Item) {
  return item.sources.map((a) => ({ source: a.source, url: a.url, title: a.title ?? "", published_at: a.published_at }));
}

/** Why a figure with no quote here is on the Terkait list. */
const RELATED_WHY: Record<string, string> = {
  owner: "dari judul berita",
  about: "dibicarakan di kutipan",
  derived: "pernyataannya dikutip ke catatan sendiri",
  curator: "ditambahkan kurator",
  point: "dikonfirmasi",
};

/** Named figures not on the Terkait list, most mentioned first; then new names. */
function mentions(item: Item, actors: Related[]): NamedPerson[] {
  const actorIds = new Set(actors.map((a) => a.id));
  return item.named
    .filter((p) => !(p.kind === "figure" && actorIds.has(p.id)) && !(p.kind === "candidate" && p.verdict))
    // Tracked figures first, then the names still waiting for a verdict.
    .sort((a, b) => Number(a.kind === "candidate") - Number(b.kind === "candidate") || b.articles - a.articles);
}

/**
 * Everything the record relates to, as a summary: the figures it concerns,
 * who else its coverage names, the peristiwa it belongs to and its lini cerita. Each heading's
 * action opens that data's own form in the drawer.
 */
function Relasi({ item, actors, open }: { item: Item; actors: Related[]; open: Open }) {
  const isRecord = item.kind === "record";
  const named = mentions(item, actors);
  const shown = named.slice(0, MENTIONS_SHOWN);
  const links = item.links.filter((l) => l.verdict !== "rejected");
  const lini = [...item.followups.earlier, ...item.followups.later]
    .filter((f) => f.verdict !== "rejected")
    .sort((a, b) => (a.event_date ?? "").localeCompare(b.event_date ?? ""));
  return (
    <Card as="aside" title="Relasi" note="Ringkasan saja. Mengubahnya membuka form milik datanya." flush>
      {isRecord ? (
        <Group label={`Terkait · ${actors.length}`} action={<TextLink href={open("terkait")}>+ Tambah</TextLink>}>
          {actors.length === 0 ? <div style={{ fontSize: 13, color: MUTED }}>Belum ada.</div> : null}
          {actors.map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <FigurePortrait figureId={a.id} name={a.name} width={36} round fontSize={12} hatchStep={4} />
              <Link href={open(`tokoh:${a.id}`)} scroll={false} style={{ flex: 1, minWidth: 0, color: INK, textDecoration: "none" }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{a.name}</span>
                <span style={{ display: "block", fontSize: 12, color: MUTED }}>
                  {[figureTitle(a), a.quotes ? `${a.quotes} kutipan` : RELATED_WHY[a.source] ?? null].filter(Boolean).join(" · ")}
                </span>
              </Link>
              <form action={setRecordRelated}>
                  <Hidden fields={{ event_id: item.event_id, figure_id: a.id, on: "0" }} />
                  <button type="submit" aria-label={`Hapus ${a.name} dari Terkait`} style={{ fontSize: 12, background: "none", border: "none", padding: "6px 0", cursor: "pointer", color: "var(--color-mud)", textDecoration: "underline", whiteSpace: "nowrap" }}>
                    hapus
                  </button>
                </form>
            </div>
          ))}
        </Group>
      ) : null}

      <Group
        label={`${isRecord ? "Nama di liputan" : "Tokoh terkait"} · ${named.length}`}
        action={named.length > shown.length ? <TextLink href={open("disebut")} tone="muted">semua</TextLink> : undefined}
      >
        {named.length === 0 ? <div style={{ fontSize: 13, color: MUTED }}>Tidak ada nama lain yang dikenali.</div> : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {shown.map((p) =>
              p.kind === "candidate" ? (
                <Chip key={`c-${p.id}`} href={open(`nama:${p.id}`)} tone="pending" title={`disebut di ${p.articles} artikel`}>{p.name} · nama baru</Chip>
              ) : (
                <Chip key={p.id} href={open(`tokoh:${p.id}`)} title={`disebut di ${p.articles} artikel`}>
                  <span style={p.struck ? { textDecoration: "line-through", color: MUTED } : undefined}>{p.name}</span>
                </Chip>
              )
            )}
            {named.length > shown.length ? <Chip href={open("disebut")} tone="outline">+{named.length - shown.length} lainnya</Chip> : null}
          </div>
        )}
      </Group>

      <Group
        label={isRecord ? "Bagian dari peristiwa" : `Catatan di dalamnya · ${links.length}`}
        action={<TextLink href={open("tautkan")}>{isRecord ? "Tautkan" : "Kelola"}</TextLink>}
      >
        {links.length === 0 ? <div style={{ fontSize: 13, color: MUTED }}>Belum ada.</div> : null}
        {links.slice(0, RELATIONS_SHOWN).map((l) => (
          <RelationRow
            key={l.event_id}
            title={l.title ?? `#${l.event_id}`}
            sub={[day(l.event_date), isRecord ? null : l.figure_name].filter(Boolean).join(" · ")}
            href={open(eventPanel(isRecord ? "peristiwa" : "record", l.event_id))}
            verdict={l.verdict}
            action={ruleLink}
            pair={isRecord ? { record_id: item.event_id, peristiwa_id: l.event_id } : { record_id: l.event_id, peristiwa_id: item.event_id }}
          />
        ))}
        {links.length > RELATIONS_SHOWN ? <TextLink href={open("tautkan")} tone="muted">dan {links.length - RELATIONS_SHOWN} lainnya</TextLink> : null}
      </Group>

      <Group label="Lini cerita" action={<TextLink href={open("lini")}>Sambungkan</TextLink>} last>
        {lini.length === 0 ? <div style={{ fontSize: 13, color: MUTED }}>Belum tersambung.</div> : null}
        {lini.slice(0, RELATIONS_SHOWN).map((f) => {
          const earlier = item.followups.earlier.includes(f);
          return (
            <RelationRow
              key={f.event_id}
              title={f.title ?? `#${f.event_id}`}
              sub={`${day(f.event_date)} · ${earlier ? "sebelum ini" : "sesudah ini"}`}
              href={open(eventPanel(item.kind, f.event_id))}
              verdict={f.verdict}
              action={ruleFollowup}
              pair={earlier ? { earlier_id: f.event_id, later_id: item.event_id } : { earlier_id: item.event_id, later_id: f.event_id }}
            />
          );
        })}
        {lini.length > RELATIONS_SHOWN ? <TextLink href={open("lini")} tone="muted">dan {lini.length - RELATIONS_SHOWN} lainnya</TextLink> : null}
      </Group>
    </Card>
  );
}

/** A linked event in Relasi: confirmed with ✓, or a proposal to rule on right there. */
function RelationRow({ title, sub, href, verdict, action, pair }: {
  title: string;
  sub: string;
  href: string;
  verdict: "confirmed" | "rejected" | null;
  action: (formData: FormData) => Promise<void>;
  pair: Record<string, number>;
}) {
  const small = { ...button("accept"), minHeight: 30, padding: "4px 10px", fontSize: 12 };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <Link href={href} scroll={false} style={{ color: INK, textDecorationColor: "#b9ad94" }}>{title}</Link>
        {verdict === "confirmed" ? <span style={{ color: ACCEPT, fontWeight: 700 }}> ✓</span> : null}
        <span style={{ display: "block", fontSize: 12, color: verdict ? MUTED : "#7a5a12" }}>{sub}{verdict ? "" : " · usulan pipeline"}</span>
      </span>
      {verdict === null ? (
        <span style={{ display: "flex", gap: 6 }}>
          <form action={action}>
            <Hidden fields={{ ...pair, verdict: "confirmed" }} />
            <button type="submit" style={small}>Ya</button>
          </form>
          <form action={action}>
            <Hidden fields={{ ...pair, verdict: "rejected" }} />
            <button type="submit" style={{ ...small, ...button("quiet"), minHeight: 30, padding: "4px 10px", fontSize: 12 }}>Bukan</button>
          </form>
        </span>
      ) : null}
    </div>
  );
}

/** The drawer's content for each ?panel=. */
function PanelDrawer({ panel, item, actors, figures, peek, candidates, search, open, read, scattered, closeHref }: {
  panel: PanelRef;
  read: (article: string) => string;
  scattered: boolean;
  item: Item;
  actors: Related[];
  figures: FigureOption[];
  peek: EventPeek | FigurePeek | null;
  candidates: FollowupCandidate[];
  search: string;
  open: Open;
  closeHref: string;
}) {
  const isRecord = item.kind === "record";
  const here = `${isRecord ? "Catatan" : "Peristiwa"} #${item.event_id}`;
  const missing = (
    <Drawer crumb={here} title="Tidak ditemukan" closeHref={closeHref}>
      <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Mungkin sudah digabung, diputuskan, atau dihapus.</p>
    </Drawer>
  );

  switch (panel.kind) {
    case "catatan":
    case "peristiwa": {
      const e = peek as EventPeek | null;
      if (!e) return missing;
      return (
        <Drawer crumb={<>{here} › {e.kind === "record" ? "Catatan" : "Peristiwa"} #{e.event_id}</>} title={e.title ?? "(tanpa judul)"} closeHref={closeHref}>
          <EventPanel peek={e} open={open} here={item.event_id} relation={relationTo(item, e.event_id)} />
        </Drawer>
      );
    }
    case "tokoh": {
      const f = peek as FigurePeek | null;
      if (!f) return missing;
      return (
        <Drawer crumb={<>{here} › Tokoh</>} title={f.name} closeHref={closeHref} width={640}
          aside={<Link href={`/kurasi/tokoh/${f.id}`} style={{ fontSize: 12.5, color: "var(--color-mud)", whiteSpace: "nowrap" }}>Buka halaman tokoh</Link>}>
          <FigureDrawer item={item} actors={actors} figures={figures} peek={f} open={open} />
        </Drawer>
      );
    }
    case "nama": {
      const p = item.named.find((x) => x.kind === "candidate" && x.id === panel.id);
      if (!p) return missing;
      return (
        <Drawer crumb={<>{here} › Nama baru</>} title={p.name} closeHref={closeHref}>
          <p style={{ fontSize: 13.5, color: "var(--color-mud)", margin: 0, lineHeight: 1.55 }}>
            Ditemukan pipeline di {p.articles} artikel {isRecord ? "catatan" : "peristiwa"} ini. Jadikan tokoh, samakan dengan tokoh yang ada, atau tolak.
          </p>
          <CandidateRow person={p} figures={figures} open={open} />
          {p.verdict ? null : (
            <form action={decide}>
              <Hidden fields={{ slug: p.id, verdict: "reject" }} />
              <button type="submit" style={{ ...button("quiet"), color: "var(--color-clay)" }}>Tolak, bukan tokoh</button>
            </form>
          )}
        </Drawer>
      );
    }
    case "terkait":
      return (
        <Drawer crumb={<>{here} › Terkait</>} title="Tambah tokoh terkait" closeHref={closeHref}>
          <AddRelated item={item} actors={actors} figures={figures} />
        </Drawer>
      );
    case "disebut": {
      const named = mentions(item, actors);
      return (
        <Drawer crumb={<>{here} › {isRecord ? "Nama di liputan" : "Tokoh terkait"}</>} title={`${named.length} nama di liputan ini`} closeHref={closeHref}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {named.map((p, i) => (
              <li key={`${p.kind}-${p.id}`} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "9px 0", borderTop: i ? `1px solid ${RULE}` : "none" }}>
                <Link href={open(`${p.kind === "candidate" ? "nama" : "tokoh"}:${p.id}`)} scroll={false} style={{ flex: 1, minWidth: 0, color: INK, textDecoration: "none" }}>
                  <span style={{ fontSize: 14, fontWeight: 600, ...(p.struck ? { textDecoration: "line-through", color: MUTED } : {}) }}>{p.name}</span>
                  {figureTitle(p) ? <span style={{ fontSize: 12, color: MUTED }}> – {figureTitle(p)}</span> : null}
                </Link>
                {p.kind === "candidate" ? <Pill tone="pending">nama baru</Pill> : null}
                <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap" }}>{p.articles} artikel</span>
              </li>
            ))}
          </ul>
        </Drawer>
      );
    }
    case "tautkan":
      return (
        <Drawer crumb={<>{here} › {isRecord ? "Bagian dari peristiwa" : "Catatan di dalamnya"}</>} title={isRecord ? "Peristiwa catatan ini" : "Catatan di peristiwa ini"} closeHref={closeHref} width={640}>
          <p style={{ fontSize: 12.5, color: MUTED, margin: 0, lineHeight: 1.5 }}>
            {isRecord
              ? "Pipeline mengusulkan berdasar kata khas yang sama; hanya yang kamu konfirmasi yang tampil di situs."
              : "Catatan tokoh yang diusulkan atau dikonfirmasi sebagai bagian dari peristiwa ini."}
          </p>
          <LinkList item={item} open={open} />
          {isRecord ? <AddLink item={item} /> : null}
        </Drawer>
      );
    case "isi":
      return (
        <Drawer crumb={<>{here} › Isi</>} title={item.title ?? "Ringkasan"} closeHref={closeHref} width={640}>
          {item.summary ? (
            <SummaryList summary={item.summary} sources={siteSources(item)} figureId={item.figure_id} />
          ) : (
            <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Belum dirangkum.</p>
          )}
        </Drawer>
      );
    case "sumber":
      return (
        <Drawer crumb={<>{here} › Artikel sumber</>} title={`${item.sources.length} artikel`} closeHref={closeHref} width={640}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {item.sources.map((a, i) => <SourceRow key={`${a.url}-${i}`} a={a} read={read} scattered={scattered} first={i === 0} />)}
          </ul>
        </Drawer>
      );
    case "kutipan":
      return (
        <Drawer crumb={<>{here} › Kutipan</>} title={`${item.quotes.length} kutipan`} closeHref={closeHref} width={680}>
          <p style={{ fontSize: 12.5, color: MUTED, margin: 0, lineHeight: 1.5 }}>
            {isRecord
              ? "Kalimat langsung di artikelnya, dengan pembicara seperti yang ditulis media, dan tokoh yang dibicarakannya. Betulkan bila salah, dan pilih kutipan yang tampil di situs."
              : "Kalimat langsung di artikelnya, dengan pembicara seperti yang ditulis media. Betulkan tokohnya bila salah."}
          </p>
          <AddQuote item={item} figures={figures} />
          <QuoteList item={item} actors={actors} figures={figures} open={open} />
        </Drawer>
      );
    case "saran":
      return (
        <Drawer crumb={<>{here} › Saran</>} title="Saran turunkan" closeHref={closeHref}>
          <SuggestionDrawer item={item} open={open} />
        </Drawer>
      );
    case "lini":
      return (
        <Drawer crumb={<>{here} › Lini cerita</>} title="Lini cerita" closeHref={closeHref} width={640}>
          <p style={{ fontSize: 12.5, color: MUTED, margin: 0, lineHeight: 1.5 }}>
            {isRecord
              ? "Catatan tokoh yang sama sebelum dan sesudah ini, bila ini kelanjutannya: diumumkan lalu direvisi, dijanjikan lalu ditepati. Hanya yang kamu konfirmasi yang tampil di situs."
              : "Peristiwa sebelum dan sesudah ini, bila ini kelanjutannya. Hanya yang kamu konfirmasi yang tampil di situs."}
          </p>
          <FollowupList item={item} open={open} />
          <AddFollowup item={item} candidates={candidates} search={search} open={open} />
        </Drawer>
      );
  }
}

/**
 * A figure seen from this record: whether it is on the Terkait list (or struck
 * from a peristiwa), its own form when the coverage names it, and where else
 * it appears.
 */
function FigureDrawer({ item, actors, figures, peek: f, open }: { item: Item; actors: Related[]; figures: FigureOption[]; peek: FigurePeek; open: Open }) {
  const isRecord = item.kind === "record";
  const person = item.named.find((p) => p.kind === "figure" && p.id === f.id);
  const isActor = actors.some((a) => a.id === f.id);
  return (
    <>
      {isRecord ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", borderRadius: 6, background: "var(--color-cream)", border: `1px solid ${RULE}` }}>
          <span style={{ flex: "1 1 220px", fontSize: 13, color: "var(--color-mud)" }}>
            Di catatan ini: <strong style={{ color: INK }}>{isActor ? "terkait" : person ? "disebut di liputan, belum terkait" : "tidak disebut"}</strong>
          </span>
          <form action={setRecordRelated}>
            <Hidden fields={{ event_id: item.event_id, figure_id: f.id, on: isActor ? "0" : "1" }} />
            <button type="submit" style={button(isActor ? "quiet" : "ink")}>{isActor ? "Hapus dari Terkait" : "Tambahkan ke Terkait"}</button>
          </form>
        </div>
      ) : person ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", borderRadius: 6, background: "var(--color-cream)", border: `1px solid ${RULE}` }}>
          <span style={{ flex: "1 1 220px", fontSize: 13, color: "var(--color-mud)" }}>
            {person.struck ? "Dicoret dari peristiwa ini." : "Terkait dengan peristiwa ini. Coret bila salah cocok, misalnya karena alias yang juga nama orang lain."}
          </span>
          <form action={relateFigure}>
            <Hidden fields={{ event_id: item.event_id, figure_id: f.id, struck: person.struck ? "0" : "1" }} />
            <button type="submit" style={button("quiet")}>{person.struck ? "Pulihkan" : "Coret dari peristiwa"}</button>
          </form>
        </div>
      ) : null}

      {person && person.active !== false ? (
        <>
          <div style={groupLabel}>Identitas &amp; jabatan</div>
          <FigureForm figure={person} eventId={item.event_id} />
          <NotAPersonForm figureId={person.id} eventId={item.event_id} />
          <SamePerson person={person} eventId={item.event_id} figures={figures} open={open} />
        </>
      ) : (
        <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>
          Ubah identitas dan jabatannya di <Link href={`/kurasi/tokoh/${f.id}`} style={{ color: INK }}>halaman tokoh</Link>.
        </p>
      )}

      <div style={{ ...groupLabel, marginTop: 6, paddingTop: 14, borderTop: `1px solid ${RULE}` }}>Di seluruh kurasi</div>
      <FigurePanel peek={f} open={open} here={item.event_id} />
    </>
  );
}

/**
 * "+ Tambah" on Terkait: who in this coverage is not listed yet, the quoted
 * first, then anyone on the roster.
 */
function AddRelated({ item, actors, figures }: { item: Item; actors: Related[]; figures: FigureOption[] }) {
  const actorIds = new Set(actors.map((a) => a.id));
  const quoted = new Map<string, number>();
  for (const q of item.quotes) if (q.figure_id) quoted.set(q.figure_id, (quoted.get(q.figure_id) ?? 0) + 1);
  const fromCoverage = item.named
    .filter((p) => p.kind === "figure" && !actorIds.has(p.id) && p.active !== false)
    .sort((a, b) => (quoted.get(b.id) ?? 0) - (quoted.get(a.id) ?? 0) || b.articles - a.articles)
    .slice(0, 24);
  const chip = { fontSize: 12.5, padding: "6px 11px", borderRadius: 99, background: "var(--color-cream)", border: `1px solid ${INK}`, cursor: "pointer", color: INK } as const;
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-mud)", lineHeight: 1.55, margin: 0 }}>
        Terkait adalah tokoh yang dibahas catatan ini: yang berbicara, yang dibicarakan, atau yang melakukannya.
        Satu daftar saja; tidak ada yang utama. Siapa mengatakan apa, tentang siapa, ada di kutipannya.
      </p>
      {fromCoverage.length ? (
        <>
          <div style={groupLabel}>Dari liputan ini</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {fromCoverage.map((p) => (
              <form key={p.id} action={setRecordRelated}>
                <Hidden fields={{ event_id: item.event_id, figure_id: p.id, on: "1" }} />
                <button type="submit" style={chip} title={`disebut di ${p.articles} artikel${quoted.get(p.id) ? `, ${quoted.get(p.id)} kutipan` : ""}`}>
                  + {p.name}
                  {quoted.get(p.id) ? <span style={{ color: MUTED }}> · {quoted.get(p.id)} kutipan</span> : null}
                </button>
              </form>
            ))}
          </div>
        </>
      ) : null}
      <div style={groupLabel}>Tokoh lain</div>
      <form action={setRecordRelated} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        <Hidden fields={{ event_id: item.event_id, on: "1" }} />
        <FigurePicker listId={FIGURE_LIST} required />
        <button type="submit" style={button("ink")}>Tambahkan</button>
      </form>
      <p style={{ fontSize: 12, color: MUTED, margin: 0 }}>{figures.length} tokoh aktif. Ketik nama, alias, atau jabatan.</p>
    </>
  );
}

/**
 * The decision, kept in view while the sections below are read: sticky, so
 * "Tayang" or "Turunkan" is one click away from wherever the evidence is.
 *
 * "Turunkan" opens a reason picker rather than acting at once: the reasons
 * are what the pipeline's suggester learns from (jejak/curation_suggest.py),
 * and its guess, when it has one, is ticked already.
 */
function VerdictBar({
  item,
  missing,
  figures,
  open,
  openPoints,
}: {
  item: Item;
  missing?: string;
  figures: FigureOption[];
  open: Open;
  openPoints: number;
}) {
  const next = item.next_id ?? "";
  const s = item.suggestion;
  const autoHidden = !item.curated && s?.auto_hide;
  const [tone, status]: [PillTone, string] =
    item.curated === "rejected" ? ["danger", "diturunkan"] :
    item.curated === "kept" ? ["accept", "sudah diperiksa · tayang"] :
    autoHidden ? ["pending", "disembunyikan otomatis"] :
    ["pending", "tayang · belum diperiksa"];
  const suggested = !item.curated && s?.reason ? s.reason : "";
  const ticked = new Set<string>(item.curated === "rejected" ? item.ruling?.reasons ?? [] : suggested ? [suggested] : []);
  return (
    <div
      id="keputusan"
      style={{
        position: "sticky", top: "var(--strip-h)", zIndex: 15, background: "var(--color-callout)", border: `1px solid ${RULE}`,
        borderLeft: "3px solid var(--color-clay)", padding: "10px 14px", margin: "-8px 0 0",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={groupLabel}>Keputusan</span>
        <Pill tone={tone}>{status}</Pill>
        {item.curated ? (
          <form action={curate}>
            <Hidden fields={{ event_id: item.event_id, verdict: "" }} />
            <button type="submit" style={{ fontSize: 12.5, background: "none", border: "none", color: MUTED, textDecoration: "underline", cursor: "pointer", padding: 0 }}>
              {item.curated === "rejected" ? "Tayangkan lagi" : "Batalkan"}
            </button>
          </form>
        ) : null}
        {openPoints ? (
          <a href="#poin" style={{ fontSize: 12.5, fontWeight: 600, color: "#7a5a12", textDecoration: "none" }}>{openPoints} poin kurasi belum dijawab</a>
        ) : null}
        <span style={{ flex: "1 1 auto" }} />
        <ReworkMenu item={item} figures={figures} />
        <details open={Boolean(missing)} style={{ position: "static" }}>
          <summary style={{ ...button(item.curated === "rejected" ? "quiet" : "danger"), listStyle: "none", display: "inline-flex", alignItems: "center" }}>
            {item.curated === "rejected" ? "Ubah alasan…" : "Turunkan…"}
          </summary>
          <form
            action={curate}
            style={{
              position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 6,
              background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 2, padding: "14px 16px",
              boxShadow: "0 8px 24px rgba(22, 19, 15, 0.14)", display: "grid", gap: 10,
            }}
          >
            <Hidden fields={{ event_id: item.event_id, verdict: "rejected", next: item.curated === "rejected" ? "" : next, suggested }} />
            <div style={{ fontSize: 12.5, color: INK, fontWeight: 600 }}>
              Kenapa diturunkan? <span style={{ color: MUTED, fontWeight: 400 }}>Pilih satu atau lebih.</span>
            </div>
            {missing === "alasan" ? <Warn>Pilih setidaknya satu alasan.</Warn> : null}
            {missing === "catatan" ? <Warn>Alasan “Lainnya” perlu catatan.</Warn> : null}
            <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
              {REASONS.map((r) => (
                <label key={r.code} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: INK, cursor: "pointer" }}>
                  <input type="checkbox" name="reason" value={r.code} defaultChecked={ticked.has(r.code)} style={{ marginTop: 3 }} />
                  <span>
                    {r.label}
                    {r.code === suggested ? <span style={{ color: "#7a5a12", fontSize: 11.5, fontWeight: 700 }}> · saran</span> : null}
                    <span style={{ display: "block", fontSize: 11.5, color: MUTED }}>{r.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <label style={label}>
              Catatan (opsional, wajib untuk “Lainnya”)
              <textarea name="note" rows={2} maxLength={1000} defaultValue={item.ruling?.note ?? ""} style={{ ...input, resize: "vertical" }} />
            </label>
            <div>
              <button type="submit" style={button("danger")}>
                {item.curated === "rejected" ? "Simpan alasan" : "Turunkan, lanjut →"}
              </button>
            </div>
          </form>
        </details>
        {item.curated !== "kept" ? (
          <form action={curate}>
            <Hidden fields={{ event_id: item.event_id, verdict: "kept", next, suggested }} />
            <button type="submit" style={button("accept")}>
              {autoHidden || item.curated === "rejected" ? "Tayangkan, lanjut →" : "Selesai diperiksa, lanjut →"}
            </button>
          </form>
        ) : null}
      </div>
      {item.curated === "rejected" && item.ruling ? (
        <div style={{ fontSize: 12.5, color: "var(--color-mud)", marginTop: 8 }}>
          <strong style={{ color: INK }}>Alasan:</strong>{" "}
          {item.ruling.reasons.map(reasonLabel).join(", ") || "—"}
          {item.ruling.note ? <> · <em>{item.ruling.note}</em></> : null}
        </div>
      ) : null}
      {!item.curated && s ? <SuggestionLine item={item} open={open} /> : null}
      <CvNote item={item} figures={figures} />
    </div>
  );
}

/**
 * "Kerjakan ulang…", beside "Turunkan…": the other answer to a bad entry —
 * the coverage belongs on the site, but the title or summary got it wrong.
 * Opens by itself while a draft is being written or waits for a decision.
 */
function ReworkMenu({ item, figures }: { item: Item; figures: FigureOption[] }) {
  const running = item.reworks.some((r) => r.status === "queued" || r.status === "running");
  const ready = item.reworks.some((r) => r.status === "ready" || r.status === "failed");
  return (
    <details id="ulang" open={running || ready} style={{ position: "static" }}>
      <summary style={{ ...button(ready ? "ink" : "quiet"), listStyle: "none", display: "inline-block" }}>
        {running ? "Sedang dikerjakan ulang…" : ready ? "Tinjau draf ulang…" : "Kerjakan ulang…"}
      </summary>
      <div
        style={{
          position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 6,
          background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 2, padding: "14px 16px",
          boxShadow: "0 8px 24px rgba(22, 19, 15, 0.14)", maxHeight: "70vh", overflowY: "auto",
        }}
      >
        <div style={{ fontSize: 12.5, color: INK, fontWeight: 600, marginBottom: 8 }}>
          Layak tayang, tapi judul atau ringkasannya keliru?{" "}
          <span style={{ color: MUTED, fontWeight: 400 }}>
            Tulis apa yang salah; sistem menulis ulang dari artikel yang sama. Hasilnya draf, tidak ada yang berubah sampai kamu menerimanya.
          </span>
        </div>
        <ReworkPanel item={item} figures={figures} />
      </div>
    </details>
  );
}

/**
 * What the pipeline put on a CV from this record (jejak/kurasi.py auto_cv):
 * appointments, profiles and the like are found, drafted and applied with no
 * curator step, and the record comes down as "Bahan CV". Shown so a wrong one
 * can be undone by hand: "Tayangkan lagi" restores the record, and the CV is
 * edited under "Terkait" or on the figure's own record.
 */
function CvNote({ item, figures }: { item: Item; figures: FigureOption[] }) {
  const p = item.cvProposals.find((r) => r.status === "accepted");
  if (!p?.proposal) return null;
  const who = figures.find((f) => f.id === p.figure_id)?.name ?? p.figure_id;
  const d = p.proposal;
  const entries = [
    ...d.positions.map((x) => positionLine(x) + (x.period ? ` (${x.period})` : "")),
    ...d.facts.map((x) => `${x.label}: ${x.value}`),
    ...d.education.map((x) => (x.year ? `${x.year}: ` : "") + x.detail),
  ];
  return (
    <div style={{ fontSize: 12.5, color: "var(--color-mud)", marginTop: 8 }}>
      <strong style={{ color: INK }}>
        {p.origin === "auto" ? "Masuk CV otomatis" : "Masuk CV"} {who}:
      </strong>{" "}
      {entries.join(" · ") || "—"}
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: "var(--color-clay)", fontWeight: 600 }}>{children}</div>;
}

/** "Saran: Remeh / seremonial · 85% · mirip 12 …", one line; the examples open in the drawer. */
function SuggestionLine({ item, open }: { item: Item; open: Open }) {
  const s = item.suggestion!;
  return (
    <div style={{ fontSize: 12.5, color: "#7a5a12", marginTop: 8 }}>
      <strong>{s.auto_hide ? "Disembunyikan otomatis:" : "Saran:"}</strong>{" "}
      {s.reason ? reasonLabel(s.reason) : "turunkan"}
      {s.confidence !== null ? ` · ${Math.round(s.confidence * 100)}%` : ""}
      {s.support > 0 ? ` · mirip ${s.support} yang pernah kamu turunkan` : ""}
      {item.examples.length > 0 ? <> · <TextLink href={open("saran")} tone="muted" size={12}>lihat contohnya</TextLink></> : null}
    </div>
  );
}

/** The takedown suggestion in full: why, and the past rulings it resembles. */
function SuggestionDrawer({ item, open }: { item: Item; open: Open }) {
  const s = item.suggestion;
  if (!s) return <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Tidak ada saran untuk {item.kind === "record" ? "catatan" : "peristiwa"} ini.</p>;
  return (
    <>
      <p style={{ fontSize: 13.5, color: "var(--color-mud)", margin: 0, lineHeight: 1.55 }}>
        {s.auto_hide ? "Disembunyikan otomatis" : "Pipeline menyarankan turunkan"} dengan alasan <strong style={{ color: INK }}>{s.reason ? reasonLabel(s.reason) : "—"}</strong>
        {s.confidence !== null ? `, yakin ${Math.round(s.confidence * 100)}%` : ""}
        {s.support > 0 ? `, karena mirip ${s.support} yang pernah kamu turunkan dengan alasan ini` : ""}.
        {s.auto_hide ? " Tayangkan bila keliru; keputusanmu selalu menang." : " Saran ini tidak mengubah apa pun sampai kamu memutuskan."}
      </p>
      {item.examples.length > 0 ? (
        <div>
          <div style={{ ...groupLabel, paddingBottom: 6 }}>Contoh yang mirip</div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {item.examples.map((x, i) => (
              <li key={x.event_id} style={{ padding: "9px 0", borderTop: i ? `1px solid ${RULE}` : "none" }}>
                <Link href={open(eventPanel(item.kind, x.event_id))} scroll={false} style={{ fontSize: 13.5, color: INK }}>{x.title ?? `#${x.event_id}`}</Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

const FRAMING_LABEL: Record<string, string> = {
  own: "perbuatan tokoh sendiri",
  about: "liputan tentang tokoh (bukan pelaku)",
};

function snapshotLine(s: ReworkSnapshot, figures: FigureOption[]): string {
  const who = s.figure_id ? figures.find((f) => f.id === s.figure_id)?.name ?? s.figure_id : null;
  return [
    s.kind === "peristiwa" ? "Peristiwa" : `Catatan ${who ?? ""}`.trim(),
    s.kind === "record" ? FRAMING_LABEL[s.framing === "about" ? "about" : "own"] : null,
    s.event_type,
  ].filter(Boolean).join(" · ");
}

/**
 * Rework requests: a note and/or a change, drafted by the local model in the
 * background, then shown beside the current entry to accept or throw away.
 * The page does not refresh itself (no client script); "Muat ulang" does.
 */
function ReworkPanel({ item, figures }: { item: Item; figures: FigureOption[] }) {
  const isRecord = item.kind === "record";
  const busy = item.reworks.some((r) => r.status === "queued" || r.status === "running");
  return (
    <>
      {item.reworks.map((r) => (
        <ReworkItem key={r.id} rework={r} item={item} figures={figures} />
      ))}
      {busy ? null : (
        <form action={rework} style={{ display: "grid", gap: 12, marginTop: item.reworks.length ? 16 : 0 }}>
          <Hidden fields={{ event_id: item.event_id }} />
          <label style={label}>
            Apa yang salah? Tulis seperti memberi catatan ke penulis.
            <textarea
              name="note"
              rows={3}
              placeholder={isRecord
                ? "mis. Nusron tidak menolak apa pun. KPK menyita mobil dari Arif Sugiyanto, orang kepercayaannya."
                : "mis. Judulnya menyebut Jakarta, padahal kebakarannya di Tangerang."}
              style={{ ...input, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
            />
          </label>
          {isRecord ? (
            <>
              <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                <legend style={{ ...label, padding: 0, marginBottom: 4 }}>Sudut pandang</legend>
                {[
                  ["", "Biarkan"],
                  ["own", "Perbuatan atau ucapan tokoh sendiri"],
                  ["about", "Liputan tentang tokoh, tapi bukan dia pelakunya"],
                ].map(([value, text]) => (
                  <label key={value} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5 }}>
                    <input type="radio" name="framing" value={value} defaultChecked={value === ""} />
                    {text}
                    {(value === "about" && item.framing === "about") || (value === "own" && item.framing !== "about")
                      ? <span style={{ fontSize: 11.5, color: MUTED }}>(sekarang)</span> : null}
                  </label>
                ))}
              </fieldset>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ ...label, flex: "1 1 260px" }}>
                  Pindahkan ke tokoh lain (kosongkan bila tidak)
                  <input
                    name="new_figure_id"
                    list={FIGURE_LIST}
                    autoComplete="off"
                    placeholder="ketik nama untuk mencari"
                    pattern={figures.filter((f) => f.id !== item.figure_id).map((f) => f.id).join("|")}
                    title="Pilih tokoh dari daftar saran"
                    style={input}
                  />
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5, paddingBottom: 8 }}>
                  <input type="checkbox" name="to_peristiwa" value="1" />
                  Jadikan peristiwa (bukan milik satu tokoh)
                </label>
              </div>
            </>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" style={button("ink")}>Kerjakan ulang</button>
          </div>
        </form>
      )}
    </>
  );
}

function ReworkItem({ rework: r, item, figures }: { rework: Rework; item: Item; figures: FigureOption[] }) {
  const asked = [
    r.note ? `“${r.note}”` : null,
    r.framing ? `sudut pandang: ${FRAMING_LABEL[r.framing]}` : null,
    r.new_figure_id ? `pindah ke ${figures.find((f) => f.id === r.new_figure_id)?.name ?? r.new_figure_id}` : null,
    r.to_peristiwa ? "jadikan peristiwa" : null,
  ].filter(Boolean).join(" · ");
  const [tone, text]: [PillTone, string] =
    r.status === "ready" ? ["pending", "draf siap, tinjau"] :
    r.status === "accepted" ? ["accept", "diterima"] :
    r.status === "discarded" ? ["neutral", "dibuang"] :
    r.status === "failed" ? ["danger", "gagal"] : ["pending", "sedang dikerjakan"];
  const open = r.status === "ready" || r.status === "queued" || r.status === "running" || r.status === "failed";
  return (
    <details open={open} style={{ borderBottom: `1px solid ${RULE}`, padding: "10px 0" }}>
      <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={tone}>{text}</Pill>
        <span style={{ fontSize: 13, color: "var(--color-mud)" }}>{asked}</span>
        <span style={{ fontSize: 11.5, color: MUTED }}>{day(r.created_at)}</span>
      </summary>
      {r.status === "queued" || r.status === "running" ? (
        <p style={{ fontSize: 13, color: MUTED, margin: "8px 0 0" }}>
          Model lokal sedang menulis, biasanya kurang dari semenit.{" "}
          <Link href={`/kurasi/${item.event_id}#ulang`} style={{ color: INK }}>Muat ulang</Link>
        </p>
      ) : null}
      {r.status === "failed" ? (
        <p style={{ fontSize: 13, color: "var(--color-clay)", margin: "8px 0 0" }}>
          {r.error}
          {r.error?.includes("Ollama") ? " Jalankan Ollama (ollama serve), lalu minta lagi." : ""}
        </p>
      ) : null}
      {r.before && r.after ? (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", marginTop: 10 }}>
          {([["Sekarang", r.before], [r.status === "accepted" ? "Diterima" : "Draf baru", r.after]] as const).map(([heading, snap]) => (
            <div key={heading} style={{ background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MUTED }}>{heading}</div>
              <div style={{ fontSize: 11.5, color: MUTED, margin: "4px 0" }}>{snapshotLine(snap, figures)}</div>
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 16.5, fontWeight: 600, lineHeight: 1.3 }}>{snap.title}</div>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--color-mud)", margin: "6px 0 0", whiteSpace: "pre-line" }}>{snap.summary_text}</p>
            </div>
          ))}
        </div>
      ) : null}
      {r.status === "ready" || r.status === "failed" ? (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <form action={decideRework}>
            <Hidden fields={{ event_id: item.event_id, request_id: r.id, decision: "discard" }} />
            <button type="submit" style={button("quiet")}>Buang</button>
          </form>
          {r.status === "ready" ? (
            <form action={decideRework}>
              <Hidden fields={{ event_id: item.event_id, request_id: r.id, decision: "accept" }} />
              <button type="submit" style={button("accept")}>Terima draf ini</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function LinkList({ item, open }: { item: Item; open: Open }) {
  if (item.links.length === 0) {
    return (
      <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>
        {item.kind === "record" ? "Pipeline belum mengusulkan peristiwa untuk catatan ini." : "Belum ada catatan tokoh yang ditautkan."}
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {item.links.map((l, i) => (
        <LinkItem key={l.event_id} link={l} item={item} first={i === 0} open={open} />
      ))}
    </ul>
  );
}

function LinkItem({ link: l, item, first, open }: { link: LinkRow; item: Item; first: boolean; open: Open }) {
  const pair = item.kind === "record"
    ? { record_id: item.event_id, peristiwa_id: l.event_id }
    : { record_id: l.event_id, peristiwa_id: item.event_id };
  const [tone, text]: [PillTone, string] =
    l.verdict === "confirmed" ? ["accept", "Dikonfirmasi · tampil di situs"] :
    l.verdict === "rejected" ? ["danger", "Ditolak"] :
    l.proposed ? ["pending", "Usulan pipeline"] : ["neutral", "Ditambahkan"];
  return (
    <li style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", padding: "14px 0", borderTop: first ? "none" : `1px solid ${RULE}`, opacity: l.verdict === "rejected" ? 0.6 : 1 }}>
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <Pill tone={tone}>{text}</Pill>
          <span style={{ fontSize: 11.5, color: MUTED }}>
            {day(l.event_date)}
            {l.figure_name ? ` · ${l.figure_name}` : ""}
            {l.score !== null ? ` · skor ${l.score.toFixed(2)}` : ""}
          </span>
        </div>
        <Link href={open(eventPanel(item.kind === "record" ? "peristiwa" : "record", l.event_id))} scroll={false} style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: INK, lineHeight: 1.4 }}>
          {l.title ?? `#${l.event_id}`}
        </Link>
        {l.evidence.length > 0 ? (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
            kata yang sama: {l.evidence.join(", ")}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {l.verdict !== "confirmed" ? (
          <form action={ruleLink}>
            <Hidden fields={{ ...pair, verdict: "confirmed" }} />
            <button type="submit" style={button("accept")}>Benar</button>
          </form>
        ) : null}
        {l.verdict !== "rejected" ? (
          <form action={ruleLink}>
            <Hidden fields={{ ...pair, verdict: "rejected" }} />
            <button type="submit" style={button("quiet")}>Bukan</button>
          </form>
        ) : null}
        {l.verdict ? (
          <form action={ruleLink}>
            <Hidden fields={{ ...pair, verdict: "" }} />
            <button type="submit" style={button("quiet")}>Batalkan</button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

/** A link the pipeline did not propose: any peristiwa within a week. */
function AddLink({ item }: { item: Item }) {
  if (item.nearby.length === 0) return null;
  return (
    <SubPanel title="Tautkan sendiri" note="Peristiwa dalam ±7 hari dari catatan ini.">
      <form action={ruleLink} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Hidden fields={{ record_id: item.event_id, verdict: "confirmed" }} />
        <select name="peristiwa_id" required defaultValue="" style={{ ...input, flex: "1 1 420px" }} aria-label="Peristiwa">
          <option value="" disabled>Pilih peristiwa…</option>
          {item.nearby.map((p) => (
            <option key={p.event_id} value={p.event_id}>
              {day(p.event_date)} · {p.title ?? `#${p.event_id}`}
            </option>
          ))}
        </select>
        <button type="submit" style={button("ink")}>Tautkan</button>
      </form>
    </SubPanel>
  );
}

/**
 * One list in date order, this event marked where it falls: the dates already
 * say which came first, so there are no "before"/"after" headings. Each row
 * still carries its pair the right way round for the verdict.
 */
function FollowupList({ item, open }: { item: Item; open: Open }) {
  const { earlier, later } = item.followups;
  if (earlier.length + later.length === 0) {
    return <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Pipeline belum mengusulkan kelanjutan untuk ini.</p>;
  }
  const byDate = (x: FollowupRow, y: FollowupRow) => (x.event_date ?? "").localeCompare(y.event_date ?? "") || x.event_id - y.event_id;
  const self: FollowupRow = { event_id: item.event_id, title: null, event_date: item.event_date, score: null, evidence: [], verdict: null, proposed: false };
  const rows = [
    ...earlier.map((f) => ({ f, pair: { earlier_id: f.event_id, later_id: item.event_id } })),
    { f: self, pair: null },
    ...later.map((f) => ({ f, pair: { earlier_id: item.event_id, later_id: f.event_id } })),
  ].sort((x, y) => byDate(x.f, y.f));
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((r, i) =>
        r.pair ? (
          <FollowupItem key={r.f.event_id} row={r.f} pair={r.pair} first={i === 0} href={open(eventPanel(item.kind, r.f.event_id))} />
        ) : (
          <li key="ini" style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "10px 0", borderTop: i === 0 ? "none" : `1px solid ${RULE}` }}>
            <span style={{ fontSize: 11.5, color: MUTED, minWidth: 70 }}>{day(item.event_date)}</span>
            <strong style={{ fontFamily: "var(--font-serif)", fontSize: 15, fontWeight: 600 }}>
              {item.kind === "record" ? "Catatan" : "Peristiwa"} ini
            </strong>
          </li>
        )
      )}
    </ul>
  );
}

function FollowupItem({ row: f, pair, first, href }: { row: FollowupRow; pair: { earlier_id: number; later_id: number }; first: boolean; href: string }) {
  const [tone, text]: [PillTone, string] =
    f.verdict === "confirmed" ? ["accept", "Dikonfirmasi · tampil di situs"] :
    f.verdict === "rejected" ? ["danger", "Ditolak"] :
    f.proposed ? ["pending", "Usulan pipeline"] : ["neutral", "Ditambahkan"];
  return (
    <li style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", padding: "12px 0", borderTop: first ? "none" : `1px solid ${RULE}`, opacity: f.verdict === "rejected" ? 0.6 : 1 }}>
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <Pill tone={tone}>{text}</Pill>
          <span style={{ fontSize: 11.5, color: MUTED }}>
            {day(f.event_date)}
            {f.score !== null ? ` · skor ${f.score.toFixed(2)}` : ""}
          </span>
        </div>
        <Link href={href} scroll={false} style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: INK, lineHeight: 1.4 }}>
          {f.title ?? `#${f.event_id}`}
        </Link>
        {f.evidence.length > 0 ? (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>kata yang sama: {f.evidence.join(", ")}</div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {f.verdict !== "confirmed" ? (
          <form action={ruleFollowup}>
            <Hidden fields={{ ...pair, verdict: "confirmed" }} />
            <button type="submit" style={button("accept")}>Benar</button>
          </form>
        ) : null}
        {f.verdict !== "rejected" ? (
          <form action={ruleFollowup}>
            <Hidden fields={{ ...pair, verdict: "rejected" }} />
            <button type="submit" style={button("quiet")}>Bukan</button>
          </form>
        ) : null}
        {f.verdict ? (
          <form action={ruleFollowup}>
            <Hidden fields={{ ...pair, verdict: "" }} />
            <button type="submit" style={button("quiet")}>Batalkan</button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Follow-ups the pipeline did not propose, picked from a list: events nearby
 * that share distinctive words, or any found by title. The dates decide which
 * one came first, so there is no direction to choose.
 */
function AddFollowup({ item, candidates, search, open }: { item: Item; candidates: FollowupCandidate[]; search: string; open: Open }) {
  const what = item.kind === "record" ? "catatan tokoh ini" : "peristiwa";
  return (
    <SubPanel
      title={item.kind === "record" ? "Sambungkan catatan lain" : "Sambungkan peristiwa lain"}
      note={search
        ? `Hasil pencarian judul “${search}”.`
        : `Saran: ${what} dalam ±60 hari yang berbagi kata khas dengan ini. Urutannya mengikuti tanggal.`}
    >
      {candidates.length === 0 ? (
        <p style={{ fontSize: 13, color: MUTED, margin: "0 0 10px" }}>
          {search ? "Tidak ada judul yang cocok." : "Tidak ada saran. Coba cari judulnya di bawah."}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 12px", padding: 0 }}>
          {candidates.map((c, i) => (
            <li key={c.event_id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "9px 0", borderTop: i === 0 ? "none" : `1px solid ${RULE}` }}>
              <div style={{ flex: "1 1 380px", minWidth: 0 }}>
                <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 2 }}>
                  {day(c.event_date)} · <strong style={{ color: INK, fontWeight: 600 }}>{c.before ? "sebelum ini" : "sesudah ini"}</strong>
                  {c.shared.length > 0 ? ` · ${c.shared.join(", ")}` : ""}
                </div>
                <Link href={open(eventPanel(item.kind, c.event_id))} scroll={false} style={{ fontFamily: "var(--font-serif)", fontSize: 15, color: INK, lineHeight: 1.4 }}>
                  {c.title ?? `#${c.event_id}`}
                </Link>
              </div>
              <form action={addFollowup}>
                <Hidden fields={{ event_id: item.event_id, other_id: c.event_id }} />
                <button type="submit" style={button("ink")}>Tautkan</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form method="get" action={`/kurasi/${item.event_id}`} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input type="hidden" name="panel" value="lini" />
        <input name="cari" defaultValue={search} placeholder="Cari judul, misal “Virgo”" style={{ ...input, flex: "1 1 260px" }} aria-label="Cari judul" />
        <button type="submit" style={button("quiet")}>Cari</button>
        {search ? <Link href={open("lini")} scroll={false} style={{ fontSize: 12.5, color: MUTED, alignSelf: "center" }}>Kembali ke saran</Link> : null}
      </form>
    </SubPanel>
  );
}

/** What the record shows as its owner's words, in the Isi card. */
/** In the drawer, beyond this many the rest fold away. */
const QUOTES_OPEN = 20;

/** "Name · title" for a picker's starting value. */
function figureLabel(figures: FigureOption[], id: string | null): string | null {
  const f = id ? figures.find((x) => x.id === id) : undefined;
  return f ? (f.title ? `${f.name} – ${f.title}` : f.name) : null;
}

/**
 * Kutipan on the page: the quote the site shows, then the actors' own words,
 * up to QUOTES_SHOWN. Every quote, adding one and choosing none are in the drawer.
 */
function QuotePreview({ item, actors, figures, open }: { item: Item; actors: Related[]; figures: FigureOption[]; open: Open }) {
  if (item.quotes.length === 0) {
    return (
      <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>
        {item.sources.some((a) => a.has_body)
          ? "Tidak ada kalimat langsung yang jelas pembicaranya."
          : "Belum ada artikel yang teksnya sudah diambil; kutipan muncul setelah pipeline mengambilnya."}
      </p>
    );
  }
  const actorIds = new Set(actors.map((a) => a.id));
  const rank = (q: QuoteRow) => (item.quote && item.quote === q.quote ? 0 : q.figure_id && actorIds.has(q.figure_id) ? 1 : q.figure_id ? 2 : 3);
  const head = [...item.quotes].sort((a, b) => rank(a) - rank(b)).slice(0, QUOTES_SHOWN);
  return (
    <>
      {item.kind === "record" && !item.quote ? (
        <p style={{ fontSize: 12.5, color: MUTED, margin: "0 0 6px" }}>
          {item.quote === "" ? "Tanpa kutipan: kamu memilih tidak menampilkannya." : "Belum ada kutipan yang tampil di catatan."}
        </p>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {head.map((q, i) => <QuoteItem key={q.id} quote={q} item={item} actors={actors} figures={figures} first={i === 0} open={open} />)}
      </ul>
      {item.quotes.length > head.length ? (
        <div style={{ borderTop: `1px solid ${RULE}`, paddingTop: 10 }}>
          <TextLink href={open("kutipan")} tone="muted">Semua {item.quotes.length} kutipan →</TextLink>
        </div>
      ) : null}
    </>
  );
}

function QuoteList({ item, actors, figures, open }: { item: Item; actors: Related[]; figures: FigureOption[]; open: Open }) {
  const isRecord = item.kind === "record";
  const footer = (
    <>
      {isRecord && item.figure_id ? <ShownQuoteChoice item={item} /> : null}
    </>
  );
  if (item.quotes.length === 0) {
    return (
      <>
        <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>
          {item.sources.some((a) => a.has_body)
            ? "Tidak ada kalimat langsung yang jelas pembicaranya."
            : "Belum ada artikel yang teksnya sudah diambil; kutipan muncul setelah pipeline mengambilnya."}
        </p>
        {footer}
      </>
    );
  }
  const head = item.quotes.slice(0, QUOTES_OPEN);
  const rest = item.quotes.slice(QUOTES_OPEN);
  const list = (rows: QuoteRow[], offset: number) => (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((q, i) => <QuoteItem key={q.id} quote={q} item={item} actors={actors} figures={figures} first={offset + i === 0} open={open} />)}
    </ul>
  );
  return (
    <>
      {list(head, 0)}
      {rest.length ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: MUTED }}>Kutipan lainnya ({rest.length})</summary>
          {list(rest, QUOTES_OPEN)}
        </details>
      ) : null}
      {footer}
    </>
  );
}

/** "Tanpa kutipan", or handing the choice back to the pipeline. */
function ShownQuoteChoice({ item }: { item: Item }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
      {item.quote !== "" ? (
        <form action={pickQuote}>
          <Hidden fields={{ event_id: item.event_id, quote_id: "none" }} />
          <button type="submit" style={button("quiet")}>Tanpa kutipan</button>
        </form>
      ) : (
        <form action={pickQuote}>
          <Hidden fields={{ event_id: item.event_id, quote_id: "auto" }} />
          <button type="submit" style={button("quiet")}>Biarkan pipeline memilih lagi</button>
        </form>
      )}
    </div>
  );
}

/** A quote the extractor missed or cut short, typed in by the curator. */
function AddQuote({ item, figures }: { item: Item; figures: FigureOption[] }) {
  const withText = item.sources.filter((s) => s.url);
  return (
    <details style={{ border: `1px solid ${RULE}`, borderRadius: 6, padding: "10px 12px", background: "var(--color-cream)" }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: INK }}>+ Tambah kutipan</summary>
      <form action={newQuote} style={{ display: "grid", gap: 8, marginTop: 8 }}>
        <Hidden fields={{ event_id: item.event_id }} />
        <textarea
          name="quote"
          rows={3}
          required
          maxLength={2000}
          placeholder="Kalimat langsungnya, tanpa tanda petik"
          aria-label="Kutipan"
          style={{ ...input, resize: "vertical", fontFamily: "var(--font-serif)", lineHeight: 1.5 }}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <FigurePicker
            listId={FIGURE_LIST}
            defaultId={item.figure_id}
            defaultLabel={figureLabel(figures, item.figure_id)}
            placeholder="Cari tokoh yang berbicara (kosongkan bila bukan tokoh)"
          />
          <input
            name="speaker"
            maxLength={200}
            placeholder="Pembicara seperti ditulis media (opsional)"
            aria-label="Pembicara seperti ditulis media"
            style={{ ...input, flex: "1 1 200px" }}
          />
        </div>
        <select name="url" defaultValue="" aria-label="Sumber" style={input}>
          <option value="">Sumber: tanpa artikel</option>
          {withText.map((s) => (
            <option key={s.id} value={s.url}>{s.source}{s.title ? ` · ${s.title}` : ""}</option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {item.kind === "record" && item.figure_id ? (
            <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" name="show" value="1" defaultChecked={!item.quote} />
              Tampilkan di catatan (bila tokohnya yang dicatat di sini)
            </label>
          ) : null}
          <button type="submit" style={button("ink")}>Tambah</button>
        </div>
      </form>
    </details>
  );
}

function QuoteItem({ quote: q, item, actors, figures, first, open }: { quote: QuoteRow; item: Item; actors: Related[]; figures: FigureOption[]; first: boolean; open: Open }) {
  // The site shows a record's quote under the figure it is filed under, with
  // no name beside it; so only that figure's words can be the one shown.
  const own = Boolean(item.figure_id) && q.figure_id === item.figure_id;
  const actor = actors.some((a) => a.id === q.figure_id);
  const shown = Boolean(item.quote) && item.quote === q.quote;
  const title = q.figure_id ? figures.find((f) => f.id === q.figure_id)?.title || null : null;
  return (
    <li style={{ padding: "14px 0", borderTop: first ? "none" : `1px solid ${RULE}`, ...(shown ? { borderLeft: "3px solid var(--color-clay)", paddingLeft: 14 } : {}) }}>
      <p style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 15, lineHeight: 1.55, margin: 0 }}>“{q.quote}”</p>
      <div style={{ fontSize: 12, color: MUTED, margin: "4px 0 8px" }}>
        — {q.speaker ?? "(tanpa nama)"}
        {q.source ? ` · ${q.source}` : ""}
        {q.url ? <> <a href={q.url} target="_blank" rel="noreferrer" aria-label="Buka di situs asli" style={{ color: MUTED, textDecoration: "none" }}>↗</a></> : null}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {q.figure_id ? (
          <Link href={open(`tokoh:${q.figure_id}`)} scroll={false} style={{ textDecoration: "none" }}>
            <Pill tone={actor ? "ink" : "neutral"} title={q.assigned_by === "curator" ? "Dipilih kurator" : "Dicocokkan otomatis dari nama pembicara"}>
              {q.figure_name ?? q.figure_id}{q.assigned_by === "curator" ? " ✓" : ""}
            </Pill>
          </Link>
        ) : (
          <Pill tone="pending" title={q.assigned_by === "curator" ? "Kamu menandainya bukan tokoh yang dilacak" : "Pembicaranya tidak cocok dengan satu tokoh pun"}>
            {q.assigned_by === "curator" ? "bukan tokoh yang dilacak" : "belum ada tokoh"}
          </Pill>
        )}
        {q.figure_id ? (
          <span style={{ fontSize: 12, color: MUTED }}>
            {[title, q.assigned_by === "curator" ? null : "dicocokkan otomatis"].filter(Boolean).join(" · ")}
          </span>
        ) : null}
        {shown ? <Pill tone="accept">tampil di catatan</Pill> : null}
        <span style={{ flex: 1 }} />
        {item.kind === "record" && own && !shown ? (
          <form action={pickQuote}>
            <Hidden fields={{ event_id: item.event_id, quote_id: q.id }} />
            <button type="submit" style={button("accept")}>Tampilkan di catatan</button>
          </form>
        ) : null}
        <SpeakerEditor quoteId={q.id} listId={FIGURE_LIST} canClear={Boolean(q.figure_id) || q.assigned_by !== "curator"} />
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <span style={{ fontSize: 12, color: MUTED }}>tentang</span>
        {q.about.length === 0 ? <span style={{ fontSize: 12, color: MUTED }}>–</span> : null}
        {q.about.map((s) => (
          <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <Link href={open(`tokoh:${s.id}`)} scroll={false} style={{ textDecoration: "none" }}>
              <Pill tone={s.status === "confirmed" ? "ink" : "neutral"} title={s.status === "confirmed" ? "Dikonfirmasi" : "Ditemukan pipeline dari nama di kutipannya"}>
                {s.name}{s.status === "confirmed" ? " ✓" : ""}
              </Pill>
            </Link>
            <form action={setQuoteAbout}>
              <Hidden fields={{ quote_id: q.id, figure_id: s.id, on: "0" }} />
              <button type="submit" aria-label={`Kutipan ini bukan tentang ${s.name}`} title="Bukan tentang dia" style={{ fontSize: 13, lineHeight: 1, background: "none", border: "none", padding: "4px 6px", cursor: "pointer", color: MUTED }}>×</button>
            </form>
          </span>
        ))}
        {/* Keyed by the list, so a save closes it. */}
        <AboutEditor key={q.about.map((s) => s.id).join()} quoteId={q.id} listId={FIGURE_LIST} />
      </div>
    </li>
  );
}

/**
 * The decisions the pipeline made here without asking (quote speakers),
 * offered as points to check. Each answer counts toward the
 * confidence of its band; a band past the gate can be answered automatically.
 */
function CheckOffer({ eventId, count }: { eventId: number; count: number }) {
  return (
    <form
      action={openDecisionPoints}
      style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "12px 14px", marginBottom: 18, border: `1.5px dashed var(--color-parchment-dark)`, borderRadius: 2 }}
    >
      <input type="hidden" name="event_id" value={eventId} />
      <span style={{ flex: "1 1 320px", fontSize: 13, color: "var(--color-mud)", lineHeight: 1.5 }}>
        <strong style={{ color: INK }}>{count} keputusan otomatis belum dicek</strong> di sini: pembicara kutipan yang ditetapkan pipeline tanpa bertanya.
        Tiap jawabanmu mengukur ketepatannya; jenis yang mencapai {AUTO_MIN_ANSWERS} jawaban dengan ≥{Math.round(AUTO_MIN_AGREEMENT * 100)}% setuju bisa dikonfirmasi otomatis.
      </span>
      <button type="submit" style={{ ...button("ink"), padding: "8px 16px" }}>Buka sebagai poin</button>
    </form>
  );
}
