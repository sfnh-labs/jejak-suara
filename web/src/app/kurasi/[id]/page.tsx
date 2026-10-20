import Link from "next/link";
import { notFound } from "next/navigation";
import { REASONS, getFigureOptions, getOrganizations, type Organization, getFollowupCandidates, getItem, getReading, likelyDuplicates, positionTitle, reasonLabel, type FigureOption, type FigureRef, type FollowupCandidate, type FollowupRow, type Position, type Profile, type Item, type Rework, type ReworkSnapshot, type CvProposal, type LinkRow, type NamedPerson, type QuoteRow } from "@/lib/curation";
import { decide } from "../kandidat/actions";
import { AcceptCandidateForm } from "../AcceptCandidateForm";
import { FigurePicker, SpeakerEditor } from "../FigurePicker";
import { ArticleReader, type ReaderTerm } from "../ArticleReader";
import { addFollowup, curate, editFigure, mergeFigures, relateFigure, ruleFollowup, ruleLink, rework, decideRework, notAPerson, setQuoteSpeaker, pickQuote, newQuote } from "../actions";
import { storyImageSource, storylines } from "@/lib/data";
import { EventBanner } from "../EventImage";
import { placeGroups, provinceLabel, provincesIn } from "@/lib/places";
import { ACCEPT, INK, MUTED, RULE, SURFACE, button, day, input, label } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kurasi · Jejak Suara",
  robots: { index: false, follow: false },
};

