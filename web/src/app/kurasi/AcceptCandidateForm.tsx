import { decide } from "./kandidat/actions";
import { MUTED, button, input, label } from "./ui";

/** The pipeline's slugify (jejak/mentions.py), to show the address an empty
 *  box would get. */
function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Turn a discovered name into a figure — the one form for it.
 *
 * Used on the record page, where the evidence is read, and by the queue only
 * for names that no record carries. What the form shows is exactly what is
 * saved: the mined spelling sits in the alias box where it can be removed,
 * the office is the curator's to type, and the page address follows the full
 * name unless one is given.
 */
export function AcceptCandidateForm({ slug, name, role, withReject = true }: {
  slug: string;
  name: string;
  role: string | null;
  /** Off where the row already has its own Tolak button. */
  withReject?: boolean;
}) {
  // The same rows the figure editor takes (pos_role/pos_org/pos_period): the
  // first, pre-filled with what the coverage called them, is the main office.
  const rows = [role ?? "", "", ""];
  const head = { fontSize: 11, color: MUTED } as const;
  return (
    <form action={decide} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "end" }}>
      <input type="hidden" name="slug" value={slug} />
      <label style={label}>
        Nama lengkap
        <input name="full_name" defaultValue={name} required style={input} />
      </label>
      <label style={label}>
        Alamat halaman (kosongkan untuk mengikuti nama lengkap)
        {/* The address is /tokoh/<slug>; only the slug is the curator's. */}
        <span style={{ display: "flex", minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{ ...input, flex: "none", borderRight: "none", borderRadius: "3px 0 0 3px", background: "var(--color-cream-dark)", color: MUTED }}
          >
            …/tokoh/
          </span>
          <input
            name="figure_slug"
            placeholder={slugify(name)}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            title="Huruf kecil, angka, dan tanda hubung, mis. prabowo-subianto"
            aria-label="Alamat halaman, setelah /tokoh/"
            style={{ ...input, flex: 1, borderRadius: "0 3px 3px 0" }}
          />
        </span>
      </label>
      <fieldset style={{ gridColumn: "1 / -1", border: "none", margin: 0, padding: 0, minWidth: 0 }}>
        <legend style={{ ...label, padding: 0, marginBottom: 6 }}>
          Jabatan. Baris pertama jabatan utama, tampil di bawah nama; kosongkan baris yang tak terpakai.
        </legend>
        <div style={{ display: "grid", gap: 6, gridTemplateColumns: "minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.2fr)" }}>
          <span style={head}>Jabatan</span><span style={head}>Lembaga</span><span style={head}>Periode</span>
          {rows.map((r, i) => (
            <PositionCells key={i} role={r} main={i === 0} />
          ))}
        </div>
      </fieldset>
      <label style={{ ...label, gridColumn: "1 / -1" }}>
        Alias, dipisah dengan |. Ejaan dari liputan sudah diisikan; hapus jika terlalu umum.
        <input name="aliases" defaultValue={name} style={input} />
      </label>
      <div style={{ display: "flex", gap: 8, gridColumn: "1 / -1", justifyContent: "flex-end", flexWrap: "wrap" }}>
        {withReject ? (
          // Skips the required fields: rejecting needs none of them, and the
          // action drops whatever was typed.
          <button type="submit" name="verdict" value="reject" formNoValidate style={button("quiet")}>
            Bukan tokoh, tolak
          </button>
        ) : null}
        <button type="submit" name="verdict" value="promote" style={button("accept")}>Jadikan tokoh</button>
      </div>
    </form>
  );
}

function PositionCells({ role, main }: { role: string; main: boolean }) {
  const cell = { ...input, width: "100%", fontWeight: main ? 600 : 400 };
  return (
    <>
      <input name="pos_role" defaultValue={role} placeholder={main ? "mis. Ketua" : ""} style={cell} aria-label="Jabatan" />
      <input name="pos_org" placeholder={main ? "mis. MPR RI" : ""} style={cell} aria-label="Lembaga" />
      <input name="pos_period" placeholder={main ? "2024–sekarang" : ""} style={cell} aria-label="Periode" />
    </>
  );
}
