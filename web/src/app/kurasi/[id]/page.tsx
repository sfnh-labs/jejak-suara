import Link from "next/link";
import { notFound } from "next/navigation";
import { getFigureOptions, getItem, type FigureOption, type FigureRef, type Item, type LinkRow, type NamedPerson } from "@/lib/curation";
import { decide } from "../kandidat/actions";
import { curate, editFigure, mergeFigures, relateFigure, ruleLink } from "../actions";
import { ACCEPT, INK, MUTED, RULE, button, day, input, label, sectionLabel } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kurasi · Jejak Suara",
  robots: { index: false, follow: false },
};

export default async function KurasiItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0) notFound();
  const [item, figures] = await Promise.all([getItem(eventId), getFigureOptions()]);
  if (!item) notFound();

  const isRecord = item.kind === "record";
  const outlets = new Set(item.sources.map((s) => s.source)).size;
  const queue = `/kurasi?kind=${item.kind}`;

  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 880, paddingBottom: 80 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "22px 0 0", fontSize: 12.5, flexWrap: "wrap" }}>
          <Link href={queue} style={{ color: MUTED }}>← Antrean {isRecord ? "catatan" : "peristiwa"}</Link>
          {item.next_id ? (
            <Link href={`/kurasi/${item.next_id}`} style={{ color: MUTED }}>Lewati →</Link>
          ) : null}
        </div>

        <header className="rule-heavy" style={{ padding: "16px 0 20px" }}>
          <div style={{ fontSize: 11.5, color: MUTED, display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--color-clay)" }}>
              {isRecord ? "Catatan" : "Peristiwa"} #{item.event_id}
            </span>
            <span>·</span>
            <span>{day(item.event_date)}{item.last_seen && day(item.last_seen) !== day(item.event_date) ? ` – ${day(item.last_seen)}` : ""}</span>
            <span>·</span>
            <span>{outlets} media, {item.sources.length} artikel</span>
            {outlets <= 1 ? <span style={{ color: "var(--color-clay)", fontWeight: 600 }}>⚠ satu sumber</span> : null}
            {item.event_type && item.event_type !== "other" ? <><span>·</span><span>{item.event_type}</span></> : null}
          </div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "clamp(24px, 4vw, 32px)", lineHeight: 1.2, margin: "0 0 8px", letterSpacing: "-0.01em" }}>
            {item.title ?? "(tanpa judul)"}
          </h1>
          {isRecord && item.figure_id && item.curated !== "rejected" ? (
            <Link href={`/tokoh/${item.figure_id}/${item.event_id}`} target="_blank" style={{ fontSize: 12.5, color: MUTED }}>
              Lihat di situs ↗
            </Link>
          ) : null}
        </header>

        <VerdictBar item={item} />

        <Section title="Isi">
          {item.summary ? (
            <p style={{ fontSize: 14.5, lineHeight: 1.65, color: "var(--color-mud)", margin: "0 0 12px", whiteSpace: "pre-line" }}>
              {item.summary}
            </p>
          ) : (
            <p style={{ fontSize: 13.5, color: MUTED, margin: "0 0 12px", fontStyle: "italic" }}>
              Belum dirangkum. Tayang dari hasil klaster.
            </p>
          )}
          <details open={!item.summary}>
            <summary style={{ fontSize: 12, fontWeight: 700, color: MUTED, cursor: "pointer" }}>
              Artikel sumber ({item.sources.length})
            </summary>
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13.5, lineHeight: 1.55 }}>
              {item.sources.map((a, i) => (
                <li key={`${a.url}-${i}`} style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, marginRight: 6 }}>
                    {a.source} · {day(a.published_at)}
                  </span>
                  <a href={a.url} target="_blank" rel="noreferrer" style={{ color: INK }}>{a.title ?? a.url}</a>
                  {a.lead ? (
                    <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>{a.lead.slice(0, 240)}{a.lead.length > 240 ? "…" : ""}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </Section>

        {isRecord ? (
          <Section
            title="Pelaku"
            note="Tokoh yang memiliki catatan ini. Nama, jabatan, dan alias berlaku di seluruh situs; alias juga dipakai pipeline untuk mengenali artikel berikutnya."
          >
            {item.owner ? (
              <FigureEditor figure={item.owner} eventId={item.event_id} figures={figures} open />
            ) : (
              <p style={{ fontSize: 13.5, color: MUTED }}>Tokoh {item.figure_id} tidak ada di daftar.</p>
            )}
          </Section>
        ) : null}

        <Section
          title={isRecord ? "Disebut dalam liputan" : "Tokoh terkait"}
          note={
            isRecord
              ? "Orang lain yang namanya muncul di artikel catatan ini. Tokoh bisa disunting; nama baru bisa langsung diterima atau ditolak."
              : "Tokoh yang muncul di liputan peristiwa ini. Coret yang salah cocok, misalnya karena alias yang juga nama orang lain."
          }
        >
          <NamedList item={item} figures={figures} />
        </Section>

        <Section
          title={isRecord ? "Bagian dari peristiwa" : "Catatan tokoh di dalamnya"}
          note={
            isRecord
              ? "Usulan pipeline berdasar kata-kata khas yang sama. Hanya tautan yang dikonfirmasi yang tampil di situs."
              : "Catatan tokoh yang diusulkan atau dikonfirmasi sebagai bagian dari peristiwa ini."
          }
        >
          <LinkList item={item} />
          {isRecord ? <AddLink item={item} /> : null}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: "22px 0", borderBottom: `1px solid ${RULE}` }}>
      <h2 style={{ ...sectionLabel, marginBottom: note ? 4 : 10 }}>{title}</h2>
      {note ? <p style={{ fontSize: 12.5, color: MUTED, margin: "0 0 14px", lineHeight: 1.5, maxWidth: 640 }}>{note}</p> : null}
      {children}
    </section>
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

function VerdictBar({ item }: { item: Item }) {
  const next = item.next_id ?? "";
  const status =
    item.curated === "rejected" ? "Diturunkan dari situs" :
    item.curated === "kept" ? "Sudah diperiksa, tayang" :
    "Tayang, belum ditinjau";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "16px 0", borderBottom: `1px solid ${RULE}` }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: item.curated === "rejected" ? "var(--color-clay)" : "var(--color-mud)", marginRight: "auto" }}>
        {status}
      </span>
      {item.curated !== "kept" ? (
        <form action={curate}>
          <Hidden fields={{ event_id: item.event_id, verdict: "kept", next }} />
          <button type="submit" style={button("accept")}>Tayang, lanjut →</button>
        </form>
      ) : null}
      {item.curated !== "rejected" ? (
        <form action={curate}>
          <Hidden fields={{ event_id: item.event_id, verdict: "rejected", next }} />
          <button type="submit" style={button("danger")}>Turunkan, lanjut →</button>
        </form>
      ) : null}
      {item.curated ? (
        <form action={curate}>
          <Hidden fields={{ event_id: item.event_id, verdict: "" }} />
          <button type="submit" style={button("quiet")}>
            {item.curated === "rejected" ? "Tayangkan lagi" : "Batalkan"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function FigureEditor({
  figure,
  eventId,
  figures,
  open,
}: {
  figure: FigureRef | NamedPerson;
  eventId: number;
  figures: FigureOption[];
  open?: boolean;
}) {
  const pending = "edit_pending" in figure && figure.edit_pending;
  // Named people come from the active roster, so only an owner can be retired.
  const active = "active" in figure ? figure.active : true;
  return (
    <details open={open} style={{ marginBottom: open ? 0 : 4 }}>
      <summary style={{ cursor: "pointer", listStyle: open ? "none" : undefined }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 600, color: INK }}>{figure.name}</span>
        {figure.role ? <span style={{ fontSize: 13, color: "var(--color-mud)" }}> · {figure.role}</span> : null}
        <span style={{ fontSize: 11.5, color: MUTED, marginLeft: 8 }}>{figure.id}</span>
        {!active ? (
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--color-clay)", marginLeft: 8 }}>nonaktif</span>
        ) : null}
        {pending ? (
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--color-clay)", marginLeft: 8 }}>
            disunting · menunggu pipeline
          </span>
        ) : null}
      </summary>
      <form action={editFigure} style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: 12, alignItems: "end" }}>
        <Hidden fields={{ event_id: eventId, figure_id: figure.id }} />
        <label style={label}>
          Nama tampil
          <input name="name" defaultValue={figure.name} required style={input} />
        </label>
        <label style={label}>
          Jabatan
          <input name="role" defaultValue={figure.role ?? ""} placeholder="mis. Menteri Agama" style={input} />
        </label>
        <label style={{ ...label, gridColumn: "1 / -1" }}>
          Alias, satu per baris. Ini yang dicocokkan pipeline ke judul artikel, jadi hindari kata umum.
          <textarea
            name="aliases"
            rows={Math.min(8, Math.max(3, figure.aliases.length + 1))}
            defaultValue={figure.aliases.join("\n")}
            style={{ ...input, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          />
        </label>
        <label style={{ ...label, display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
          <input type="checkbox" name="active" value="1" defaultChecked={active} />
          Aktif. Hapus centang untuk nama yang salah tambang atau tokoh ganda.
        </label>
        <div>
          <button type="submit" style={button("ink")}>Simpan tokoh</button>
        </div>
      </form>
      {active ? <MergeForm figure={figure} eventId={eventId} figures={figures} /> : null}
    </details>
  );
}

/**
 * "This is the same person as …". Moves every record of this figure to the
 * chosen one, adds this figure's names to its aliases and retires this one.
 */
function MergeForm({ figure, eventId, figures }: { figure: FigureRef | NamedPerson; eventId: number; figures: FigureOption[] }) {
  return (
    <form
      action={mergeFigures}
      style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 14, paddingTop: 12, borderTop: `1px dashed ${RULE}` }}
    >
      <Hidden fields={{ event_id: eventId, figure_id: figure.id }} />
      <label style={{ ...label, flex: "1 1 260px" }}>
        Tokoh ganda? Gabungkan ke
        <select name="into_id" required defaultValue="" style={input}>
          <option value="" disabled>Pilih tokoh…</option>
          {figures
            .filter((f) => f.id !== figure.id)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}{f.role ? ` · ${f.role}` : ""} ({f.id})
              </option>
            ))}
        </select>
      </label>
      <label style={{ ...label, display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
        <input type="checkbox" name="confirm" value="1" required />
        Pindahkan semua catatannya; {figure.name} dinonaktifkan
      </label>
      <button type="submit" style={button("danger")}>Gabungkan</button>
    </form>
  );
}

