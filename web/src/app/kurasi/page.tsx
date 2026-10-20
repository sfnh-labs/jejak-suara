import Link from "next/link";
import {
  PAGE_SIZE,
  reasonLabel,
  getKindCounts,
  getLatestReport,
  getQueue,
  getQueueCounts,
  type Filter,
  type Kind,
  type QueueRow,
} from "@/lib/curation";
import { EventThumb } from "./EventImage";
import { INK, MUTED, RULE, day } from "./ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kurasi · Jejak Suara",
  robots: { index: false, follow: false },
};

const KINDS: { key: Kind; label: string }[] = [
  { key: "record", label: "Catatan" },
  { key: "peristiwa", label: "Peristiwa" },
];

const FILTERS: { key: Filter; label: string; kinds: Kind[] }[] = [
  { key: "unreviewed", label: "Belum ditinjau", kinds: ["record", "peristiwa"] },
  { key: "suggested", label: "Disarankan turun", kinds: ["record", "peristiwa"] },
  { key: "auto", label: "Disembunyikan otomatis", kinds: ["record", "peristiwa"] },
  { key: "links", label: "Usulan tautan", kinds: ["record"] },
  { key: "followups", label: "Usulan kelanjutan", kinds: ["record", "peristiwa"] },
  { key: "live", label: "Tayang", kinds: ["record", "peristiwa"] },
  { key: "rejected", label: "Diturunkan", kinds: ["record", "peristiwa"] },
];

function href(kind: Kind, filter: Filter, page = 1) {
  return `/kurasi?kind=${kind}&filter=${filter}${page > 1 ? `&page=${page}` : ""}`;
}

