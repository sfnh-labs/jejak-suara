import Link from "next/link";
import { getOrganizations, type Organization } from "@/lib/curation";
import { editOrganization } from "../actions";
import { MUTED, RULE, button, input } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Organisasi · Kurasi",
  robots: { index: false, follow: false },
};

/**
 * Organisations by their long and short names ("Komisi Pemberantasan
 * Korupsi", "KPK"). The figure editor offers both when filling in the
 * organisation of an office.
 */
export default async function Organisasi() {
  const orgs = await getOrganizations();
  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 880, paddingBottom: 80 }}>
        <header className="rule-heavy" style={{ padding: "clamp(24px, 4vw, 40px) 0 22px" }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Internal · <Link href="/kurasi" style={{ color: MUTED }}>Kurasi</Link>
          </div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "clamp(26px, 4.5vw, 36px)", margin: "0 0 12px" }}>
            Organisasi
          </h1>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--color-mud)", margin: 0, maxWidth: 640 }}>
            Nama panjang dan singkatan setiap lembaga, misalnya Komisi Pemberantasan Korupsi dan KPK. Saat mengisi
            jabatan tokoh, kolom lembaga menawarkan kedua bentuknya.
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
      <button type="submit" style={button("ink")}>{org ? "Simpan" : "Tambah"}</button>
      {org ? (
        <button type="submit" name="op" value="delete" formNoValidate style={button("quiet")}>Hapus</button>
      ) : null}
    </form>
  );
}
