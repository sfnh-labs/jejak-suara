import Link from "next/link";
import { notFound } from "next/navigation";
import { REASONS, getFigureOptions, getFollowupCandidates, getItem, getReading, positionTitle, reasonLabel, type FigureOption, type FigureRef, type FollowupCandidate, type FollowupRow, type Position, type Profile, type Item, type LinkRow, type NamedPerson } from "@/lib/curation";
import { decide } from "../kandidat/actions";
import { AcceptCandidateForm } from "../AcceptCandidateForm";
import { ArticleReader, type ReaderTerm } from "../ArticleReader";
import { addFollowup, curate, editFigure, mergeFigures, relateFigure, ruleFollowup, ruleLink } from "../actions";
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
  const [item, figures] = await Promise.all([getItem(eventId), getFigureOptions()]);
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
    ...(isRecord ? [{ id: "pelaku", title: "Pelaku" }] : []),
    { id: "nama", title: isRecord ? "Disebut dalam liputan" : "Tokoh terkait" },
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
            {outlets <= 1 ? <Pill tone="danger">⚠ satu sumber</Pill> : null}
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

        <VerdictBar item={item} sections={sections} missing={perlu} />
        <FigureOptions figures={figures} />

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

        {isRecord ? (
          <Card
            n={n("pelaku")}
            id="pelaku"
            title="Pelaku"
            note="Tokoh pemilik catatan ini. Perubahan nama, jabatan, dan alias berlaku di seluruh situs; alias juga dipakai pipeline untuk mengenali artikel berikutnya."
          >
            {item.owner ? (
              <OwnerEditor figure={item.owner} eventId={item.event_id} figures={figures} />
            ) : (
              <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Tokoh {item.figure_id} tidak ada di daftar.</p>
            )}
          </Card>
        ) : null}

        <Card
          n={n("nama")}
          id="nama"
          title={isRecord ? "Disebut dalam liputan" : "Tokoh terkait"}
          count={item.named.length}
          note={
            isRecord
              ? "Orang lain yang namanya muncul di artikel catatan ini. Tokoh yang sudah dilacak bisa disunting; nama baru bisa langsung diterima atau ditolak."
              : "Tokoh yang muncul di liputan peristiwa ini. Coret yang salah cocok, misalnya karena alias yang juga nama orang lain."
          }
        >
          <NamedList item={item} figures={figures} />
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
          <Pill tone="pending">menunggu pipeline</Pill>{" "}
          artinya keputusan sudah berlaku di situs, tetapi belum disalin ke basis data pipeline. Itu terjadi
          otomatis pada putaran malam (<code>scripts/apply_curation.py</code>); sampai saat itu artikel baru
          masih dicocokkan dengan data lama.
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
      style={{ background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 8, marginTop: 18, scrollMarginTop: 96, overflow: "hidden" }}
    >
      <header style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 18px", background: "var(--color-cream-dark)", borderBottom: `1px solid ${RULE}` }}>
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

const PENDING_HINT = "Sudah berlaku di situs. Pipeline menyalinnya pada putaran malam berikutnya.";

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
}: {
  item: Item;
  sections: { id: string; title: string }[];
  missing?: string;
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
  const pending = "edit_pending" in figure && figure.edit_pending;
  const active = "active" in figure ? figure.active : true;
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
      {pending ? <Pill tone="pending" title={PENDING_HINT}>disunting · menunggu pipeline</Pill> : null}
    </span>
  );
}

/**
 * The fields every figure editor shares: name, offices, aliases, active. The
 * record owner's form also carries the rest of the CV, since offices and CV
 * are one list: what is typed here is what the CV tab shows.
 */
function FigureForm({ figure, eventId }: { figure: FigureRef | NamedPerson; eventId: number }) {
  const profile = "profile" in figure ? figure.profile : null;
  const active = "active" in figure ? figure.active : true;
  return (
    <form action={editFigure} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
      <Hidden fields={{ event_id: eventId, figure_id: figure.id }} />
      <label style={label}>
        Nama tampil
        <input name="name" defaultValue={figure.name} required style={input} />
      </label>
      <Positions figure={figure} />
      {profile && "cv_checked_at" in figure ? <CvFields profile={profile} checkedAt={figure.cv_checked_at} figureId={figure.id} /> : null}
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
      <label style={{ ...label, display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--color-mud)" }}>
        <input type="checkbox" name="active" value="1" defaultChecked={active} />
        Aktif (hapus centang untuk nama yang salah tambang)
      </label>
      <div style={{ justifySelf: "end" }}>
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
      <label style={label}>
        Ringkasan
        <textarea name="bio" rows={3} defaultValue={profile.bio} style={{ ...input, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />
      </label>
      <div style={two}>
        <span style={head}>Fakta</span><span style={head}>Isi</span>
        {facts.map((f, i) => (
          <FactRow key={i} a={["fact_label", f.label, "mis. Lahir"]} b={["fact_value", f.value, "mis. Kudus, 12 Oktober 1973"]} style={cell} hint={i === 0} />
        ))}
      </div>
      <div style={two}>
        <span style={head}>Tahun</span><span style={head}>Pendidikan</span>
        {education.map((e, i) => (
          <FactRow key={i} a={["edu_year", e.year ?? "", "1997"]} b={["edu_detail", e.detail, "mis. S1 Filsafat, UGM"]} style={cell} hint={i === 0} />
        ))}
      </div>
      <div style={two}>
        <span style={head}>Sumber</span><span style={head}>URL</span>
        {sources.map((s, i) => (
          <FactRow key={i} a={["src_label", s.label, "mis. Wikipedia"]} b={["src_url", s.url, "https://…"]} style={cell} hint={i === 0} />
        ))}
      </div>
    </fieldset>
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
      <input name="pos_org" defaultValue={p.org} placeholder={main ? "mis. MPR RI" : ""} style={cell} aria-label="Lembaga" />
      <input name="pos_period" defaultValue={p.period} placeholder={main ? "2024–sekarang" : ""} style={cell} aria-label="Periode" />
    </>
  );
}

/** The record's own figure: always open, editing and merging in separate boxes. */
function OwnerEditor({ figure, eventId, figures }: { figure: FigureRef; eventId: number; figures: FigureOption[] }) {
  return (
    <>
      <FigureHeading figure={figure} />
      <SubPanel title="Data tokoh">
        <FigureForm figure={figure} eventId={eventId} />
      </SubPanel>
      {figure.active ? <MergeForm figure={figure} eventId={eventId} figures={figures} /> : null}
    </>
  );
}

/**
 * "This is the same person as …". Moves every record of this figure to the
 * chosen one, adds this figure's names to its aliases and retires this one.
 */
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
        <option key={f.id} value={f.id} label={`${f.name}${f.role ? ` · ${f.role}` : ""}`}>
          {f.name}{f.role ? ` · ${f.role}` : ""}
        </option>
      ))}
    </datalist>
  );
}

