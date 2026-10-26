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
import { AUTO_MIN_AGREEMENT, AUTO_MIN_ANSWERS, KIND_LABEL, getKindStats, getOpenPointCounts, type KindStats } from "@/lib/curationPoints";
import { toggleAutoKind } from "./actions";
import { EventThumb } from "./EventImage";
import { ACCEPT, INK, MUTED, RULE, SURFACE, button, day } from "./ui";

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
  { key: "poin", label: "Poin kurasi", kinds: ["record", "peristiwa"] },
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

  const [rows, counts, kindCounts, report, kindStats] = await Promise.all([
    getQueue(kind, filter, page),
    getQueueCounts(kind),
    getKindCounts(),
    getLatestReport(),
    getKindStats(),
  ]);
  const pointCounts = await getOpenPointCounts(rows.map((r) => r.event_id));
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
          {allowed.filter((f) => (f.key !== "auto" || counts.auto > 0 || filter === "auto") && (f.key !== "poin" || kindStats)).map((f) => (
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

        {kindStats ? <KindPanel stats={kindStats} /> : null}

        {rows.length === 0 ? (
          <p style={{ fontSize: 14.5, color: MUTED, padding: "24px 0 60px" }}>
            Tidak ada yang tersisa pada saringan ini.
          </p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: "0 0 24px" }}>
            {rows.map((r) => (
              <QueueItem key={r.event_id} row={r} points={pointCounts.get(r.event_id) ?? 0} />
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

function QueueItem({ row: r, points }: { row: QueueRow; points: number }) {
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
            {points > 0 ? <span style={{ color: "#7a5a12", fontWeight: 600 }}>· {points} poin kurasi</span> : null}
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

/**
 * How often the curator agreed with each kind of curation point, and whether
 * it may be answered automatically. The line on each bar is the gate: a band
 * with enough answers past it is what auto-answering acts on.
 */
function KindPanel({ stats }: { stats: KindStats[] }) {
  const waiting = stats.reduce((n, k) => n + k.open, 0);
  return (
    <details style={{ margin: "10px 0 6px", border: `1px solid ${RULE}`, borderRadius: 6, background: SURFACE }}>
      <summary style={{ cursor: "pointer", padding: "10px 14px", fontSize: 13, fontWeight: 600 }}>
        Keyakinan per jenis poin{" "}
        <span style={{ fontWeight: 400, color: MUTED }}>· {waiting} poin menunggu</span>
      </summary>
      <div style={{ padding: "0 14px 12px" }}>
        <p style={{ fontSize: 12, color: MUTED, margin: "0 0 6px", lineHeight: 1.5 }}>
          Seberapa sering kamu setuju dengan penilaian pipeline. Sebuah pita bisa dijawab otomatis setelah{" "}
          {AUTO_MIN_ANSWERS} jawaban dan ≥{Math.round(AUTO_MIN_AGREEMENT * 100)}% setuju; 1 dari 20 tetap ditanyakan untuk cek.
        </p>
        {stats.map((k, i) => {
          const pct = k.overall.value === null ? null : Math.round(k.overall.value * 100);
          const eligible = k.buckets.filter((b) => b.eligible).map((b) => b.bucket);
          const off = k.switchedOff;
          const status = k.auto
            ? eligible.length ? `Otomatis untuk pita ${eligible.join(", ")}` : "Otomatis menyala, tapi belum ada pita yang lolos"
            : off ? `Dimatikan sendiri ${day(off.at)}: cek acak setuju ${off.agreed} dari ${off.checked}`
            : eligible.length ? `Siap otomatis untuk pita ${eligible.join(", ")}`
            : k.overall.answered ? `Belum ada pita dengan ${AUTO_MIN_ANSWERS} jawaban dan ≥${Math.round(AUTO_MIN_AGREEMENT * 100)}% setuju`
            : "Belum ada jawaban";
          return (
            <div key={k.kind} style={{ padding: "10px 0", borderTop: i ? `1px solid ${RULE}` : "none", display: "grid", gap: 5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {KIND_LABEL[k.kind]} <span style={{ fontWeight: 400, fontSize: 12, color: MUTED }}>· {k.open} menunggu</span>
                </span>
                <span style={{ fontSize: 12.5, color: MUTED }}>
                  <strong style={{ color: INK }}>{pct === null ? "–" : `${pct}%`}</strong> · {k.overall.agreed}/{k.overall.answered}
                </span>
              </div>
              <span aria-hidden style={{ position: "relative", display: "block", height: 6, borderRadius: 3, background: "var(--color-cream-dark)" }}>
                <span style={{ position: "absolute", inset: "0 auto 0 0", width: `${pct ?? 0}%`, borderRadius: 3, background: eligible.length ? ACCEPT : "#b9ad94" }} />
                <span style={{ position: "absolute", left: `${AUTO_MIN_AGREEMENT * 100}%`, top: -3, bottom: -3, width: 2, background: INK }} />
              </span>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: off ? "var(--color-clay)" : eligible.length ? ACCEPT : MUTED }}>
                  {status}
                  {k.answeredAuto ? ` · ${k.answeredAuto} dijawab otomatis` : ""}
                  {k.buckets.length ? ` · ${k.buckets.map((b) => `${b.bucket} ${b.confidence.agreed}/${b.confidence.answered}`).join(" · ")}` : ""}
                </span>
                {k.auto || eligible.length ? (
                  <form action={toggleAutoKind}>
                    <input type="hidden" name="kind" value={k.kind} />
                    <input type="hidden" name="on" value={k.auto ? "0" : "1"} />
                    <button type="submit" style={button(k.auto ? "quiet" : "accept")}>{k.auto ? "Matikan otomatis" : "Nyalakan otomatis"}</button>
                  </form>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