export default async function KurasiItem({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ perlu?: string; cari?: string; baca?: string }>;
}) {
  const { id } = await params;
  const { perlu, cari = "", baca } = await searchParams;
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0) notFound();
  const [item, figures, orgs] = await Promise.all([getItem(eventId), getFigureOptions(), getOrganizations()]);
  if (!item) notFound();
  const [candidates, reading] = await Promise.all([
    getFollowupCandidates(item, cari.slice(0, 100)),
    baca ? getReading(eventId, baca.slice(0, 128)) : null,
  ]);
  // The page's own address with the reading pane set or cleared; the other
  // parameters ride along so opening an article loses nothing.
  const here = (article: string | null) => {
    const q = new URLSearchParams();
    if (perlu) q.set("perlu", perlu);
    if (cari) q.set("cari", cari);
    if (article) q.set("baca", article);
    const qs = q.toString();
    return `/kurasi/${eventId}${qs ? `?${qs}` : ""}`;
  };
  const terms = readerTerms(item);
  // The banner the site would show, borrowed ones included (peristiwa only).
  const image = item.kind === "peristiwa"
    ? storyImageSource(eventId, (await storylines([eventId], { evenHidden: [eventId] })).get(eventId) ?? [], item.title)
    : null;

  const isRecord = item.kind === "record";
  const outlets = new Set(item.sources.map((s) => s.source)).size;
  const queue = `/kurasi?kind=${item.kind}`;
  // Headlines set in provinces nothing connects: the commonest sign that
  // clustering merged two stories (a Lokon wildfire with a Tangerang factory
  // fire). Peristiwa only; a record follows one person around the country.
  const places = isRecord ? [] : placeGroups(item.sources.map((s) => s.title));
  const scattered = places.length > 1;

  // Numbered in reading order; the record-only "Pelaku" shifts the rest.
  const sections = [
    { id: "isi", title: "Isi" },
    { id: "nama", title: "Tokoh" },
    { id: "kutipan", title: "Kutipan" },
    { id: "tautan", title: isRecord ? "Bagian dari peristiwa" : "Catatan di dalamnya" },
    { id: "lini", title: "Lini cerita" },
  ];
  const n = (key: string) => sections.findIndex((x) => x.id === key) + 1;

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Side by side only when wide enough for both; narrower, the article
          opens under its own line in the list instead. */}
      <style>{`
        .kurasi-reader-side { display: none; }
        @media (min-width: 1180px) {
          .kurasi-split.reading { display: grid; grid-template-columns: minmax(0, 920px) minmax(0, 1fr); gap: 28px; align-items: start; }
          .kurasi-split.reading .kurasi-reader-side { display: block; position: sticky; top: 0; max-height: 100vh; overflow-y: auto; padding: 22px 0 40px; overscroll-behavior: contain; }
          .kurasi-split.reading .kurasi-reader-inline { display: none; }
        }
      `}</style>
      <div className={`container-page kurasi-split${reading ? " reading" : ""}`} style={{ maxWidth: reading ? 1640 : 920, paddingBottom: 96 }}>
        <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "22px 0 0", fontSize: 12.5, flexWrap: "wrap" }}>
          <Link href={queue} style={{ color: MUTED }}>← Antrean {isRecord ? "catatan" : "peristiwa"}</Link>
          {item.next_id ? (
            <Link href={`/kurasi/${item.next_id}`} style={{ color: MUTED }}>Lewati, ke berikutnya →</Link>
          ) : null}
        </div>

        <header style={{ padding: "18px 0 18px" }}>
          {isRecord ? null : <EventBanner eventId={item.event_id} image={image} />}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <Pill tone="ink">{isRecord ? "Catatan" : "Peristiwa"} #{item.event_id}</Pill>
            <Pill>
              {day(item.event_date)}
              {item.last_seen && day(item.last_seen) !== day(item.event_date) ? ` – ${day(item.last_seen)}` : ""}
            </Pill>
            <Pill>{outlets} media · {item.sources.length} artikel</Pill>
            {outlets <= 1 ? (
              <Pill tone="danger" title="Semua artikelnya dari satu media. Belum ada redaksi lain yang ikut melaporkan, jadi periksa lebih teliti.">
                ⚠ hanya 1 media
              </Pill>
            ) : null}
            {scattered ? <Pill tone="danger">⚠ beda provinsi</Pill> : null}
            {item.event_type && item.event_type !== "other" ? <Pill>{item.event_type}</Pill> : null}
          </div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "clamp(24px, 4vw, 32px)", lineHeight: 1.2, margin: "0 0 8px", letterSpacing: "-0.01em" }}>
            {item.title ?? "(tanpa judul)"}
          </h1>
          {scattered ? (
            <p style={{ fontSize: 13, color: "var(--color-clay)", margin: "0 0 8px", lineHeight: 1.5 }}>
              Judul artikelnya menyebut tempat yang berbeda:{" "}
              {places.map((g) => `${g.provinces.map(provinceLabel).join(" / ")} (${g.count})`).join(" · ")}.
              {" "}Bisa jadi beberapa kejadian yang tergabung; periksa artikel sumbernya. Bila ya, turunkan dengan alasan “Campuran beberapa kejadian”.
            </p>
          ) : null}
          {isRecord && item.figure_id && item.curated !== "rejected" ? (
            <Link href={`/tokoh/${item.figure_id}/${item.event_id}`} target="_blank" style={{ fontSize: 12.5, color: MUTED }}>
              Lihat di situs ↗
            </Link>
          ) : null}
        </header>

        <VerdictBar item={item} sections={sections} missing={perlu} figures={figures} />
        <FigureOptions figures={figures} />
        <OrgOptions orgs={orgs} />

        <Card n={n("isi")} id="isi" title="Isi" note="Ringkasan yang tayang dan artikel yang menjadi sumbernya. Baca ini dulu sebelum memutuskan.">
          {item.summary ? (
            <p style={{ fontSize: 14.5, lineHeight: 1.65, color: "var(--color-mud)", margin: 0, whiteSpace: "pre-line" }}>
              {item.summary}
            </p>
          ) : (
            <p style={{ fontSize: 13.5, color: MUTED, margin: 0, fontStyle: "italic" }}>
              Belum dirangkum. Yang tayang adalah judul dari hasil klaster.
            </p>
          )}
          {isRecord ? <ShownQuote item={item} /> : null}
          <SubPanel
            title={`Artikel sumber (${item.sources.length})`}
            note="Klik judul untuk membacanya di sini; ↗ membuka situs aslinya."
            collapsible
            open={!item.summary || scattered || Boolean(reading)}
          >
            <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {item.sources.map((a, i) => (
                <li
                  key={`${a.url}-${i}`}
                  style={{
                    padding: "10px 0", borderTop: i ? `1px solid ${RULE}` : "none",
                    ...(reading?.id === a.id ? { boxShadow: "inset 3px 0 0 var(--color-clay)", paddingLeft: 12 } : {}),
                  }}
                >
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, marginBottom: 2 }}>
                    {a.source} · {day(a.published_at)}
                    {scattered && provincesIn(a.title).size > 0
                      ? <span style={{ color: "var(--color-clay)" }}> · {[...provincesIn(a.title)].map(provinceLabel).join(", ")}</span>
                      : null}
                  </div>
                  <Link
                    href={here(reading?.id === a.id ? null : a.id)}
                    scroll={false}
                    style={{ color: INK, fontSize: 14, lineHeight: 1.45, fontWeight: reading?.id === a.id ? 600 : 400 }}
                  >
                    {a.title ?? a.url}
                  </Link>
                  {a.has_body ? null : <span style={{ fontSize: 11.5, color: MUTED }}> · hanya ringkasan</span>}{" "}
                  <a href={a.url} target="_blank" rel="noreferrer" aria-label="Buka di situs asli" style={{ color: MUTED, fontSize: 12.5, textDecoration: "none" }}>↗</a>
                  {a.lead ? (
                    <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3, lineHeight: 1.5 }}>
                      {a.lead.slice(0, 240)}{a.lead.length > 240 ? "…" : ""}
                    </div>
                  ) : null}
                  {reading?.id === a.id ? (
                    <div className="kurasi-reader-inline" style={{ marginTop: 12 }}>
                      <ArticleReader article={reading} terms={terms} closeHref={here(null)} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </SubPanel>
        </Card>

        <Card
          n={n("nama")}
          id="nama"
          title="Tokoh"
          count={item.named.length}
          note={
            isRecord
              ? "Semua orang di liputan catatan ini, pemilik catatan paling atas. Tokoh yang sudah ada bisa disunting atau digabung; nama baru bisa dijadikan tokoh, disamakan dengan tokoh yang ada, atau ditolak. Perubahan nama, jabatan, dan alias berlaku di seluruh situs dan dipakai pipeline untuk artikel berikutnya."
              : "Semua orang di liputan peristiwa ini. Coret tokoh yang salah cocok, misalnya karena alias yang juga nama orang lain; nama baru bisa langsung diputuskan."
          }
        >
          <NamedList item={item} figures={figures} />
        </Card>

        <Card
          n={n("kutipan")}
          id="kutipan"
          title="Kutipan"
          count={item.quotes.length}
          note={
            isRecord
              ? "Kalimat langsung di artikelnya, dengan pembicara seperti yang ditulis media dan tokoh yang dicocokkan pipeline. Betulkan pemiliknya bila salah, dan pilih kutipan pemilik catatan yang tampil di situs."
              : "Kalimat langsung di artikelnya, dengan pembicara seperti yang ditulis media dan tokoh yang dicocokkan pipeline. Betulkan pemiliknya bila salah."
          }
        >
          <QuoteList item={item} figures={figures} />
        </Card>

        <Card
          n={n("tautan")}
          id="tautan"
          title={isRecord ? "Bagian dari peristiwa" : "Catatan di dalamnya"}
          count={item.links.length}
          note={
            isRecord
              ? "Peristiwa yang menaungi catatan ini. Pipeline mengusulkan berdasar kata khas yang sama; hanya yang kamu konfirmasi yang tampil di situs."
              : "Catatan tokoh yang diusulkan atau dikonfirmasi sebagai bagian dari peristiwa ini."
          }
        >
          <LinkList item={item} />
          {isRecord ? <AddLink item={item} /> : null}
        </Card>

        <Card
          n={n("lini")}
          id="lini"
          title="Lini cerita"
          count={item.followups.earlier.length + item.followups.later.length}
          note={
            isRecord
              ? "Catatan tokoh yang sama sebelum dan sesudah ini, bila ini kelanjutannya: diumumkan lalu direvisi, dijanjikan lalu ditepati. Hanya yang kamu konfirmasi yang tampil sebagai lini cerita di situs."
              : "Peristiwa sebelum dan sesudah ini, bila ini kelanjutannya: RUU diusulkan lalu disahkan, pencarian dimulai lalu dihentikan. Hanya yang kamu konfirmasi yang tampil di situs, dan peristiwa tanpa gambar memakai gambar dari lini ceritanya."
          }
        >
          <FollowupList item={item} />
          <AddFollowup item={item} candidates={candidates} search={cari} />
        </Card>

        <p style={{ fontSize: 12, color: MUTED, margin: "22px 0 0", lineHeight: 1.6, maxWidth: 640 }}>
          Keputusan di sini langsung tersimpan di <code>jejak.db</code> dan dipakai pipeline pada putaran
          berikutnya. Situs publik mengikutinya setelah push ke Neon.
        </p>
        </div>
        {reading ? (
          <aside className="kurasi-reader-side" aria-label="Artikel yang sedang dibaca">
            <ArticleReader article={reading} terms={terms} closeHref={here(null)} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The names the reading pane marks: the record's own figure, the other
 * tracked figures this coverage names, and the new names waiting for a
 * verdict. Two-letter terms are skipped; they would mark half of every page.
 */
function readerTerms(item: Item): ReaderTerm[] {
  const out: ReaderTerm[] = [];
  const add = (texts: string[], kind: ReaderTerm["kind"], label: string) => {
    for (const text of new Set(texts.map((t) => t.trim()))) {
      if (text.length > 2) out.push({ text, kind, label });
    }
  };
  if (item.owner) add([item.owner.name, ...item.owner.aliases], "owner", item.owner.name);
  for (const p of item.named) {
    if (p.kind === "figure") add([p.name, ...p.aliases], "figure", p.name);
    else if (!p.verdict) add([p.name], "candidate", p.name);
  }
  return out;
}

/** A numbered block with its own header, so where a section starts and ends is never in doubt. */
function Card({
  n,
  id,
  title,
  note,
  count,
  children,
}: {
  n: number;
  id: string;
  title: string;
  note?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      style={{ background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 8, marginTop: 18, scrollMarginTop: 96 }}
    >
      <header style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 18px", background: "var(--color-cream-dark)", borderBottom: `1px solid ${RULE}`, borderRadius: "7px 7px 0 0" }}>
        <span
          aria-hidden
          style={{
            flex: "none", width: 24, height: 24, borderRadius: "50%", background: INK, color: "var(--color-cream)",
            fontSize: 12, fontWeight: 700, display: "grid", placeItems: "center", marginTop: 1,
          }}
        >
          {n}
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 600, margin: 0, lineHeight: 1.3, color: INK }}>
            {title}
            {count !== undefined ? <span style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 400, color: MUTED, marginLeft: 8 }}>{count}</span> : null}
          </h2>
          {note ? <p style={{ fontSize: 12.5, color: MUTED, margin: "3px 0 0", lineHeight: 1.5, maxWidth: 660 }}>{note}</p> : null}
        </div>
      </header>
      <div style={{ padding: "16px 18px 18px" }}>{children}</div>
    </section>
  );
}