function MergeForm({ figure, eventId, figures }: { figure: FigureRef | NamedPerson; eventId: number; figures: FigureOption[] }) {
  return (
    <SubPanel
      title="Tokoh ganda? Gabungkan"
      tone="danger"
      note={`Semua catatan ${figure.name} pindah ke tokoh yang dipilih, namanya menjadi alias di sana, dan ${figure.name} dinonaktifkan. Tidak bisa dibatalkan dari sini.`}
    >
      <form action={mergeFigures} style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Hidden fields={{ event_id: eventId, figure_id: figure.id }} />
        <label style={{ ...label, flex: "1 1 280px" }}>
          Gabungkan ke (ketik nama untuk mencari)
          <input
            name="into_id"
            list={FIGURE_LIST}
            required
            autoComplete="off"
            placeholder="mis. Muhaimin"
            // Ids are [a-z0-9-] only, so they need no escaping in a pattern.
            pattern={figures.filter((f) => f.id !== figure.id).map((f) => f.id).join("|")}
            title="Pilih tokoh dari daftar saran"
            style={input}
          />
        </label>
        <label style={{ ...label, display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--color-mud)" }}>
          <input type="checkbox" name="confirm" value="1" required />
          Ya, gabungkan
        </label>
        <button type="submit" style={button("danger")}>Gabungkan</button>
      </form>
    </SubPanel>
  );
}

function NamedList({ item, figures }: { item: Item; figures: FigureOption[] }) {
  if (item.named.length === 0) {
    return <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Tidak ada nama lain yang dikenali.</p>;
  }
  const isRecord = item.kind === "record";
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {item.named.map((p, i) => (
        // Each name is addressable, so the queue can send a curator straight
        // to it: /kurasi/<record>#nama-<slug>.
        <li key={`${p.kind}-${p.id}`} id={`nama-${p.id}`} style={{ scrollMarginTop: 80, padding: "14px 0", borderTop: i ? `1px solid ${RULE}` : "none" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
            <Pill tone={p.kind === "candidate" ? "pending" : "neutral"}>{p.kind === "candidate" ? "Nama baru" : "Tokoh terlacak"}</Pill>
            <span style={{ fontSize: 11.5, color: MUTED }}>disebut di {p.articles} artikel</span>
            {p.struck ? <Pill tone="danger">dicoret dari peristiwa</Pill> : null}
          </div>
          {p.kind === "figure" ? (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", opacity: p.struck ? 0.6 : 1 }}>
              <details style={{ flex: "1 1 420px", minWidth: 0 }}>
                <summary style={{ cursor: "pointer" }}>
                  <FigureHeading figure={p} />
                  <span style={{ fontSize: 12, color: MUTED, marginLeft: 8 }}>sunting ▾</span>
                </summary>
                <SubPanel title="Data tokoh">
                  <FigureForm figure={p} eventId={item.event_id} />
                </SubPanel>
                <MergeForm figure={p} eventId={item.event_id} figures={figures} />
              </details>
              {!isRecord ? (
                <form action={relateFigure}>
                  <Hidden fields={{ event_id: item.event_id, figure_id: p.id, struck: p.struck ? "0" : "1" }} />
                  <button type="submit" style={button("quiet")}>{p.struck ? "Pulihkan" : "Coret dari peristiwa"}</button>
                </form>
              ) : null}
            </div>
          ) : (
            <CandidateRow person={p} />
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
function CandidateRow({ person: p }: { person: NamedPerson }) {
  if (p.verdict) {
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 600 }}>{p.name}</span>
        <Pill tone={p.verdict === "promote" ? "accept" : "danger"}>{p.verdict === "promote" ? "diterima" : "ditolak"}</Pill>
        <Pill tone="pending" title={PENDING_HINT}>menunggu pipeline</Pill>
        <form action={decide}>
          <Hidden fields={{ slug: p.id, verdict: "" }} />
          <button type="submit" style={button("quiet")}>Batalkan</button>
        </form>
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 600 }}>{p.name}</span>
        {p.role ? <span style={{ fontSize: 12.5, color: MUTED }}>liputan menyebutnya “{p.role}”</span> : null}
      </div>
      <SubPanel title="Jadikan tokoh" note="Isian ini yang disimpan, apa adanya.">
        <AcceptCandidateForm slug={p.id} name={p.name} role={p.role} />
      </SubPanel>
    </div>
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
