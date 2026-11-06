import Link from "next/link";
import { ORG_KINDS, getOrganizations, getUnlinkedOrgs, type Organization } from "@/lib/curation";
import { editOrganization } from "../actions";
import { MUTED, RULE, button, input } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Organisasi · Kurasi",
  robots: { index: false, follow: false },
};

/**
 * Organisations by their long and short names ("Komisi Pemberantasan
 * Korupsi", "KPK"), other spellings and kind. The figure editor offers the
 * names when filling in the organisation of an office, and each pipeline run
 * links every office to its organisation by any of them
 * (jejak/organizations.py); what matched nothing is listed below.
 */
export default async function Organisasi() {
  const [orgs, unlinked] = await Promise.all([getOrganizations(), getUnlinkedOrgs()]);
  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 1180, paddingBottom: 80 }}>
        <header style={{ padding: "28px 0 18px" }}>
          <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "clamp(26px, 4vw, 32px)", margin: "0 0 12px" }}>
            Organisasi
          </h1>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--color-mud)", margin: 0, maxWidth: 640 }}>
            Nama panjang, singkatan, ejaan lain dan jenis setiap lembaga, misalnya Komisi Pemberantasan Korupsi,
            KPK. Saat mengisi jabatan tokoh, kolom lembaga menawarkan namanya; setiap putaran pipeline menautkan
            jabatan ke lembaganya lewat nama mana pun, termasuk ejaan lain.
          </p>
        </header>
        <OrgForm org={null} />
        {orgs.length === 0 ? (
          <p style={{ fontSize: 14, color: MUTED, padding: "16px 0" }}>Belum ada organisasi.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {orgs.map((o) => (
              <li key={o.id} style={{ borderBottom: `1px solid ${RULE}` }}>
                <OrgForm org={o} />
              </li>
            ))}
          </ul>
        )}
        {unlinked.length ? (
          <section style={{ marginTop: 36 }}>
            <h2 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: 22, margin: "0 0 6px" }}>Belum tertaut</h2>
            <p style={{ fontSize: 13.5, color: "var(--color-mud)", margin: "0 0 10px", maxWidth: 640 }}>
              Nama lembaga di jabatan tokoh yang tidak cocok dengan organisasi mana pun pada putaran pipeline terakhir.
              Tambahkan sebagai organisasi atau ejaan lain di atas, atau perbaiki jabatannya bila itu bukan lembaga
              (dapil, pemilu, keterangan).
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, columns: "2 280px", fontSize: 13.5 }}>
              {unlinked.map((u) => (
                <li key={u.org} style={{ padding: "3px 0", breakInside: "avoid" }}>
                  {u.org} <span style={{ color: MUTED }}>· {u.figures} tokoh</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function OrgForm({ org }: { org: Organization | null }) {
  return (
    <form action={editOrganization} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "12px 0" }}>
      {org ? <input type="hidden" name="org_id" value={org.id} /> : null}
      <input
        name="name"
        required
        maxLength={200}
        defaultValue={org?.name ?? ""}
        placeholder="Nama panjang, mis. Komisi Pemberantasan Korupsi"
        aria-label="Nama panjang"
        style={{ ...input, flex: "3 1 260px" }}
      />
      <input
        name="short_name"
        maxLength={60}
        defaultValue={org?.short_name ?? ""}
        placeholder="Singkatan, mis. KPK"
        aria-label="Singkatan"
        style={{ ...input, flex: "1 1 110px" }}
      />
      <select name="kind" defaultValue={org?.kind ?? ""} aria-label="Jenis" style={{ ...input, flex: "0 1 140px" }}>
        <option value="">Jenis…</option>
        {ORG_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input
        name="aliases"
        maxLength={1000}
        defaultValue={org?.aliases.join("; ") ?? ""}
        placeholder="Ejaan lain, pisahkan dengan ; (mis. DPR RI)"
        aria-label="Ejaan lain"
        style={{ ...input, flex: "3 1 240px" }}
      />
      <button type="submit" style={button("ink")}>{org ? "Simpan" : "Tambah"}</button>
      {org ? (
        <>
          <button type="submit" name="op" value="delete" formNoValidate style={button("quiet")}>Hapus</button>
          <span style={{ fontSize: 12.5, color: MUTED }}>{org.figures} tokoh</span>
        </>
      ) : null}
    </form>
  );
}