function NamedList({ item, figures }: { item: Item; figures: FigureOption[] }) {
  if (item.named.length === 0) {
    return <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Tidak ada nama lain yang dikenali.</p>;
  }
  const isRecord = item.kind === "record";
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
      {item.named.map((p) => (
        <li key={`${p.kind}-${p.id}`} style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, color: MUTED, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: p.kind === "candidate" ? "var(--color-clay)" : MUTED }}>
              {p.kind === "candidate" ? "Nama baru" : "Tokoh"}
            </span>
            <span>disebut di {p.articles} artikel</span>
            {p.struck ? <span style={{ color: "var(--color-clay)", fontWeight: 600 }}>· dicoret</span> : null}
          </div>
          {p.kind === "figure" ? (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 400px", minWidth: 0, opacity: p.struck ? 0.55 : 1 }}>
                <FigureEditor figure={p} eventId={item.event_id} figures={figures} />
              </div>
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

/** A discovered name, decided where the evidence for it is being read. */
function CandidateRow({ person: p }: { person: NamedPerson }) {
  if (p.verdict) {
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 16, fontWeight: 600 }}>{p.name}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: p.verdict === "promote" ? ACCEPT : "var(--color-clay)" }}>
          {p.verdict === "promote" ? "diterima · menunggu pipeline" : "ditolak · menunggu pipeline"}
        </span>
        <form action={decide}>
          <Hidden fields={{ slug: p.id, verdict: "" }} />
          <button type="submit" style={button("quiet")}>Batalkan</button>
        </form>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
    <div>
      <span style={{ fontFamily: "var(--font-serif)", fontSize: 16, fontWeight: 600 }}>{p.name}</span>
      {p.role ? <span style={{ fontSize: 13, color: "var(--color-mud)" }}> · disebut sebagai {p.role}</span> : null}
      <span style={{ fontSize: 11.5, color: MUTED, marginLeft: 8 }}>{p.id}</span>
    </div>
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
      <form action={decide} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Hidden fields={{ slug: p.id, verdict: "promote" }} />
        <label style={label}>
          Nama lengkap
          <input name="full_name" defaultValue={p.name} style={{ ...input, width: 190 }} />
        </label>
        <label style={label}>
          Jabatan
          <input name="curated_role" defaultValue={p.role ?? ""} style={{ ...input, width: 190 }} />
        </label>
        <label style={label}>
          Alias (pisahkan dengan |)
          <input name="aliases" style={{ ...input, width: 170 }} />
        </label>
        <button type="submit" style={button("accept")}>Jadikan tokoh</button>
      </form>
      <form action={decide}>
        <Hidden fields={{ slug: p.id, verdict: "reject" }} />
        <button type="submit" style={button("danger")}>Bukan tokoh</button>
      </form>
    </div>
    </div>
  );
}

