import Link from "next/link";
import { KIND_LABEL, NOT_TRACKED, type Confidence, type Point } from "@/lib/curationPoints";
import { answerCurationPoint, markCurationPointWrong, undoCurationPoint } from "./actions";
import { FigurePicker } from "./FigurePicker";
import type { FigureOption } from "@/lib/curation";
import { ACCEPT, INK, MUTED, RULE, button, day, input } from "./ui";

/**
 * A catatan's curation points: each open one as a card with the paragraph
 * that raised it, what the pipeline thinks, and how often the curator agreed
 * with it on points like it; answered ones as a line each, with "Batalkan",
 * or "Salah" on an auto answer.
 * Plain forms, as everywhere in /kurasi: no client script needed to answer.
 */
/** The page with an article open in the reading pane, at the point's paragraph. */
type ReadHref = (articleId: string, pointId: number) => string;
/** The page with a side panel open (peristiwa:12, catatan:34, tokoh:slug). */
type OpenHref = (panel: string) => string;

/** An event a peristiwa or lini point can be corrected to. */
export interface EventChoice {
  event_id: number;
  title: string | null;
  event_date: string | null;
  /** For lini: whether it comes before this one. */
  before?: boolean;
}

export function PointList({
  points,
  figures,
  nearby,
  liniChoices,
  listId,
  readHref,
  open,
  liniPanel,
}: {
  points: Point[];
  /** The roster, to name each figure a speaker answer would write to with its office. */
  figures: FigureOption[];
  /** Peristiwa near this record, to correct a peristiwa point to. */
  nearby: EventChoice[];
  /** Events this one may continue, to correct a lini point to. */
  liniChoices: EventChoice[];
  /** The roster <datalist> the figure picker reads. */
  listId: string;
  readHref: ReadHref;
  open: OpenHref;
  /** What the other end of a lini cerita point is: catatan on a record, peristiwa on a peristiwa. */
  liniPanel: "catatan" | "peristiwa";
}) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {points.map((p, i) => (
        <li key={p.id} style={{ borderTop: i ? `1px solid ${RULE}` : "none", padding: i ? "14px 0 0" : 0, marginTop: i ? 14 : 0 }}>
          {p.status === "open" || p.status === "lewati"
            ? <PointCard point={p} figures={figures} nearby={nearby} liniChoices={liniChoices} listId={listId} readHref={readHref} open={open} liniPanel={liniPanel} />
            : <PointDone point={p} />}
        </li>
      ))}
    </ol>
  );
}

function PointHidden({ id, answer }: { id: number; answer?: string }) {
  return (
    <>
      <input type="hidden" name="point_id" value={id} />
      {answer ? <input type="hidden" name="answer" value={answer} /> : null}
    </>
  );
}