export default async function Kurasi({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; filter?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const kind: Kind = sp.kind === "peristiwa" ? "peristiwa" : "record";
  const allowed = FILTERS.filter((f) => f.kinds.includes(kind));
  const filter: Filter = allowed.find((f) => f.key === sp.filter)?.key ?? "unreviewed";
  const page = Math.max(1, Number(sp.page) || 1);

  const [rows, counts, kindCounts, report] = await Promise.all([
    getQueue(kind, filter, page),
    getQueueCounts(kind),
    getKindCounts(),
    getLatestReport(),
  ]);
  const pages = Math.max(1, Math.ceil(counts[filter] / PAGE_SIZE));

  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 880 }}>
        <header className="rule-heavy" style={{ padding: "clamp(24px, 4vw, 40px) 0 22px" }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Internal ·{" "}
            <Link href="/kurasi/kandidat" style={{ color: MUTED }}>Antrean nama baru</Link>
            {" · "}
            <Link href="/kurasi/pelajaran" style={{ color: MUTED }}>Pelajaran model</Link>
            {" · "}
            <Link href="/kurasi/organisasi" style={{ color: MUTED }}>Organisasi</Link>
          </div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 500,
              fontSize: "clamp(26px, 4.5vw, 36px)",
              margin: "0 0 12px",
              letterSpacing: "-0.02em",
            }}
          >
            Kurasi
          </h1>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--color-mud)", margin: 0, maxWidth: 600 }}>
            Satu catatan atau peristiwa per halaman. Dari situ kamu memutus
            apakah ia tayang, siapa tokoh di dalamnya, dan peristiwa mana yang
            menaunginya. Keputusan disimpan di <code style={{ fontSize: 13 }}>jejak.db</code>{" "}
            dan <strong>langsung dipakai pipeline</strong>; situs publik
            mengikutinya pada push berikutnya ke Neon.
          </p>
          {report ? (
            // The nightly `kurasi` stage (jejak/kurasi.py).
            <p style={{ fontSize: 12.5, color: MUTED, margin: "10px 0 0" }}>
              Putaran kurasi terakhir {day(report.run_at)}: {report.drafted.reworks + report.drafted.cv} draf disusun
              {report.drafted.failed ? `, ${report.drafted.failed} gagal` : ""}
              {" · "}{report.learned.summary + report.learned.cv} pelajaran baru, {report.lessons_active} aktif
              {report.name_prefixes.length ? ` · nama diawali ${report.name_prefixes.join(", ")} tidak lagi diajukan` : ""}
              {" · "}<Link href="/kurasi/pelajaran" style={{ color: MUTED }}>lihat pelajaran</Link>
            </p>
          ) : null}
        </header>

        <nav style={{ display: "flex", gap: 22, padding: "18px 0 0", fontSize: 15, fontWeight: 600, fontFamily: "var(--font-serif)" }}>
          {KINDS.map((k) => (
            <Link
              key={k.key}
              href={href(k.key, "unreviewed")}
              style={{
                color: kind === k.key ? INK : MUTED,
                textDecoration: "none",
                paddingBottom: 2,
                borderBottom: `2px solid ${kind === k.key ? INK : "transparent"}`,
              }}
            >
              {k.label}{" "}
              <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: MUTED, fontWeight: 400 }}>
                {kindCounts[k.key]} belum ditinjau
              </span>
            </Link>
          ))}
        </nav>

        <div style={{ display: "flex", gap: 18, padding: "14px 0 6px", fontSize: 13, fontWeight: 600, flexWrap: "wrap" }}>
          {allowed.filter((f) => f.key !== "auto" || counts.auto > 0 || filter === "auto").map((f) => (
            <Link
              key={f.key}
              href={href(kind, f.key)}
              style={{
                color: filter === f.key ? INK : MUTED,
                textDecoration: "none",
                paddingBottom: 2,
                borderBottom: `2px solid ${filter === f.key ? "var(--color-clay)" : "transparent"}`,
              }}
            >
              {f.label} <span style={{ color: MUTED, fontWeight: 400 }}>{counts[f.key]}</span>
            </Link>
          ))}
        </div>

        {rows.length === 0 ? (
          <p style={{ fontSize: 14.5, color: MUTED, padding: "24px 0 60px" }}>
            Tidak ada yang tersisa pada saringan ini.
          </p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: "0 0 24px" }}>
            {rows.map((r) => (
              <QueueItem key={r.event_id} row={r} />
            ))}
          </ol>
        )}

        {pages > 1 ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 13, padding: "0 0 60px", color: MUTED }}>
            {page > 1 ? <Link href={href(kind, filter, page - 1)} style={{ color: INK }}>← Sebelumnya</Link> : null}
            <span>Halaman {page} dari {pages}</span>
            {page < pages ? <Link href={href(kind, filter, page + 1)} style={{ color: INK }}>Berikutnya →</Link> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QueueItem({ row: r }: { row: QueueRow }) {
  return (
    <li style={{ borderBottom: `1px solid ${RULE}` }}>
      <Link
        href={`/kurasi/${r.event_id}`}
        style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "13px 0", color: INK, textDecoration: "none" }}
      >
        {r.kind === "peristiwa" ? <EventThumb eventId={r.event_id} title={r.title} /> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: MUTED, display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
            <span>{day(r.event_date)}</span>
            {r.figure_name || r.figure_id ? (
              <>
                <span>·</span>
                <span style={{ fontWeight: 600, color: "var(--color-mud)" }}>{r.figure_name ?? r.figure_id}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{r.outlet_count} media, {r.article_count} artikel</span>
            {r.outlet_count <= 1 ? (
              <span style={{ color: "var(--color-clay)", fontWeight: 600 }}>⚠ satu sumber</span>
            ) : null}
            {!r.has_summary ? <span>· belum dirangkum</span> : null}
            {r.open_links > 0 ? (
              <span style={{ color: "var(--color-clay)", fontWeight: 600 }}>
                · {r.open_links} usulan tautan
              </span>
            ) : null}
            {r.confirmed_links > 0 ? <span>· {r.confirmed_links} tertaut</span> : null}
            {r.curated ? (
              <span style={{ fontWeight: 600, color: r.curated === "rejected" ? "var(--color-clay)" : MUTED }}>
                · {r.curated === "rejected" ? "diturunkan" : "sudah diperiksa"}
                {r.curated === "rejected" && r.reasons.length > 0 ? `: ${r.reasons.map(reasonLabel).join(", ")}` : ""}
              </span>
            ) : r.suggestion ? (
              <span style={{ fontWeight: 600, color: "#7a5a12" }}>
                · {r.suggestion.auto_hide ? "disembunyikan otomatis" : "saran turun"}
                {r.suggestion.reason ? `: ${reasonLabel(r.suggestion.reason)}` : ""}
                {r.suggestion.confidence !== null ? ` (${Math.round(r.suggestion.confidence * 100)}%)` : ""}
              </span>
            ) : null}
          </div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 16.5, lineHeight: 1.35 }}>
            {r.title ?? `(tanpa judul) #${r.event_id}`}
          </div>
        </div>
      </Link>
    </li>
  );
}