function LinkList({ item }: { item: Item }) {
  if (item.links.length === 0) {
    return (
      <p style={{ fontSize: 13.5, color: MUTED, margin: "0 0 12px" }}>
        {item.kind === "record" ? "Pipeline belum mengusulkan peristiwa untuk catatan ini." : "Belum ada catatan tokoh yang ditautkan."}
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: "0 0 12px", padding: 0, display: "grid", gap: 14 }}>
      {item.links.map((l) => (
        <LinkItem key={l.event_id} link={l} item={item} />
      ))}
    </ul>
  );
}

function LinkItem({ link: l, item }: { link: LinkRow; item: Item }) {
  const pair = item.kind === "record"
    ? { record_id: item.event_id, peristiwa_id: l.event_id }
    : { record_id: l.event_id, peristiwa_id: item.event_id };
  const tone = l.verdict === "confirmed" ? ACCEPT : l.verdict === "rejected" ? "var(--color-clay)" : MUTED;
  return (
    <li style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", opacity: l.verdict === "rejected" ? 0.6 : 1 }}>
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: MUTED, display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
          <span style={{ fontWeight: 700, color: tone }}>
            {l.verdict === "confirmed" ? "Dikonfirmasi" : l.verdict === "rejected" ? "Ditolak" : l.proposed ? "Usulan" : "Ditambahkan"}
          </span>
          <span>{day(l.event_date)}</span>
          {l.figure_name ? <span>· {l.figure_name}</span> : null}
          {l.score !== null ? <span>· skor {l.score.toFixed(2)}</span> : null}
        </div>
        <Link href={`/kurasi/${l.event_id}`} style={{ fontFamily: "var(--font-serif)", fontSize: 15.5, color: INK, lineHeight: 1.4 }}>
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
    <form action={ruleLink} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 6 }}>
      <Hidden fields={{ record_id: item.event_id, verdict: "confirmed" }} />
      <label style={{ ...label, flex: "1 1 420px" }}>
        Tautkan ke peristiwa lain (±7 hari)
        <select name="peristiwa_id" required defaultValue="" style={{ ...input, width: "100%" }}>
          <option value="" disabled>Pilih peristiwa…</option>
          {item.nearby.map((p) => (
            <option key={p.event_id} value={p.event_id}>
              {day(p.event_date)} · {p.title ?? `#${p.event_id}`}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" style={button("ink")}>Tautkan</button>
    </form>
  );
}