function PointCard({ point: p, figures, nearby, liniChoices, listId, readHref, open, liniPanel }: {
  point: Point; figures: FigureOption[]; nearby: EventChoice[]; liniChoices: EventChoice[]; listId: string; readHref: ReadHref; open: OpenHref; liniPanel: "catatan" | "peristiwa";
}) {
  const subject = subjectPanel(p, liniPanel);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 7px", borderRadius: 2, background: INK, color: "var(--color-cream)" }}>
          {KIND_LABEL[p.kind]}
        </span>
        {p.status === "lewati" ? <span style={{ fontSize: 12, color: MUTED }}>dilewati</span> : null}
        {p.spot_check ? (
          <span title="Jenis ini dijawab otomatis; yang ini sengaja ditanyakan untuk memeriksanya. Jawaban “Bukan” mematikan otomatisnya." style={{ fontSize: 12, fontWeight: 600, color: "#7a5a12" }}>
            cek acak
          </span>
        ) : null}
        {p.kind === "pembicara" && p.group_size > 1 ? (
          <span style={{ fontSize: 12, fontWeight: 600, color: "#7a5a12" }}>
            {p.group_size} kutipan{p.proposal.events && p.proposal.events > 1 ? ` di ${p.proposal.events} catatan` : ""} · satu jawaban untuk semua
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <Meter confidence={p.confidence} />
      </div>

      {p.paragraph ? (
        <blockquote style={{ margin: 0, padding: "1px 0 1px 14px", borderLeft: `3px solid ${RULE}`, fontFamily: "var(--font-serif)", fontSize: 15, lineHeight: 1.6, color: "var(--color-mud)" }}>
          {p.article_id ? (
            <Link href={readHref(p.article_id, p.id)} scroll={false} style={{ display: "block", fontFamily: "var(--font-sans)", fontSize: 11.5, fontWeight: 700, color: MUTED, marginBottom: 2 }}>
              {[p.source, p.published_at ? day(p.published_at) : null].filter(Boolean).join(" · ")}
              {" · "}<span style={{ fontWeight: 400, textDecoration: "underline" }}>baca beritanya</span>
            </Link>
          ) : null}
          <Highlighted text={p.paragraph} start={p.hl_start} end={p.hl_end} />
        </blockquote>
      ) : (
        <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>Paragrafnya tidak ditemukan di teks artikel.</p>
      )}

      {p.kind === "pembicara" ? (
        <SpeakerChoice point={p} figures={figures} listId={listId} open={open} />
      ) : (
        <>
          <div style={{ display: "grid", gap: 3 }}>
            <div style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 500, lineHeight: 1.35, color: INK }}>
              {p.proposal.claim}
              {subject ? (
                <>
                  {" "}
                  <Link href={open(subject.panel)} scroll={false} style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 400, color: MUTED, whiteSpace: "nowrap" }}>
                    {subject.label} ›
                  </Link>
                </>
              ) : null}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--color-mud)" }}><strong style={{ color: INK }}>Jika Ya:</strong> {p.effect}</div>
            <div style={{ fontSize: 12.5, color: "var(--color-mud)" }}><strong style={{ color: INK }}>Jika Bukan:</strong> {noEffect(p)}</div>
            <div style={{ fontSize: 12, color: MUTED }}>{basis(p)}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <form action={answerCurationPoint}>
              <PointHidden id={p.id} answer="ya" />
              <button type="submit" style={{ ...button("accept"), padding: "8px 20px" }}>{p.kind === "pelaku" ? `Ya, ${p.proposal.name} pelaku` : "Ya"}</button>
            </form>
            <form action={answerCurationPoint}>
              <PointHidden id={p.id} answer="bukan" />
              <button type="submit" style={{ ...button("quiet"), padding: "8px 20px", color: "var(--color-clay)", borderColor: "var(--color-clay)" }}>{p.kind === "pelaku" ? "Bukan, hanya disebut" : "Bukan"}</button>
            </form>
            <span style={{ flex: 1 }} />
            <SkipForm point={p} />
          </div>
          <Correction point={p} nearby={nearby} liniChoices={liniChoices} listId={listId} liniPanel={liniPanel} />
        </>
      )}
    </div>
  );
}

/**
 * "Bukan, tapi …": the right answer instead of the proposed one, saved in the
 * same step — another peristiwa, another event in the lini, another figure as
 * Pelaku. Each says what it saves.
 */
