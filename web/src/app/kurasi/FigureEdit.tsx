import Link from "next/link";
import { likelyDuplicates, positionLine, type FigureOption, type FigureRef, type NamedPerson, type Organization, type Position, type Profile } from "@/lib/curation";
import { decide } from "./kandidat/actions";
import { AcceptCandidateForm } from "./AcceptCandidateForm";
import { editFigure, mergeFigures, notAPerson } from "./actions";
import { Hidden, Pill, type PillTone } from "./kit";
import { INK, MUTED, RULE, SURFACE, button, input, label } from "./ui";

/**
 * Editing a figure, wherever it is called from: the record page's drawer and
 * the Tokoh pages. Name, offices, CV and aliases in one form; "is this
 * someone already tracked?" beside it; and deciding a newly found name.
 */

/** The page with a panel open; links inside a form open the next panel. */
export type Open = (panel: string) => string;

/** A group inside a card: a labelled, tinted box, optionally folded away. */
export function SubPanel({
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


export function FigureHeading({ figure }: { figure: FigureRef | NamedPerson }) {
  const active = figure.active ?? true;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <span style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 600, color: INK }}>{figure.name}</span>
      {figure.positions.length > 0 ? (
        <span style={{ fontSize: 13, color: "var(--color-mud)" }}>
          {figure.positions.map((p) => positionLine(p) + (p.period ? ` (${p.period})` : "")).join(" · ")}
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
export function FigureForm({ figure, eventId }: { figure: FigureRef | NamedPerson; eventId: number }) {
  const profile = figure.profile ?? null;
  const active = figure.active ?? true;
  return (
    <form action={editFigure} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
      <Hidden fields={eventId ? { event_id: eventId, figure_id: figure.id } : { figure_id: figure.id }} />
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

export const ORG_LIST = "org-options";

/**
 * Both names of every organisation in /kurasi/organisasi, for the office
 * rows: typing "KPK" or "Komisi Pem…" offers either form, the other as hint.
 */
export function OrgOptions({ orgs }: { orgs: Organization[] }) {
  return (
    <datalist id={ORG_LIST}>
      {orgs.flatMap((o) => [
        ...(o.short_name ? [<option key={`${o.id}s`} value={o.short_name} label={o.name} />] : []),
        <option key={`${o.id}l`} value={o.name} label={o.short_name ?? ""} />,
      ])}
    </datalist>
  );
}

export const FIGURE_LIST = "figure-options";

/**
 * The roster once per page, for every merge field to search. A <datalist>
 * filters as the curator types, by name or id, with no script; the field
 * submits the id, and `pattern` refuses anything not on the list.
 */
export function FigureOptions({ figures }: { figures: FigureOption[] }) {
  return (
    <datalist id={FIGURE_LIST}>
      {figures.map((f) => (
        <option
          key={f.id}
          value={f.id}
          label={`${f.name}${f.title ? ` – ${f.title}` : ""}`}
          data-name={f.name}
          data-title={f.title}
          data-aliases={f.aliases.join("|")}
        >
          {f.name}{f.title ? ` – ${f.title}` : ""}
        </option>
      ))}
    </datalist>
  );
}


/**
 * A discovered name, decided where the evidence for it is being read.
 *
 * The form itself is shared with the queue (AcceptCandidateForm).
 */
export function CandidateRow({ person: p, figures, open }: { person: NamedPerson; figures: FigureOption[]; open: Open }) {
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
      <SamePerson person={p} eventId={0} figures={figures} open={open} />
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
export function SamePerson({ person: p, eventId, figures, open }: { person: NamedPerson; eventId: number; figures: FigureOption[]; open: Open }) {
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
              <span style={{ color: MUTED }}>{f.title ? ` – ${f.title}` : ""} · {f.records} catatan · </span>
              <Link href={open(`tokoh:${f.id}`)} scroll={false} style={{ color: MUTED, fontSize: 12 }}>lihat ›</Link>
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
export const CONFIRM_PANEL: React.CSSProperties = {
  marginTop: 8, maxWidth: 460, background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 2,
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
  const fields: Record<string, string | number> = {
    ...(eventId ? { event_id: eventId } : {}),
    figure_id: p.id,
    ...(into ? { into_id: into } : {}),
    confirm: 1,
  };
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


/**
 * The form "Bukan orang…" in FigureForm submits: forms cannot nest, so it
 * sits beside the figure form and the button names it by id.
 */
export function NotAPersonForm({ figureId, eventId }: { figureId: string; eventId: number }) {
  return (
    <form id={`bukan-orang-${figureId}`} action={notAPerson}>
      <Hidden fields={eventId ? { event_id: eventId, figure_id: figureId, confirm: 1 } : { figure_id: figureId, confirm: 1 }} />
    </form>
  );
}