/** A group inside a card: a labelled, tinted box, optionally folded away. */
function SubPanel({
  title,
  note,
  tone,
  collapsible,
  open,
  children,
}: {
  title: string;
  note?: string;
  tone?: "danger";
  collapsible?: boolean;
  open?: boolean;
  children: React.ReactNode;
}) {
  const box = {
    marginTop: 14,
    border: `1px solid ${tone === "danger" ? "var(--color-warn-border)" : RULE}`,
    background: tone === "danger" ? "var(--color-warn-bg)" : "var(--color-cream)",
    borderRadius: 6,
    padding: "12px 14px",
  } as const;
  const heading = (
    <span style={{ fontSize: 12.5, fontWeight: 700, color: tone === "danger" ? "var(--color-clay)" : INK }}>{title}</span>
  );
  const body = (
    <>
      {note ? <p style={{ fontSize: 12, color: MUTED, margin: "2px 0 10px", lineHeight: 1.5 }}>{note}</p> : <div style={{ height: 8 }} />}
      {children}
    </>
  );
  if (collapsible) {
    return (
      <details open={open} style={box}>
        <summary style={{ cursor: "pointer" }}>{heading}</summary>
        {body}
      </details>
    );
  }
  return (
    <div style={box}>
      {heading}
      {body}
    </div>
  );
}

type PillTone = "neutral" | "ink" | "accept" | "danger" | "pending";

function Pill({ tone = "neutral", title, children }: { tone?: PillTone; title?: string; children: React.ReactNode }) {
  const look = {
    neutral: { color: "var(--color-mud)", background: "var(--color-cream-dark)", border: RULE },
    ink: { color: "var(--color-cream)", background: INK, border: INK },
    accept: { color: ACCEPT, background: "var(--color-sage-bg)", border: "var(--color-sage-border)" },
    danger: { color: "var(--color-clay)", background: "var(--color-warn-bg)", border: "var(--color-warn-border)" },
    pending: { color: "#7a5a12", background: "#fbf1d9", border: "#e6cf96" },
  }[tone];
  return (
    <span
      title={title}
      style={{
        display: "inline-block", fontSize: 11, fontWeight: 700, lineHeight: 1.5, padding: "1px 8px",
        borderRadius: 999, whiteSpace: "nowrap", color: look.color, background: look.background,
        border: `1px solid ${look.border}`,
      }}
    >
      {children}
    </span>
  );
}