function Correction({ point: p, nearby, liniChoices, listId, liniPanel }: {
  point: Point; nearby: EventChoice[]; liniChoices: EventChoice[]; listId: string; liniPanel: "catatan" | "peristiwa";
}) {
  const x = p.proposal;
  const box = { display: "grid", gap: 8, padding: "10px 12px", border: `1px dashed var(--color-parchment-dark)`, borderRadius: 2 } as const;
  const head = (t: string) => <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>{t}</span>;
  const saves = (t: React.ReactNode) => <span style={{ fontSize: 12, color: MUTED }}>{t}</span>;
  const go = (label: string) => <button type="submit" style={{ ...button("ink"), minHeight: 34, padding: "6px 12px" }}>{label}</button>;
  const option = (e: EventChoice) => (
    <option key={e.event_id} value={e.event_id}>
      {day(e.event_date)}{e.before === undefined ? "" : e.before ? " · sebelum ini" : " · sesudah ini"} · {e.title ?? `#${e.event_id}`}
    </option>
  );

  if (p.kind === "peristiwa") {
    const choices = nearby.filter((e) => e.event_id !== x.peristiwa_id);
    return (
      <form action={answerCurationPoint} style={box}>
        <PointHidden id={p.id} answer="koreksi" />
        {head("Bukan, catatan ini bagian dari peristiwa lain")}
        {choices.length ? (
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select name="event_target" required defaultValue="" aria-label="Peristiwa yang benar" style={{ ...input, flex: "1 1 320px" }}>
              <option value="" disabled>Pilih peristiwa dalam ±7 hari…</option>
              {choices.map(option)}
            </select>
            {go("Tautkan ke ini")}
          </span>
        ) : saves("Tidak ada peristiwa lain dalam ±7 hari. Jawab “Bukan”, lalu tautkan lewat “Tautkan” di Relasi.")}
        {choices.length ? saves(<>Disimpan: tautan ke “{x.title}” ditolak; catatan ini ditautkan ke peristiwa yang kamu pilih dan tampil di situs.</>) : null}
      </form>
    );
  }
  if (p.kind === "lini") {
    const other = x.earlier_id === p.event_id ? x.later_id : x.earlier_id;
    const choices = liniChoices.filter((e) => e.event_id !== other);
    const what = liniPanel === "catatan" ? "catatan" : "peristiwa";
    return (
      <form action={answerCurationPoint} style={box}>
        <PointHidden id={p.id} answer="koreksi" />
        {head(`Bukan, ini tersambung dengan ${what} lain`)}
        {choices.length ? (
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select name="event_target" required defaultValue="" aria-label="Yang benar" style={{ ...input, flex: "1 1 320px" }}>
              <option value="" disabled>Pilih {what} (±60 hari, kata khas yang sama)…</option>
              {choices.map(option)}
            </select>
            {go("Sambungkan ke ini")}
          </span>
        ) : saves(<>Tidak ada saran lain. Jawab “Bukan”, lalu cari lewat “Sambungkan” di Relasi.</>)}
        {choices.length ? saves(<>Disimpan: sambungan ke “{x.title}” ditolak; yang kamu pilih tersambung dalam lini cerita, urut menurut tanggal.</>) : null}
      </form>
    );
  }
  if (p.kind === "pelaku") {
    return (
      <form action={answerCurationPoint} style={box}>
        <PointHidden id={p.id} answer="koreksi" />
        {head("Bukan, pelakunya tokoh lain")}
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <FigurePicker listId={listId} required placeholder="Cari tokoh yang sebenarnya pelaku" />
          {go("Jadikan pelaku")}
        </span>
        {saves(<>Disimpan: {x.name} tetap di Disebut; tokoh yang kamu pilih masuk Pelaku catatan ini, di samping yang sudah ada.</>)}
      </form>
    );
  }
  return null;
}

/** "Lewati, belum yakin": left for later, asked again next time. */
function SkipForm({ point: p }: { point: Point }) {
  if (p.status !== "open") return null;
  return (
    <form action={answerCurationPoint}>
      <PointHidden id={p.id} answer="lewati" />
      <button type="submit" style={{ border: "none", background: "none", padding: "8px 2px", fontSize: 12.5, color: MUTED, textDecoration: "underline", cursor: "pointer" }}>
        Lewati, belum yakin
      </button>
    </form>
  );
}

/** What a "Bukan" leaves behind, in a sentence. */
function noEffect(p: Point): string {
  switch (p.kind) {
    case "peristiwa":
      return "usulan tautan ditolak dan tidak ditanyakan lagi; tautkan peristiwa yang benar lewat “Tautkan” di Relasi.";
    case "lini":
      return "usulan lini ditolak dan tidak ditanyakan lagi; sambungkan yang benar lewat “Sambungkan” di Relasi.";
    case "pelaku":
      return `${p.proposal.name} tetap di Disebut; pelakunya tidak berubah.`;
    default:
      return "tidak ada yang berubah.";
  }
}

