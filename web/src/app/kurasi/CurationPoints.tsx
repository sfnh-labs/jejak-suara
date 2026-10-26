import Link from "next/link";
import { KIND_LABEL, type Confidence, type Point } from "@/lib/curationPoints";
import { answerCurationPoint, markCurationPointWrong, undoCurationPoint } from "./actions";
import { FigurePicker } from "./FigurePicker";
import { ACCEPT, INK, MUTED, RULE, button, day } from "./ui";

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

export function PointList({
  points,
  listId,
  readHref,
  open,
  liniPanel,
}: {
  points: Point[];
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
            ? <PointCard point={p} listId={listId} readHref={readHref} open={open} liniPanel={liniPanel} />
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

function PointCard({ point: p, listId, readHref, open, liniPanel }: {
  point: Point; listId: string; readHref: ReadHref; open: OpenHref; liniPanel: "catatan" | "peristiwa";
}) {
  const subject = subjectPanel(p, liniPanel);
  const speakerNone = p.kind === "pembicara" && !p.proposal.figure_id;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 999, background: INK, color: "var(--color-cream)" }}>
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
        <div style={{ fontSize: 12, color: MUTED }}>{basis(p)}</div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <form action={answerCurationPoint}>
          <PointHidden id={p.id} answer="ya" />
          <button type="submit" style={{ ...button("accept"), padding: "8px 20px", fontSize: 13.5 }}>Ya</button>
        </form>
        {speakerNone ? null : (
          <form action={answerCurationPoint}>
            <PointHidden id={p.id} answer="bukan" />
            <button type="submit" style={{ ...button("quiet"), padding: "8px 20px", fontSize: 13.5, color: "var(--color-clay)", borderColor: "var(--color-clay)" }}>Bukan</button>
          </form>
        )}
        {p.kind === "pembicara" ? <SpeakerCorrection point={p} listId={listId} /> : null}
        <span style={{ flex: 1 }} />
        {p.status === "open" ? (
          <form action={answerCurationPoint}>
            <PointHidden id={p.id} answer="lewati" />
            <button type="submit" style={{ border: "none", background: "none", padding: "8px 2px", fontSize: 12.5, color: MUTED, textDecoration: "underline", cursor: "pointer" }}>
              Lewati, belum yakin
            </button>
          </form>
        ) : null}
      </div>
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

/** Who said it instead: one of the figures that also fit, or any from the roster. */
function SpeakerCorrection({ point: p, listId }: { point: Point; listId: string }) {
  const others = (p.proposal.candidates ?? []).filter((c) => c.id !== p.proposal.figure_id);
  return (
    <details style={{ flex: "1 1 100%", order: 1 }}>
      <summary style={{ ...button("quiet"), display: "inline-block", padding: "8px 16px", fontSize: 13.5, color: INK, listStyle: "none" }}>
        {p.proposal.figure_id ? "Koreksi…" : "Ini tokoh…"}
      </summary>
      <div style={{ marginTop: 8, padding: 12, background: "var(--color-cream)", borderRadius: 4, display: "grid", gap: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>“{p.proposal.speaker}” di sini sebenarnya siapa?</div>
        {others.length ? (
          <form action={answerCurationPoint} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <PointHidden id={p.id} answer="koreksi" />
            {others.map((c) => (
              <button key={c.id} type="submit" name="figure_id" value={c.id} style={{ ...button("quiet"), color: INK }}>{c.name}</button>
            ))}
          </form>
        ) : null}
        <form action={answerCurationPoint} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <PointHidden id={p.id} answer="koreksi" />
          <FigurePicker listId={listId} required />
          <button type="submit" style={button("ink")}>Simpan koreksi</button>
        </form>
        <div style={{ fontSize: 12, color: MUTED }}>Berlaku untuk {p.group_size} kutipan sekaligus.</div>
      </div>
    </details>
  );
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
      <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 999, border: `1px solid ${look[1]}`, color: look[1], whiteSpace: "nowrap" }}>{look[0]}</span>
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

function Highlighted({ text, start, end }: { text: string; start: number | null; end: number | null }) {
  if (start === null || end === null || end <= start) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark style={{ background: "#f3dfa6", color: INK, padding: "1px 2px", borderRadius: 2 }}>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

/** Agreement so far for this kind and band; before any answer, says so instead of guessing a number. */
function Meter({ confidence: c }: { confidence: Confidence }) {
  if (c.value === null) {
    return <span style={{ fontSize: 11.5, color: MUTED }} title="Belum ada jawaban untuk poin sejenis">yakin: belum ada data</span>;
  }
  const pct = Math.round(c.value * 100);
  const color = pct >= 90 ? ACCEPT : pct >= 70 ? "#b08a2e" : "var(--color-clay)";
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 7 }} title={`Kamu setuju ${c.agreed} dari ${c.answered} kali`}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED }}>Yakin</span>
      <span aria-hidden style={{ width: 72, height: 6, borderRadius: 3, background: RULE, overflow: "hidden", display: "block" }}>
        <span style={{ display: "block", height: "100%", width: `${pct}%`, background: color }} />
      </span>
      <strong style={{ fontSize: 13.5, color: INK }}>{pct}%</strong>
    </span>
  );
}

function basis(p: Point): string {
  const c = p.confidence;
  const band = p.bucket ? ` (pita “${p.bucket}”)` : "";
  if (!c.answered) return `Belum ada jawaban untuk poin sejenis${band}; tiap jawabanmu mulai mengukurnya.`;
  return `Kamu setuju ${c.agreed} dari ${c.answered} kali untuk poin sejenis${band}.`;
}