function Hidden({ fields }: { fields: Record<string, string | number> }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
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
  sections,
  missing,
  figures,
}: {
  item: Item;
  sections: { id: string; title: string }[];
  missing?: string;
  figures: FigureOption[];
}) {
  const next = item.next_id ?? "";
  const s = item.suggestion;
  const autoHidden = !item.curated && s?.auto_hide;
  const [tone, status]: [PillTone, string] =
    item.curated === "rejected" ? ["danger", "Diturunkan dari situs"] :
    item.curated === "kept" ? ["accept", "Sudah diperiksa · tayang"] :
    autoHidden ? ["pending", "Disembunyikan otomatis · belum ditinjau"] :
    ["neutral", "Tayang · belum ditinjau"];
  const suggested = !item.curated && s?.reason ? s.reason : "";
  const ticked = new Set<string>(item.curated === "rejected" ? item.ruling?.reasons ?? [] : suggested ? [suggested] : []);
  return (
    <div
      id="keputusan"
      style={{
        position: "sticky", top: 0, zIndex: 5, background: SURFACE, border: `1px solid ${RULE}`,
        borderRadius: 8, padding: "10px 14px", boxShadow: "0 2px 10px rgba(22, 19, 15, 0.06)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MUTED }}>Keputusan</span>
        <Pill tone={tone}>{status}</Pill>
        <span style={{ flex: "1 1 auto" }} />
        {item.curated !== "kept" ? (
          <form action={curate}>
            <Hidden fields={{ event_id: item.event_id, verdict: "kept", next, suggested }} />
            <button type="submit" style={button("accept")}>
              {autoHidden || item.curated === "rejected" ? "Tayangkan, lanjut →" : "Tayang, lanjut →"}
            </button>
          </form>
        ) : null}
        <details open={Boolean(missing)} style={{ position: "static" }}>
          <summary style={{ ...button(item.curated === "rejected" ? "quiet" : "danger"), listStyle: "none", display: "inline-block" }}>
            {item.curated === "rejected" ? "Ubah alasan…" : "Turunkan…"}
          </summary>
          <form
            action={curate}
            style={{
              position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 6,
              background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 8, padding: "14px 16px",
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
        <ReworkMenu item={item} figures={figures} />
        {item.curated ? (
          <form action={curate}>
            <Hidden fields={{ event_id: item.event_id, verdict: "" }} />
            <button type="submit" style={button("quiet")}>
              {item.curated === "rejected" ? "Tayangkan lagi" : "Batalkan"}
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
      {!item.curated && s ? <SuggestionLine item={item} /> : null}
      <CvNote item={item} figures={figures} />
      <nav style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${RULE}` }}>
        {sections.map((x, i) => (
          <a key={x.id} href={`#${x.id}`} style={{ color: MUTED, textDecoration: "none" }}>
            <strong style={{ color: INK }}>{i + 1}</strong> {x.title}
          </a>
        ))}
      </nav>
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
          background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 8, padding: "14px 16px",
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
 * edited under "Pelaku" or on the figure's own record.
 */
function CvNote({ item, figures }: { item: Item; figures: FigureOption[] }) {
  const p = item.cvProposals.find((r) => r.status === "accepted");
  if (!p?.proposal) return null;
  const who = figures.find((f) => f.id === p.figure_id)?.name ?? p.figure_id;
  const d = p.proposal;
  const entries = [
    ...d.positions.map((x) => [x.role, x.org].filter(Boolean).join(" ") + (x.period ? ` (${x.period})` : "")),
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

/** "Saran: Remeh / seremonial — mirip 12 yang pernah diturunkan", with the examples. */
function SuggestionLine({ item }: { item: Item }) {
  const s = item.suggestion!;
  return (
    <div style={{ fontSize: 12.5, color: "#7a5a12", marginTop: 8, display: "grid", gap: 3 }}>
      <div>
        <strong>{s.auto_hide ? "Disembunyikan otomatis:" : "Saran:"}</strong>{" "}
        {s.reason ? reasonLabel(s.reason) : "turunkan"}
        {s.confidence !== null ? ` · ${Math.round(s.confidence * 100)}%` : ""}
        {s.support > 0 ? ` · mirip ${s.support} yang pernah kamu turunkan dengan alasan ini` : ""}
        {s.auto_hide ? ". Tayangkan bila keliru; keputusanmu selalu menang." : ""}
      </div>
      {item.examples.length > 0 ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
          <span style={{ color: MUTED }}>Contoh:</span>
          {item.examples.map((x) => (
            <Link key={x.event_id} href={`/kurasi/${x.event_id}`} style={{ color: MUTED, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {x.title ?? `#${x.event_id}`}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FigureHeading({ figure }: { figure: FigureRef | NamedPerson }) {
  const active = figure.active ?? true;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <span style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 600, color: INK }}>{figure.name}</span>
      {figure.positions.length > 0 ? (
        <span style={{ fontSize: 13, color: "var(--color-mud)" }}>
          {figure.positions.map((p) => positionTitle(p) + (p.period ? ` (${p.period})` : "")).join(" · ")}
        </span>
      ) : figure.role ? (
        <span style={{ fontSize: 13, color: "var(--color-mud)" }}>{figure.role}</span>
      ) : null}
      <code style={{ fontSize: 11.5, color: MUTED }}>/tokoh/{figure.id}</code>
      {!active ? <Pill tone="danger">nonaktif</Pill> : null}
    </span>
  );
}

/**
 * The fields every figure editor shares: name, offices, aliases, active. The
 * record owner's form also carries the rest of the CV, since offices and CV
 * are one list: what is typed here is what the CV tab shows.
 */
function FigureForm({ figure, eventId }: { figure: FigureRef | NamedPerson; eventId: number }) {
  const profile = figure.profile ?? null;
  const active = figure.active ?? true;
  return (
    <form action={editFigure} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
      <Hidden fields={{ event_id: eventId, figure_id: figure.id }} />
      <label style={label}>
        Nama tampil
        <input name="name" defaultValue={figure.name} required style={input} />
      </label>
      <Positions figure={figure} />
      {profile ? <CvFields profile={profile} checkedAt={figure.cv_checked_at ?? null} figureId={figure.id} /> : null}
      <label style={{ ...label, gridColumn: "1 / -1" }}>
        Alias, satu per baris
        <span style={{ fontSize: 11.5 }}>
          Nama tampil selalu dicocokkan. Alias dicocokkan ke judul artikel, jadi hindari satu kata umum.
        </span>
        <textarea
          name="aliases"
          rows={Math.min(8, Math.max(3, figure.aliases.length + 1))}
          defaultValue={figure.aliases.join("\n")}
          style={{ ...input, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
        />
      </label>
      {/* Retiring is "Bukan orang…" or a merge; saving keeps a figure as it
          is. Only a retired figure (an owner whose record is still open) gets
          the way back. */}
      {active ? (
        <input type="hidden" name="active" value="1" />
      ) : (
        <label style={{ ...label, display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--color-mud)" }}>
          <input type="checkbox" name="active" value="1" />
          Tokoh ini nonaktif. Centang untuk mengaktifkannya lagi saat disimpan.
        </label>
      )}
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "flex-start", flexWrap: "wrap" }}>
        {active ? (
          // The existing-figure twin of rejecting a new name. Its confirm
          // button belongs to the separate form `bukan-orang-<id>`.
          <details style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <summary style={{ ...button("quiet"), listStyle: "none", display: "inline-block" }}>Bukan orang…</summary>
            <div style={{ ...CONFIRM_PANEL, textAlign: "left" }}>
              <span style={{ fontSize: 12.5, color: "var(--color-mud)", lineHeight: 1.5 }}>
                Untuk tempat, jabatan, atau potongan judul yang terlanjur jadi tokoh. {figure.name} dinonaktifkan,
                dicabut dari semua peristiwa, artikelnya dilepas, dan catatannya diturunkan.
              </span>
              <button type="submit" form={`bukan-orang-${figure.id}`} formNoValidate style={button("danger")}>
                Ya, hapus {figure.name}
              </button>
            </div>
          </details>
        ) : null}
        <button type="submit" style={button("ink")}>Simpan tokoh</button>
      </div>
    </form>
  );
}

/**
 * Offices as rows of role, organisation and period. Plain inputs with no
 * script, so there are always two blank rows to add to; clearing a row
 * deletes it. A figure with no curated offices yet starts from its one-line
 * title in the role column, to be split into role and organisation.
 */
function Positions({ figure }: { figure: FigureRef | NamedPerson }) {
  const rows: Position[] = figure.positions.length > 0
    ? figure.positions
    : figure.role ? [{ role: figure.role, org: "", period: "" }] : [];
  const blank = { role: "", org: "", period: "" };
  const all = [...rows, blank, blank];
  return (
    <fieldset style={{ gridColumn: "1 / -1", border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ ...label, padding: 0, marginBottom: 6 }}>
        Jabatan dan lembaga. Baris pertama adalah jabatan utama, tampil di bawah nama di seluruh situs. Kosongkan baris untuk menghapus.
      </legend>
      <div style={{ display: "grid", gap: 6, gridTemplateColumns: "minmax(120px, 1.2fr) minmax(120px, 1.2fr) minmax(100px, 0.8fr)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>Jabatan</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>Lembaga / organisasi</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>Periode</span>
        {all.map((p, i) => (
          <PositionRow key={i} position={p} main={i === 0} />
        ))}
      </div>
    </fieldset>
  );
}

/** Bio, facts, education and sources: the CV beyond its list of offices. */
function CvFields({ profile, checkedAt, figureId }: { profile: Profile; checkedAt: string | null; figureId: string }) {
  const head = { fontSize: 11, fontWeight: 700, color: MUTED } as const;
  const two = { display: "grid", gap: 6, gridTemplateColumns: "minmax(110px, 0.6fr) minmax(160px, 1.4fr)" } as const;
  const cell = { ...input, width: "100%" };
  const facts = [...profile.facts, { label: "", value: "" }, { label: "", value: "" }];
  const education = [...profile.education, { year: "", detail: "" }, { year: "", detail: "" }];
  const sources = [...profile.sources, { label: "", url: "" }];
  return (
    <fieldset style={{ gridColumn: "1 / -1", border: 0, borderTop: `1px solid ${RULE}`, padding: "12px 0 0", margin: 0, minWidth: 0, display: "grid", gap: 14 }}>
      <input type="hidden" name="has_cv" value="1" />
      <legend style={{ ...label, padding: 0 }}>
        CV, tampil di tab CV pada{" "}
        <Link href={`/tokoh/${figureId}?tab=cv`} target="_blank" style={{ color: MUTED }}>/tokoh/{figureId}</Link>.
        {" "}Riwayat jabatannya adalah daftar jabatan di atas; jabatan kini diambil dari baris pertama.
        {checkedAt ? ` Sumber diperiksa ${checkedAt}.` : ""}
      </legend>
      {/* Folded: they rarely change while curating a record. A closed
          <details> still submits its fields, so saving keeps them. */}
      <CvGroup title="Biodata" count={profile.facts.length}>
        <div style={two}>
          <span style={head}>Fakta</span><span style={head}>Isi</span>
          {facts.map((f, i) => (
            <FactRow key={i} a={["fact_label", f.label, "mis. Lahir"]} b={["fact_value", f.value, "mis. Kudus, 12 Oktober 1973"]} style={cell} hint={i === 0} />
          ))}
        </div>
      </CvGroup>
      <CvGroup title="Pendidikan" count={profile.education.length}>
        <div style={two}>
          <span style={head}>Tahun</span><span style={head}>Pendidikan</span>
          {education.map((e, i) => (
            <FactRow key={i} a={["edu_year", e.year ?? "", "1997"]} b={["edu_detail", e.detail, "mis. S1 Filsafat, UGM"]} style={cell} hint={i === 0} />
          ))}
        </div>
      </CvGroup>
      <CvGroup title="Sumber" count={profile.sources.length}>
        <div style={two}>
          <span style={head}>Sumber</span><span style={head}>URL</span>
          {sources.map((s, i) => (
            <FactRow key={i} a={["src_label", s.label, "mis. Wikipedia"]} b={["src_url", s.url, "https://…"]} style={cell} hint={i === 0} />
          ))}
        </div>
      </CvGroup>
    </fieldset>
  );
}

function CvGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <details style={{ border: `1px solid ${RULE}`, borderRadius: 6, padding: "8px 12px", background: SURFACE }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: INK }}>
        {title} <span style={{ fontWeight: 400, color: MUTED }}>{count ? `${count} isian` : "kosong"}</span>
      </summary>
      <div style={{ marginTop: 10 }}>{children}</div>
    </details>
  );
}

function FactRow({ a, b, style, hint }: { a: [string, string, string]; b: [string, string, string]; style: React.CSSProperties; hint: boolean }) {
  return (
    <>
      <input name={a[0]} defaultValue={a[1]} placeholder={hint ? a[2] : ""} style={style} aria-label={a[0]} />
      <input name={b[0]} defaultValue={b[1]} placeholder={hint ? b[2] : ""} style={style} aria-label={b[0]} />
    </>
  );
}

function PositionRow({ position: p, main }: { position: Position; main: boolean }) {
  const cell = { ...input, width: "100%", fontWeight: main ? 600 : 400 };
  return (
    <>
      <input name="pos_role" defaultValue={p.role} placeholder={main ? "mis. Ketua" : ""} style={cell} aria-label="Jabatan" />
      <input name="pos_org" list={ORG_LIST} autoComplete="off" defaultValue={p.org} placeholder={main ? "mis. MPR RI" : ""} style={cell} aria-label="Lembaga" />
      <input name="pos_period" defaultValue={p.period} placeholder={main ? "2024–sekarang" : ""} style={cell} aria-label="Periode" />
    </>
  );
}

const ORG_LIST = "org-options";

/**
 * Both names of every organisation in /kurasi/organisasi, for the office
 * rows: typing "KPK" or "Komisi Pem…" offers either form, the other as hint.
 */
function OrgOptions({ orgs }: { orgs: Organization[] }) {
  return (
    <datalist id={ORG_LIST}>
      {orgs.flatMap((o) => [
        ...(o.short_name ? [<option key={`${o.id}s`} value={o.short_name} label={o.name} />] : []),
        <option key={`${o.id}l`} value={o.name} label={o.short_name ?? ""} />,
      ])}
    </datalist>
  );
}

const FIGURE_LIST = "figure-options";

/**
 * The roster once per page, for every merge field to search. A <datalist>
 * filters as the curator types, by name or id, with no script; the field
 * submits the id, and `pattern` refuses anything not on the list.
 */
function FigureOptions({ figures }: { figures: FigureOption[] }) {
  return (
    <datalist id={FIGURE_LIST}>
      {figures.map((f) => (
        <option
          key={f.id}
          value={f.id}
          label={`${f.name}${f.role ? ` · ${f.role}` : ""}`}
          data-name={f.name}
          data-role={f.role ?? ""}
          data-aliases={f.aliases.join("|")}
        >
          {f.name}{f.role ? ` · ${f.role}` : ""}
        </option>
      ))}
    </datalist>
  );
}

function NamedList({ item, figures }: { item: Item; figures: FigureOption[] }) {
  if (item.named.length === 0) {
    return <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Tidak ada nama yang dikenali.</p>;
  }
  const isRecord = item.kind === "record";
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {item.named.map((p, i) => (
        // Each name is addressable, so the queue can send a curator straight
        // to it: /kurasi/<record>#nama-<slug>.
        <li key={`${p.kind}-${p.id}`} id={`nama-${p.id}`} style={{ scrollMarginTop: 80, padding: "14px 0", borderTop: i ? `1px solid ${RULE}` : "none" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
            <Pill tone={p.kind === "candidate" ? "pending" : "neutral"}>{p.kind === "candidate" ? "Nama baru" : "Sudah ada"}</Pill>
            {p.owner ? <Pill tone="ink">pemilik catatan</Pill> : null}
            <span style={{ fontSize: 11.5, color: MUTED }}>disebut di {p.articles} artikel</span>
            {p.struck ? <Pill tone="danger">dicoret dari peristiwa</Pill> : null}
          </div>
          {p.kind === "figure" ? (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", opacity: p.struck ? 0.6 : 1 }}>
              {/* Everything about this figure in one fold: its data, whether it
                  is someone else, and "Bukan orang". Closed, the line still
                  says when a duplicate is suspected. */}
              <details open={p.owner} style={{ flex: "1 1 420px", minWidth: 0 }}>
                <summary style={{ cursor: "pointer" }}>
                  <FigureHeading figure={p} />
                  {p.active !== false && likelyDuplicates(p, figures).length > 0 ? (
                    <span style={{ marginLeft: 8 }}><Pill tone="pending">mungkin tokoh ganda</Pill></span>
                  ) : null}
                  <span style={{ fontSize: 12, color: MUTED, marginLeft: 8 }}>sunting ▾</span>
                </summary>
                <SubPanel title="Data tokoh">
                  <FigureForm figure={p} eventId={item.event_id} />
                </SubPanel>
                {p.active !== false ? <SamePerson person={p} eventId={item.event_id} figures={figures} /> : null}
                {p.active !== false ? (
                  // Its button sits beside "Simpan tokoh"; forms cannot nest,
                  // so it submits this one by id.
                  <form id={`bukan-orang-${p.id}`} action={notAPerson}>
                    <Hidden fields={{ event_id: item.event_id, figure_id: p.id, confirm: 1 }} />
                  </form>
                ) : null}
              </details>
              {!isRecord && !p.owner ? (
                <form action={relateFigure}>
                  <Hidden fields={{ event_id: item.event_id, figure_id: p.id, struck: p.struck ? "0" : "1" }} />
                  <button type="submit" style={button("quiet")}>{p.struck ? "Pulihkan" : "Coret dari peristiwa"}</button>
                </form>
              ) : null}
            </div>
          ) : (
            <CandidateRow person={p} figures={figures} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A discovered name, decided where the evidence for it is being read.
 *
 * The form itself is shared with the queue (AcceptCandidateForm).
 */
function CandidateRow({ person: p, figures }: { person: NamedPerson; figures: FigureOption[] }) {
  if (p.verdict) {
    const [tone, text]: [PillTone, string] =
      p.verdict === "promote" ? ["accept", "dijadikan tokoh"] :
      p.verdict === "alias" ? ["accept", "disamakan dengan tokoh yang ada"] : ["danger", "ditolak"];
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 600 }}>{p.name}</span>
        <Pill tone={tone}>{text}</Pill>
        {p.verdict === "reject" ? (
          <form action={decide}>
            <Hidden fields={{ slug: p.id, verdict: "" }} />
            <button type="submit" style={button("quiet")}>Batalkan</button>
          </form>
        ) : null}
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 600 }}>{p.name}</span>
        {p.role ? <span style={{ fontSize: 12.5, color: MUTED }}>liputan menyebutnya “{p.role}”</span> : null}
      </div>
      <SamePerson person={p} eventId={0} figures={figures} />
      <SubPanel title="Atau: jadikan tokoh baru" note="Isian ini yang disimpan, apa adanya.">
        <AcceptCandidateForm slug={p.id} name={p.name} role={p.role} />
      </SubPanel>
    </div>
  );
}

/**
 * "Is this someone already tracked?" — one panel for every person on the page,
 * new name or existing figure alike. It leads with the figures that look like
 * the same person (nobody remembers the whole roster), and ends with a search
 * for any other. For a new name the answer is one click: it becomes that
 * figure's alias. Merging two tracked figures moves records, so it asks for
 * the tick; the suggested direction folds the figure with fewer records into
 * the one with more, and the record's own figure stays put.
 */
function SamePerson({ person: p, eventId, figures }: { person: NamedPerson; eventId: number; figures: FigureOption[] }) {
  const hints = likelyDuplicates(p, figures);
  const isName = p.kind === "candidate";
  const own = figures.find((f) => f.id === p.id)?.records ?? 0;
  // A one-word alias matches inside longer names too: "Prasetyo" would also
  // claim coverage of Budi Prasetyo.
  const word = p.name.trim().toLowerCase();
  const sharedWord = isName && !word.includes(" ")
    ? figures.filter((f) => f.name.toLowerCase().split(/\s+/).includes(word)).map((f) => f.name)
    : [];
  return (
    <div style={{ flexBasis: "100%", margin: "10px 0 4px", padding: "10px 12px", borderRadius: 6, background: "var(--color-cream-dark)", border: `1px dashed ${RULE}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MUTED, marginBottom: 6 }}>
        {hints.length ? "Mungkin orang yang sama" : "Orang yang sama dengan tokoh lain?"}
      </div>
      {sharedWord.length > 1 ? (
        <p style={{ fontSize: 12.5, color: "var(--color-clay)", margin: "0 0 8px", lineHeight: 1.5 }}>
          ⚠ “{p.name}” satu kata dan ada di nama {sharedWord.join(", ")}. Sebagai alias, ia akan ikut
          mencocokkan liputan semua tokoh itu. Lebih aman ditolak, kecuali memang hanya dipakai untuk satu orang.
        </p>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {hints.map(({ figure: f, why }) => (
          <li key={f.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 260px", minWidth: 0, fontSize: 13.5 }}>
              <strong style={{ fontFamily: "var(--font-serif)", fontSize: 15 }}>{f.name}</strong>
              <span style={{ color: MUTED }}>{f.role ? ` · ${f.role}` : ""} · {f.records} catatan · </span>
              <Link href={`/tokoh/${f.id}`} target="_blank" style={{ color: MUTED, fontSize: 12 }}>/tokoh/{f.id} ↗</Link>
              <span style={{ display: "block", fontSize: 12, color: MUTED }}>{why}</span>
            </span>
            <SameAction person={p} eventId={eventId} into={f.id} intoName={f.name}
              reverse={!isName && (p.owner === true || own > f.records)} counts={[own, f.records]} />
          </li>
        ))}
        {/* Anyone else on the roster: out of the way until asked for. */}
        <li style={{ paddingTop: hints.length ? 6 : 0, borderTop: hints.length ? `1px solid ${RULE}` : "none" }}>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 12.5, color: MUTED, fontWeight: 600 }}>
              Tokoh lainnya…
            </summary>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}>
              <SameAction person={p} eventId={eventId} figures={figures} />
            </div>
          </details>
        </li>
      </ul>
    </div>
  );
}

/**
 * The one action behind every "same person" choice. Given `into`, a button
 * for that figure; given `figures`, a search field over the whole roster.
 * `reverse` folds the other figure into this one instead.
 */
/** The second step of a destructive action: what it does, and the final button. */
const CONFIRM_PANEL: React.CSSProperties = {
  marginTop: 8, maxWidth: 460, background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 8,
  padding: "12px 14px", display: "grid", gap: 10, boxShadow: "0 4px 14px rgba(22, 19, 15, 0.08)",
};

function SameAction({ person: p, eventId, into, intoName, reverse = false, figures, counts }: {
  person: NamedPerson; eventId: number; into?: string; intoName?: string; reverse?: boolean; figures?: FigureOption[];
  /** Records of this figure and of `into`, for saying what a merge moves. */
  counts?: [number, number];
}) {
  const isName = p.kind === "candidate";
  const search = figures ? (
    <label style={{ ...label, flex: "1 1 260px" }}>
      Tokoh lain (ketik nama untuk mencari)
      <input
        name={isName ? "alias_of" : "into_id"}
        list={FIGURE_LIST}
        required
        autoComplete="off"
        placeholder="mis. Nusron Wahid"
        // Ids are [a-z0-9-] only, so they need no escaping in a pattern.
        pattern={figures.filter((f) => f.id !== p.id).map((f) => f.id).join("|")}
        title="Pilih tokoh dari daftar saran"
        style={input}
      />
    </label>
  ) : null;
  if (isName) {
    return (
      <form action={decide} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", flex: figures ? "1 1 100%" : undefined }}>
        <Hidden fields={into ? { slug: p.id, verdict: "alias", alias_of: into } : { slug: p.id, verdict: "alias" }} />
        {search}
        <button type="submit" style={button("ink")}>{into ? `Samakan dengan ${intoName}` : "Samakan"}</button>
      </form>
    );
  }
  // Two steps instead of a tick box: "Gabungkan…" opens what each direction
  // would move, and the choice is the final button. The suggested direction
  // (fewer records into more; the record's own figure stays) comes first.
  const fields: Record<string, string | number> = into
    ? { event_id: eventId, figure_id: p.id, into_id: into, confirm: 1 }
    : { event_id: eventId, figure_id: p.id, confirm: 1 };
  const other = intoName ?? "tokoh yang dipilih";
  const [mine, theirs] = counts ?? [undefined, undefined];
  const n = (x: number | undefined) => (x !== undefined ? ` (${x} catatan)` : "");
  const choices = [
    { value: "into", text: `Ya, ${p.name} ke ${other}`, detail: `Catatan ${p.name}${n(mine)} pindah ke ${other}; ${p.name} dinonaktifkan dan namanya jadi alias di sana.` },
    { value: "here", text: `Ya, ${other} ke ${p.name}`, detail: `Catatan ${other}${n(theirs)} pindah ke ${p.name}; ${other} dinonaktifkan dan namanya jadi alias di sini.` },
  ];
  if (reverse) choices.reverse();
  return (
    <form action={mergeFigures} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", flex: figures ? "1 1 100%" : undefined }}>
      {/* Enter in the search field submits with the form's first button. A
          disabled one first makes Enter do nothing, so a merge only ever
          happens through the confirmation below. */}
      <button type="submit" disabled hidden aria-hidden="true" tabIndex={-1} />
      <Hidden fields={fields} />
      {search}
      {/* Opens in the flow, below the button, so it is never cut off by the
          card's edge however narrow the column. */}
      <details style={{ flex: "1 1 100%" }}>
        <summary style={{ ...button("danger"), listStyle: "none", display: "inline-block" }}>Gabungkan…</summary>
        <div style={CONFIRM_PANEL}>
          <div style={{ fontSize: 12.5, color: MUTED }}>Ke arah mana? Tidak bisa dibatalkan dari sini.</div>
          {choices.map((c, i) => (
            <div key={c.value} style={{ display: "grid", gap: 4 }}>
              <button type="submit" name="direction" value={c.value} style={{ ...button(i === 0 ? "danger" : "quiet"), textAlign: "left" }}>
                {c.text}{i === 0 ? " (disarankan)" : ""}
              </button>
              <span style={{ fontSize: 12, color: "var(--color-mud)", lineHeight: 1.45 }}>{c.detail}</span>
            </div>
          ))}
        </div>
      </details>
    </form>
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

function LinkList({ item }: { item: Item }) {
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
        <LinkItem key={l.event_id} link={l} item={item} first={i === 0} />
      ))}
    </ul>
  );
}

function LinkItem({ link: l, item, first }: { link: LinkRow; item: Item; first: boolean }) {
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
        <Link href={`/kurasi/${l.event_id}`} style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: INK, lineHeight: 1.4 }}>
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
function FollowupList({ item }: { item: Item }) {
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
          <FollowupItem key={r.f.event_id} row={r.f} pair={r.pair} first={i === 0} />
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

function FollowupItem({ row: f, pair, first }: { row: FollowupRow; pair: { earlier_id: number; later_id: number }; first: boolean }) {
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
        <Link href={`/kurasi/${f.event_id}`} style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: INK, lineHeight: 1.4 }}>
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
function AddFollowup({ item, candidates, search }: { item: Item; candidates: FollowupCandidate[]; search: string }) {
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
                <Link href={`/kurasi/${c.event_id}`} style={{ fontFamily: "var(--font-serif)", fontSize: 15, color: INK, lineHeight: 1.4 }}>
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
      <form method="get" action={`/kurasi/${item.event_id}#lini`} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input name="cari" defaultValue={search} placeholder="Cari judul, misal “Virgo”" style={{ ...input, flex: "1 1 260px" }} aria-label="Cari judul" />
        <button type="submit" style={button("quiet")}>Cari</button>
        {search ? <Link href={`/kurasi/${item.event_id}#lini`} style={{ fontSize: 12.5, color: MUTED, alignSelf: "center" }}>Kembali ke saran</Link> : null}
      </form>
    </SubPanel>
  );
}

/** What the record shows as its owner's words, in the Isi card. */
function ShownQuote({ item }: { item: Item }) {
  const box = { marginTop: 14, paddingLeft: 12, borderLeft: `3px solid ${RULE}` } as const;
  if (item.quote) {
    const outlet = item.sources.find((s) => s.url === item.quote_url)?.source;
    return (
      <div style={box}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, marginBottom: 3 }}>
          Kutipan yang tampil{outlet ? ` · ${outlet}` : ""} · <a href="#kutipan" style={{ color: MUTED }}>ganti ↓</a>
        </div>
        <p style={{ fontFamily: "var(--font-serif)", fontSize: 15, lineHeight: 1.55, margin: 0, fontStyle: "italic" }}>“{item.quote}”</p>
      </div>
    );
  }
  return (
    <div style={{ ...box, fontSize: 12.5, color: MUTED }}>
      {item.quote === ""
        ? "Tanpa kutipan: kamu memilih tidak menampilkannya."
        : "Belum ada kutipan dari pemilik catatan."}{" "}
      <a href="#kutipan" style={{ color: MUTED }}>Lihat kutipan ↓</a>
    </div>
  );
}

/** Beyond this many, the rest fold away. */
const QUOTES_OPEN = 10;

/** "Name · title" for a picker's starting value. */
function figureLabel(figures: FigureOption[], id: string | null): string | null {
  const f = id ? figures.find((x) => x.id === id) : undefined;
  return f ? (f.role ? `${f.name} · ${f.role}` : f.name) : null;
}

function QuoteList({ item, figures }: { item: Item; figures: FigureOption[] }) {
  const isRecord = item.kind === "record";
  const footer = (
    <>
      {isRecord && item.figure_id ? <ShownQuoteChoice item={item} /> : null}
      <AddQuote item={item} figures={figures} />
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
      {rows.map((q, i) => <QuoteItem key={q.id} quote={q} item={item} figures={figures} first={offset + i === 0} />)}
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
    <details style={{ marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 12.5, color: MUTED }}>Tambah kutipan</summary>
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
              Tampilkan di catatan (bila tokohnya pemilik catatan)
            </label>
          ) : null}
          <button type="submit" style={button("ink")}>Tambah</button>
        </div>
      </form>
    </details>
  );
}

function QuoteItem({ quote: q, item, figures, first }: { quote: QuoteRow; item: Item; figures: FigureOption[]; first: boolean }) {
  const own = Boolean(item.figure_id) && q.figure_id === item.figure_id;
  const shown = Boolean(item.quote) && item.quote === q.quote;
  const title = q.figure_id ? figures.find((f) => f.id === q.figure_id)?.role : null;
  return (
    <li style={{ padding: "12px 0", borderTop: first ? "none" : `1px solid ${RULE}`, ...(shown ? { boxShadow: "inset 3px 0 0 var(--color-clay)", paddingLeft: 12 } : {}) }}>
      <p style={{ fontFamily: "var(--font-serif)", fontSize: 14.5, lineHeight: 1.55, margin: 0 }}>“{q.quote}”</p>
      <div style={{ fontSize: 12, color: MUTED, margin: "4px 0 8px" }}>
        — {q.speaker ?? "(tanpa nama)"}
        {q.source ? ` · ${q.source}` : ""}
        {q.url ? <> <a href={q.url} target="_blank" rel="noreferrer" aria-label="Buka di situs asli" style={{ color: MUTED, textDecoration: "none" }}>↗</a></> : null}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {q.figure_id ? (
          <Pill tone={own ? "ink" : "neutral"} title={q.assigned_by === "curator" ? "Dipilih kurator" : "Dicocokkan otomatis dari nama pembicara"}>
            {q.figure_name ?? q.figure_id}{q.assigned_by === "curator" ? " ✓" : ""}
          </Pill>
        ) : (
          <Pill tone="pending" title={q.assigned_by === "curator" ? "Kamu menandainya bukan tokoh yang dilacak" : "Pembicaranya tidak cocok dengan satu tokoh pun"}>
            {q.assigned_by === "curator" ? "bukan tokoh yang dilacak" : "belum ada tokoh"}
          </Pill>
        )}
        {q.figure_id ? (
          <span style={{ fontSize: 12, color: MUTED }}>
            {[title, own ? "pemilik catatan" : null, q.assigned_by === "curator" ? null : "dicocokkan otomatis"].filter(Boolean).join(" · ")}
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
    </li>
  );
}