/**
 * Who said a quote, as a choice rather than Ya/Bukan: each option names the
 * figure it writes the quotes to, with its office, and what the answer does.
 * The pipeline's guess comes first; then the other figures that fit, any
 * figure from the roster, a figure created here, no tracked figure at all,
 * and "not them, but I don't know who".
 */
function SpeakerChoice({ point: p, figures, listId, open }: { point: Point; figures: FigureOption[]; listId: string; open: OpenHref }) {
  const x = p.proposal;
  const n = p.group_size;
  const quotes = `${n} kutipan “${x.speaker}”`;
  const later = `, begitu juga “${x.speaker}” berikutnya${x.scope ? " di catatan sejenis" : ""}`;
  const roleOf = (id: string) => figures.find((f) => f.id === id)?.title || null;
  const guess = x.figure_id ? { id: x.figure_id, name: x.name ?? x.figure_id, role: roleOf(x.figure_id) } : null;
  // The likeliest few that also fit; anyone else is a search away, below them.
  const others = (x.candidates ?? []).filter((c) => c.id !== x.figure_id).slice(0, 3).map((c) => ({ ...c, role: roleOf(c.id) }));
  const row = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "4px 12px", alignItems: "center", padding: "11px 0", borderTop: `1px solid ${RULE}` } as const;
  const who = (name: string, role: string | null) => (
    <span style={{ fontSize: 14, fontWeight: 700, color: INK }}>
      {name}{role ? <span style={{ fontWeight: 400, color: MUTED }}> – {role}</span> : null}
    </span>
  );
  const saves = (text: React.ReactNode) => <span style={{ gridColumn: "1 / -1", fontSize: 12, color: MUTED }}>{text}</span>;
  const pick = (label: string, primary = false) => (
    <button type="submit" style={{ ...button(primary ? "accept" : "quiet"), minHeight: 32, padding: "5px 12px" }}>{label}</button>
  );

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 500, lineHeight: 1.3, color: INK }}>
        Siapa “{x.speaker}” di sini?
      </div>
      <div style={{ fontSize: 12, color: MUTED }}>
        Tebakan pipeline: {guess ? <strong style={{ color: INK }}>{guess.name}</strong> : "bukan tokoh yang dilacak"}. {basis(p)} Jawabanmu berlaku untuk {n} kutipan sekaligus.
      </div>

      <div style={{ marginTop: 4 }}>
        {guess ? (
          <form action={answerCurationPoint} style={row}>
            <PointHidden id={p.id} answer="ya" />
            <span>
              {who(guess.name, guess.role)}{" "}
              <Link href={open(`tokoh:${guess.id}`)} scroll={false} style={{ fontSize: 12, color: MUTED }}>lihat tokohnya ›</Link>
            </span>
            {pick(`Ya, ${guess.name}`, true)}
            {saves(<>Disimpan: {quotes} ditulis atas nama tokoh <code>{guess.id}</code>{later}.</>)}
          </form>
        ) : null}

        {others.map((c) => (
          <form key={c.id} action={answerCurationPoint} style={row}>
            <PointHidden id={p.id} answer="koreksi" />
            <input type="hidden" name="figure_id" value={c.id} />
            <span>
              {who(c.name, c.role)}{" "}
              <Link href={open(`tokoh:${c.id}`)} scroll={false} style={{ fontSize: 12, color: MUTED }}>lihat tokohnya ›</Link>
            </span>
            {pick(`Ini ${c.name}`)}
            {saves(<>Disimpan: {quotes} ditulis atas nama tokoh <code>{c.id}</code>{later}.</>)}
          </form>
        ))}

        <form action={answerCurationPoint} style={row}>
          <PointHidden id={p.id} answer="koreksi" />
          <span style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>Tokoh lain yang sudah dilacak</span>
            <FigurePicker listId={listId} required placeholder="Cari nama, alias, atau jabatan" />
          </span>
          {pick("Pilih tokoh ini")}
          {saves(<>Disimpan: {quotes} ditulis atas nama tokoh yang kamu pilih{later}.</>)}
        </form>

        <form action={answerCurationPoint} style={row}>
          <PointHidden id={p.id} answer="koreksi" />
          <span style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>Tokoh baru, belum dilacak</span>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input name="new_name" required maxLength={200} defaultValue={x.speaker ?? ""} aria-label="Nama lengkap tokoh baru" placeholder="Nama lengkap" style={{ ...input, flex: "1 1 180px" }} />
              <input name="new_role" maxLength={300} aria-label="Jabatan tokoh baru" placeholder="Jabatan, mis. Wakil Kepala" style={{ ...input, flex: "1 1 160px" }} />
              <input name="new_org" maxLength={300} aria-label="Organisasi tokoh baru" placeholder="Organisasi, mis. Badan Gizi Nasional" style={{ ...input, flex: "1 1 200px" }} />
            </span>
          </span>
          {pick("Buat & pilih")}
          {saves(<>Disimpan: tokoh baru dibuat di daftar Tokoh (lengkapi CV-nya nanti), lalu {quotes} ditulis atas namanya{later}. Tulis nama lengkap, bukan “{x.speaker}” saja.</>)}
        </form>

        <form action={answerCurationPoint} style={row}>
          <PointHidden id={p.id} answer={guess ? "koreksi" : "ya"} />
          {guess ? <input type="hidden" name="figure_id" value={NOT_TRACKED} /> : null}
          <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>Bukan tokoh yang dilacak <span style={{ fontWeight: 400, color: MUTED }}>· warga, wartawan, juru bicara tanpa nama</span></span>
          {pick("Bukan tokoh", !guess)}
          {saves(<>Disimpan: {quotes} tetap tanpa tokoh dan tidak ditanyakan lagi{later.replace(", begitu juga", "; begitu juga")}.</>)}
        </form>

        {guess ? (
          <form action={answerCurationPoint} style={row}>
            <PointHidden id={p.id} answer="bukan" />
            <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>Bukan {guess.name}, tapi belum tahu siapa</span>
            {pick("Bukan dia")}
            {saves(<>Disimpan: tidak ada yang berubah; kutipannya tetap menunggu tokohnya.</>)}
          </form>
        ) : null}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}><SkipForm point={p} /></div>
    </div>
  );
}

