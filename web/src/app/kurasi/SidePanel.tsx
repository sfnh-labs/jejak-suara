import Link from "next/link";
import type { LinkVerdict } from "@/lib/curation";
import { positionTitle } from "@/lib/curation";
import { eventPanel, type EventPeek, type FigurePeek, type PeekEvent } from "@/lib/panels";
import { ruleFollowup, ruleLink } from "./actions";
import { ACCEPT, INK, MUTED, RULE, SURFACE, button, day } from "./ui";

/**
 * How the event in the panel stands to the one being curated: a peristiwa
 * link or a lini cerita pair, with its verdict, ruled from the panel as from
 * the list it was opened from.
 */
export type Relation =
  | { kind: "link"; pair: { record_id: number; peristiwa_id: number }; verdict: LinkVerdict | null }
  | { kind: "lini"; pair: { earlier_id: number; later_id: number }; verdict: LinkVerdict | null };

/**
 * The side panel of the record page: another event or a figure, read where
 * the curator already is. Wide, it sits in the reading column; narrow, it
 * covers the page as a sheet. Every link inside opens the next panel in its
 * place, and "Buka untuk dikurasi" is the one way out to another page.
 */
export function SidePanel({ title, closeHref, children }: { title: string; closeHref: string; children: React.ReactNode }) {
  return (
    <article style={{ background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 6, padding: "16px 20px 22px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MUTED }}>{title}</span>
        <Link href={closeHref} scroll={false} style={{ fontSize: 12.5, color: MUTED }}>Tutup ✕</Link>
      </div>
      {children}
    </article>
  );
}

export function MissingPanel({ closeHref }: { closeHref: string }) {
  return (
    <SidePanel title="Panel" closeHref={closeHref}>
      <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Tidak ditemukan. Mungkin sudah digabung atau dihapus.</p>
    </SidePanel>
  );
}

const heading = { fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 21, lineHeight: 1.3, margin: "0 0 8px", color: INK } as const;
const sub = { fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MUTED, margin: "18px 0 6px" } as const;

export function EventPanel({ peek: e, open, closeHref, relation, here }: {
  peek: EventPeek;
  /** The page with another panel in this one's place. */
  open: (panel: string) => string;
  closeHref: string;
  relation: Relation | null;
  /** The event being curated: marked in the lists, never opened from them. */
  here: number;
}) {
  const isRecord = e.kind === "record";
  return (
    <SidePanel title={`${isRecord ? "Catatan" : "Peristiwa"} #${e.event_id}`} closeHref={closeHref}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, marginBottom: 4 }}>
        {day(e.event_date)}
        {e.last_seen && day(e.last_seen) !== day(e.event_date) ? ` – ${day(e.last_seen)}` : ""}
        {" · "}{e.sources.length} artikel
        {e.curated === "rejected" ? <span style={{ color: "var(--color-clay)" }}> · diturunkan</span> : null}
      </div>
      <h2 style={heading}>{e.title ?? "(tanpa judul)"}</h2>
      {isRecord && e.figure ? (
        <div style={{ fontSize: 13, color: "var(--color-mud)", marginBottom: 8 }}>
          Pelaku:{" "}
          {[e.figure, ...e.actors].map((f, i) => (
            <span key={f.id}>
              {i ? ", " : ""}
              <Link href={open(`tokoh:${f.id}`)} scroll={false} style={{ color: INK, fontWeight: 600 }}>{f.name}</Link>
            </span>
          ))}
        </div>
      ) : null}
      {relation ? <RelationBar relation={relation} isRecord={isRecord} /> : null}
      {e.summary ? (
        <p style={{ fontSize: 14, lineHeight: 1.65, color: "var(--color-mud)", margin: "10px 0 0", whiteSpace: "pre-line" }}>{e.summary}</p>
      ) : (
        <p style={{ fontSize: 13, color: MUTED, margin: "10px 0 0", fontStyle: "italic" }}>Belum dirangkum.</p>
      )}
      {e.quote ? (
        <p style={{ fontFamily: "var(--font-serif)", fontSize: 14.5, lineHeight: 1.55, margin: "12px 0 0", paddingLeft: 12, borderLeft: `3px solid ${RULE}`, fontStyle: "italic" }}>
          “{e.quote}”
        </p>
      ) : null}

      {e.members.length ? (
        <>
          <div style={sub}>{isRecord ? "Bagian dari peristiwa" : `Catatan di dalamnya (${e.members.length})`}</div>
          <EventList rows={e.members} kind={isRecord ? "peristiwa" : "record"} open={open} here={here} />
        </>
      ) : null}
      {e.followups.length ? (
        <>
          <div style={sub}>Lini cerita</div>
          <EventList rows={e.followups} kind={e.kind} open={open} here={here} />
        </>
      ) : null}

      <div style={sub}>Artikel ({e.sources.length})</div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {e.sources.slice(0, 12).map((s, i) => (
          <li key={`${s.url}-${i}`} style={{ padding: "6px 0", borderTop: i ? `1px solid ${RULE}` : "none", fontSize: 13, lineHeight: 1.45 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: MUTED }}>{s.source} · {day(s.published_at)}</span>
            <br />
            <a href={s.url} target="_blank" rel="noreferrer" style={{ color: INK }}>{s.title ?? s.url} ↗</a>
          </li>
        ))}
      </ul>
      {e.sources.length > 12 ? <div style={{ fontSize: 12, color: MUTED }}>dan {e.sources.length - 12} lagi</div> : null}

      <div style={{ marginTop: 18, paddingTop: 12, borderTop: `1px solid ${RULE}`, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
        <Link href={`/kurasi/${e.event_id}`} style={{ color: INK, fontWeight: 600 }}>Buka untuk dikurasi →</Link>
        {isRecord && e.figure && e.curated !== "rejected" ? (
          <Link href={`/tokoh/${e.figure.id}/${e.event_id}`} target="_blank" style={{ color: MUTED }}>Lihat di situs ↗</Link>
        ) : null}
      </div>
    </SidePanel>
  );
}

function RelationBar({ relation: r, isRecord }: { relation: Relation; isRecord: boolean }) {
  const what = r.kind === "link"
    ? (isRecord ? "Catatan ini bagian dari peristiwa yang sedang dikurasi" : "Catatan yang sedang dikurasi bagian dari peristiwa ini")
    : "Satu lini cerita dengan yang sedang dikurasi";
  const status = r.verdict === "confirmed" ? "dikonfirmasi" : r.verdict === "rejected" ? "ditolak" : "usulan pipeline";
  const action = r.kind === "link" ? ruleLink : ruleFollowup;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", margin: "4px 0 6px", borderRadius: 6, background: "var(--color-cream)", border: `1px solid ${RULE}` }}>
      <span style={{ flex: "1 1 200px", fontSize: 12.5, color: "var(--color-mud)" }}>
        {what}? <strong style={{ color: r.verdict === "confirmed" ? ACCEPT : r.verdict === "rejected" ? "var(--color-clay)" : "#7a5a12" }}>{status}</strong>
      </span>
      {r.verdict !== "confirmed" ? (
        <form action={action}>
          <PairFields relation={r} verdict="confirmed" />
          <button type="submit" style={button("accept")}>Benar</button>
        </form>
      ) : null}
      {r.verdict !== "rejected" ? (
        <form action={action}>
          <PairFields relation={r} verdict="rejected" />
          <button type="submit" style={button("quiet")}>Bukan</button>
        </form>
      ) : null}
      {r.verdict ? (
        <form action={action}>
          <PairFields relation={r} verdict="" />
          <button type="submit" style={button("quiet")}>Batalkan</button>
        </form>
      ) : null}
    </div>
  );
}

function PairFields({ relation, verdict }: { relation: Relation; verdict: string }) {
  return (
    <>
      {Object.entries(relation.pair).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="verdict" value={verdict} />
    </>
  );
}

function EventList({ rows, kind, open, here }: { rows: PeekEvent[]; kind: "record" | "peristiwa"; open: (panel: string) => string; here: number }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((r, i) => (
        <li key={r.event_id} style={{ padding: "7px 0", borderTop: i ? `1px solid ${RULE}` : "none", fontSize: 13.5, lineHeight: 1.45 }}>
          <span style={{ fontSize: 11.5, color: MUTED }}>
            {day(r.event_date)}
            {r.figure_name ? ` · ${r.figure_name}` : ""}
            {r.verdict === "confirmed" ? <span style={{ color: ACCEPT }}> · dikonfirmasi</span> : r.verdict === null ? " · usulan" : ""}
          </span>
          <br />
          {r.event_id === here ? (
            <strong style={{ color: INK }}>{r.title ?? `#${r.event_id}`} <span style={{ fontWeight: 400, color: MUTED }}>(yang sedang dikurasi)</span></strong>
          ) : (
            <Link href={open(eventPanel(kind, r.event_id))} scroll={false} style={{ color: INK, fontFamily: "var(--font-serif)", fontSize: 15 }}>
              {r.title ?? `#${r.event_id}`}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

export function FigurePanel({ peek: f, open, closeHref, onPage, here }: {
  peek: FigurePeek;
  open: (panel: string) => string;
  closeHref: string;
  /** Where this figure is edited on the current page, if it is named there. */
  onPage: string | null;
  here: number;
}) {
  const title = f.positions.length ? f.positions.map(positionTitle).filter(Boolean)[0] : f.role;
  return (
    <SidePanel title="Tokoh" closeHref={closeHref}>
      <h2 style={heading}>{f.name}</h2>
      {title ? <div style={{ fontSize: 13.5, color: "var(--color-mud)", marginBottom: 4 }}>{title}</div> : null}
      <div style={{ fontSize: 12, color: MUTED }}>
        <code>/tokoh/{f.id}</code> · {f.records} catatan · {f.quotes} kutipan
        {!f.active ? <span style={{ color: "var(--color-clay)" }}> · nonaktif</span> : null}
      </div>
      {f.aliases.length ? (
        <div style={{ fontSize: 12.5, color: "var(--color-mud)", marginTop: 6 }}>Alias: {f.aliases.join(", ")}</div>
      ) : null}
      {f.positions.length > 1 ? (
        <>
          <div style={sub}>Jabatan</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>
            {f.positions.map((p, i) => <li key={i}>{positionTitle(p)}{p.period ? ` (${p.period})` : ""}</li>)}
          </ul>
        </>
      ) : null}

      <div style={sub}>Di catatan lain</div>
      {f.recent.filter((r) => r.event_id !== here).length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {f.recent.filter((r) => r.event_id !== here).map((r, i) => (
            <li key={r.event_id} style={{ padding: "7px 0", borderTop: i ? `1px solid ${RULE}` : "none", fontSize: 13.5, lineHeight: 1.45, opacity: r.curated === "rejected" ? 0.6 : 1 }}>
              <span style={{ fontSize: 11.5, color: MUTED }}>
                {day(r.event_date)}
                {r.as_actor ? " · sebagai pelaku" : ""}
                {r.curated === "rejected" ? " · diturunkan" : ""}
              </span>
              <br />
              <Link href={open(`catatan:${r.event_id}`)} scroll={false} style={{ color: INK, fontFamily: "var(--font-serif)", fontSize: 15 }}>
                {r.title ?? `#${r.event_id}`}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>Belum ada catatan lain.</p>
      )}

      {f.peristiwa.length ? (
        <>
          <div style={sub}>Di peristiwa</div>
          <EventList rows={f.peristiwa} kind="peristiwa" open={open} here={here} />
        </>
      ) : null}

      <div style={{ marginTop: 18, paddingTop: 12, borderTop: `1px solid ${RULE}`, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
        {onPage ? <a href={onPage} style={{ color: INK, fontWeight: 600 }}>Sunting di halaman ini ↓</a> : null}
        <Link href={`/tokoh/${f.id}`} target="_blank" style={{ color: MUTED }}>Lihat di situs ↗</Link>
      </div>
    </SidePanel>
  );
}
