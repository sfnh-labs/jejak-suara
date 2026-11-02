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
import { Card, ChipNav, Columns, Page, PageHead, Pill, RowLink, type PillTone } from "./kit";
import { ACCEPT, INK, MUTED, RULE, button, day } from "./ui";

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
  { key: "poin", label: "Poin kurasi", kinds: ["record", "peristiwa"] },
  { key: "unreviewed", label: "Belum diperiksa", kinds: ["record", "peristiwa"] },
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

/**
 * The curation hub: catatan with what is waiting on them, the ones whose
 * curation points settle most first; beside it, how often the curator agreed
 * with each kind of point.
 */
export default async function Kurasi({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; filter?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const kind: Kind = sp.kind === "peristiwa" ? "peristiwa" : "record";
  const kindStats = await getKindStats();
  // With points to answer, they are the queue; without, the unreviewed are.
  const allowed = FILTERS.filter((f) => f.kinds.includes(kind) && (f.key !== "poin" || kindStats));
  const filter: Filter = allowed.find((f) => f.key === sp.filter)?.key ?? allowed[0].key;
  const page = Math.max(1, Number(sp.page) || 1);

  const [rows, counts, kindCounts, report] = await Promise.all([
    getQueue(kind, filter, page),
    getQueueCounts(kind),
    getKindCounts(),
    getLatestReport(),
  ]);
  const pointCounts = await getOpenPointCounts(rows.map((r) => r.event_id));
  const pages = Math.max(1, Math.ceil(counts[filter] / PAGE_SIZE));
  const shown = allowed.filter((f) => f.key !== "auto" || counts.auto > 0 || filter === "auto");

  return (
    <Page>
      <PageHead
        crumb="Meja kurasi"
        title={`Antrean ${kind === "record" ? "catatan" : "peristiwa"}.`}
        lede={
          <>
            Pusat kurasi. Buka satu {kind === "record" ? "catatan" : "peristiwa"}; poin kurasinya dan semua yang terkait tampil di dalamnya.
            Keputusan langsung tersimpan di <code style={{ fontSize: 12.5 }}>jejak.db</code>; situs publik mengikutinya pada push berikutnya ke Neon.
          </>
        }
        actions={
          <ChipNav
            label="Jenis"
            items={KINDS.map((k) => ({
              href: href(k.key, filter === "links" && k.key === "peristiwa" ? "unreviewed" : filter),
              label: k.label,
              count: kindCounts[k.key].toLocaleString("id-ID"),
              current: kind === k.key,
            }))}
          />
        }
      />

      <div className="dir-filter" style={{ flexWrap: "wrap" }}>
        <ChipNav
          label="Saringan"
          small
          items={shown.map((f) => ({ href: href(kind, f.key), label: f.label, count: counts[f.key].toLocaleString("id-ID"), current: filter === f.key }))}
        />
      </div>

      <Columns
        sideWidth={340}
        main={
          <>
            <div>
              {rows.length === 0 ? (
                <p style={{ fontSize: 14, color: MUTED, padding: "18px 0", margin: 0 }}>Tidak ada yang tersisa pada saringan ini.</p>
              ) : (
                rows.map((r, i) => <QueueItem key={r.event_id} row={r} first={i === 0} points={pointCounts.get(r.event_id) ?? 0} />)
              )}
            </div>
            {pages > 1 ? (
              <div className="dir-more">
                <span>Halaman {page} dari {pages}</span>
                <span style={{ display: "flex", gap: 12 }}>
                  {page > 1 ? <Link href={href(kind, filter, page - 1)} className="dir-more-btn">← Sebelumnya</Link> : null}
                  {page < pages ? <Link href={href(kind, filter, page + 1)} className="dir-more-btn">Berikutnya →</Link> : null}
                </span>
              </div>
            ) : null}
          </>
        }
        side={
          <>
            {kindStats ? <KindPanel stats={kindStats} /> : null}
            {report ? (
              // The nightly `kurasi` stage (jejak/kurasi.py).
              <p style={{ fontSize: 12, color: MUTED, margin: 0, lineHeight: 1.55 }}>
                Putaran kurasi terakhir {day(report.run_at)}: {report.drafted.reworks + report.drafted.cv} draf disusun
                {report.drafted.failed ? `, ${report.drafted.failed} gagal` : ""}
                {" · "}{report.learned.summary + report.learned.cv} pelajaran baru, {report.lessons_active} aktif
                {report.name_prefixes.length ? ` · nama diawali ${report.name_prefixes.join(", ")} tidak lagi diajukan` : ""}
                {" · "}<Link href="/kurasi/pelajaran" style={{ color: MUTED }}>lihat pelajaran</Link>
              </p>
            ) : null}
          </>
        }
      />
    </Page>
  );
}

function status(r: QueueRow): [PillTone, string] {
  if (r.curated === "rejected") return ["danger", "diturunkan"];
  if (r.curated === "kept") return ["accept", "sudah diperiksa"];
  if (r.suggestion?.auto_hide) return ["pending", "disembunyikan otomatis"];
  return ["pending", "belum diperiksa"];
}

function QueueItem({ row: r, first, points }: { row: QueueRow; first: boolean; points: number }) {
  const [tone, label] = status(r);
  const who = r.actor_names ?? r.figure_name ?? r.figure_id;
  const notes = [
    r.outlet_count <= 1 ? "⚠ satu sumber" : null,
    !r.has_summary ? "belum dirangkum" : null,
    r.open_links > 0 ? `${r.open_links} usulan tautan` : null,
    r.curated === "rejected" && r.reasons.length ? r.reasons.map(reasonLabel).join(", ") : null,
    !r.curated && r.suggestion
      ? `${r.suggestion.auto_hide ? "disembunyikan" : "saran turun"}${r.suggestion.reason ? `: ${reasonLabel(r.suggestion.reason)}` : ""}${r.suggestion.confidence !== null ? ` (${Math.round(r.suggestion.confidence * 100)}%)` : ""}`
      : null,
  ].filter(Boolean);
  return (
    <RowLink href={`/kurasi/${r.event_id}`} first={first}>
      {r.kind === "peristiwa" ? <EventThumb eventId={r.event_id} title={r.title} /> : null}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{r.title ?? `(tanpa judul) #${r.event_id}`}</span>
        <span style={{ display: "block", fontSize: 12.5, color: MUTED, marginTop: 2 }}>
          #{r.event_id}{who ? ` · ${who}` : ""} · {day(r.event_date)} · {r.outlet_count} media
          {notes.length ? <span style={{ color: "#7a5a12" }}> · {notes.join(" · ")}</span> : null}
        </span>
      </span>
      {points > 0 ? <span style={{ fontSize: 12, fontWeight: 600, color: "#7a5a12", whiteSpace: "nowrap" }}>{points} poin</span> : null}
      <Pill tone={tone}>{label}</Pill>
    </RowLink>
  );
}

/**
 * How often the curator agreed with each kind of curation point, and whether
 * it may be answered automatically. The line on each bar is the gate: a band
 * with enough answers past it is what auto-answering acts on.
 */
function KindPanel({ stats }: { stats: KindStats[] }) {
  const waiting = stats.reduce((n, k) => n + k.open, 0);
  const gate = Math.round(AUTO_MIN_AGREEMENT * 100);
  return (
    <Card
      as="aside"
      title="Keyakinan per jenis"
      count={`${waiting.toLocaleString("id-ID")} menunggu`}
      note={`Seberapa sering kamu setuju dengan poin kurasi. Bisa dijawab otomatis setelah ${AUTO_MIN_ANSWERS} jawaban dan ≥${gate}% setuju; 1 dari 20 tetap ditanyakan untuk cek.`}
      flush
    >
      <div style={{ padding: "4px 0 12px" }}>
        {stats.map((k, i) => {
          const pct = k.overall.value === null ? null : Math.round(k.overall.value * 100);
          const eligible = k.buckets.filter((b) => b.eligible).map((b) => b.bucket);
          const off = k.switchedOff;
          const status = k.auto
            ? eligible.length ? `Otomatis untuk pita ${eligible.join(", ")}` : "Otomatis menyala, tapi belum ada pita yang lolos"
            : off ? `Dimatikan sendiri ${day(off.at)}: cek acak setuju ${off.agreed} dari ${off.checked}`
            : eligible.length ? `Siap otomatis untuk pita ${eligible.join(", ")}`
            : k.overall.answered ? `Perlu ${AUTO_MIN_ANSWERS} jawaban dan ≥${gate}% setuju di satu pita`
            : "Belum ada jawaban";
          return (
            <div key={k.kind} style={{ padding: "11px 0", borderTop: i ? `1px solid ${RULE}` : "none", display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {KIND_LABEL[k.kind]} <span style={{ fontWeight: 400, fontSize: 12, color: MUTED }}>· {k.open.toLocaleString("id-ID")} menunggu</span>
                </span>
                <span style={{ fontSize: 12.5, color: "var(--color-mud)", whiteSpace: "nowrap" }}>
                  <strong style={{ color: INK }}>{pct === null ? "–" : `${pct}%`}</strong> · {k.overall.agreed}/{k.overall.answered}
                </span>
              </div>
              <span aria-hidden style={{ position: "relative", display: "block", height: 6, borderRadius: 3, background: "var(--color-cream-dark)" }}>
                <span style={{ position: "absolute", inset: "0 auto 0 0", width: `${pct ?? 0}%`, borderRadius: 3, background: eligible.length ? ACCEPT : "#b9ad94" }} />
                <span style={{ position: "absolute", left: `${AUTO_MIN_AGREEMENT * 100}%`, top: -3, bottom: -3, width: 2, background: INK }} />
              </span>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 12, lineHeight: 1.45, color: off ? "var(--color-clay)" : eligible.length || k.auto ? ACCEPT : MUTED }}>
                  {status}
                  {k.answeredAuto ? ` · ${k.answeredAuto} dijawab otomatis` : ""}
                </span>
                {k.auto || eligible.length ? (
                  <form action={toggleAutoKind}>
                    <input type="hidden" name="kind" value={k.kind} />
                    <input type="hidden" name="on" value={k.auto ? "0" : "1"} />
                    <button type="submit" style={{ ...button(k.auto ? "quiet" : "accept"), minHeight: 30, padding: "5px 10px", fontSize: 12 }}>
                      {k.auto ? "Matikan" : "Nyalakan"}
                    </button>
                  </form>
                ) : null}
              </div>
              {k.buckets.length ? (
                <span style={{ fontSize: 11.5, color: MUTED }}>
                  {k.buckets.map((b) => `${b.bucket} ${b.confidence.agreed}/${b.confidence.answered}`).join(" · ")}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