/** What the point is about, to read in the side panel before answering. */
function subjectPanel(p: Point, liniPanel: "catatan" | "peristiwa"): { panel: string; label: string } | null {
  const x = p.proposal;
  if (p.kind === "peristiwa" && x.peristiwa_id) return { panel: `peristiwa:${x.peristiwa_id}`, label: "lihat peristiwanya" };
  if (p.kind === "lini" && x.earlier_id && x.later_id) {
    const other = x.later_id === p.event_id ? x.earlier_id : x.later_id;
    return { panel: `${liniPanel}:${other}`, label: liniPanel === "catatan" ? "lihat catatannya" : "lihat peristiwanya" };
  }
  if ((p.kind === "pelaku" || p.kind === "pembicara") && x.figure_id) return { panel: `tokoh:${x.figure_id}`, label: "lihat tokohnya" };
  return null;
}

function PointDone({ point: p }: { point: Point }) {
  const look = {
    ya: ["Ya", ACCEPT],
    bukan: ["Bukan", "var(--color-clay)"],
    koreksi: ["Dikoreksi", "#7a5a12"],
    auto: ["Otomatis", MUTED],
    auto_wrong: ["Otomatis · salah", "var(--color-clay)"],
  }[p.status as "ya" | "bukan" | "koreksi" | "auto" | "auto_wrong"] ?? [p.status, MUTED];
  // After a "Bukan" the right link is made where links are made.
  const fixAt = p.status === "bukan" ? (p.kind === "peristiwa" ? "#tautan" : p.kind === "lini" ? "#lini" : null) : null;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 7px", borderRadius: 2, border: `1px solid ${look[1]}`, color: look[1], whiteSpace: "nowrap" }}>{look[0]}</span>
      <span style={{ flex: "1 1 260px", minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, color: INK }}>
          {p.proposal.claim}{p.correction ? ` → ${p.correction}` : ""}
        </span>
        <span style={{ display: "block", fontSize: 12, color: MUTED }}>
          {KIND_LABEL[p.kind]}{p.answered_at ? ` · ${day(p.answered_at)}` : ""}
          {fixAt ? <> · <a href={fixAt} style={{ color: MUTED }}>tautkan yang benar di bawah</a></> : null}
        </span>
      </span>
      {p.status === "auto" ? (
        <form action={markCurationPointWrong}>
          <PointHidden id={p.id} />
          <button type="submit" title="Kembalikan dan putuskan sebaliknya; dihitung melawan jawaban otomatis jenis ini" style={{ ...button("quiet"), padding: "4px 12px", fontSize: 12.5, color: "var(--color-clay)", borderColor: "var(--color-clay)" }}>Salah</button>
        </form>
      ) : p.answered_by === "curator" && p.status !== "auto_wrong" ? (
        <form action={undoCurationPoint}>
          <PointHidden id={p.id} />
          <button type="submit" style={{ border: "none", background: "none", padding: "4px 0", fontSize: 12.5, color: MUTED, textDecoration: "underline", cursor: "pointer" }}>Batalkan</button>
        </form>
      ) : null}
    </div>
  );
}

/** Context kept either side of the highlight; the reader has the whole paragraph. */
const CONTEXT = 110;

/** The highlighted words with a sentence or so around them, cut at word boundaries. */
function Highlighted({ text, start, end }: { text: string; start: number | null; end: number | null }) {
  if (start === null || end === null || end <= start) return <>{tail(text, CONTEXT * 2)}</>;
  return (
    <>
      {lead(text.slice(0, start), CONTEXT)}
      <mark style={{ background: "#f3dfa6", color: INK, padding: "1px 2px", borderRadius: 2 }}>{text.slice(start, end)}</mark>
      {tail(text.slice(end), CONTEXT)}
    </>
  );
}

/** The last ~n characters of text, starting on a word, with … if cut. */
function lead(text: string, n: number): string {
  if (text.length <= n) return text;
  const from = text.indexOf(" ", text.length - n);
  return `… ${text.slice(from === -1 ? text.length - n : from + 1)}`;
}

/** The first ~n characters of text, ending on a word, with … if cut. */
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const to = text.lastIndexOf(" ", n);
  return `${text.slice(0, to > 0 ? to : n)} …`;
}

/** Agreement so far for this kind and band; before any answer, says so instead of guessing a number. */
function Meter({ confidence: c }: { confidence: Confidence }) {
  // Before any answer the bar stays empty and says so, rather than guessing a number.
  const pct = c.value === null ? null : Math.round(c.value * 100);
  const color = pct === null ? RULE : pct >= 90 ? ACCEPT : pct >= 70 ? "#b08a2e" : "var(--color-clay)";
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 7 }} title={pct === null ? "Belum ada jawaban untuk poin sejenis" : `Kamu setuju ${c.agreed} dari ${c.answered} kali`}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED }}>Yakin</span>
      <span aria-hidden style={{ width: 72, height: 6, borderRadius: 3, background: RULE, overflow: "hidden", display: "block" }}>
        <span style={{ display: "block", height: "100%", width: `${pct ?? 0}%`, background: color }} />
      </span>
      <strong style={{ fontSize: 13.5, color: pct === null ? MUTED : INK }}>{pct === null ? "–" : `${pct}%`}</strong>
    </span>
  );
}

function basis(p: Point): string {
  const c = p.confidence;
  const band = p.bucket ? ` (pita “${p.bucket}”)` : "";
  if (!c.answered) return `Belum ada jawaban untuk poin sejenis${band}; tiap jawabanmu mulai mengukurnya.`;
  return `Kamu setuju ${c.agreed} dari ${c.answered} kali untuk poin sejenis${band}.`;
}
