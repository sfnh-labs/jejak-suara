import Link from "next/link";
import FigurePortrait from "@/components/FigurePortrait";
import Nav from "@/components/Nav";
import WeekStrip from "@/components/WeekStrip";
import { getFigureWeeks, getFigures } from "@/lib/data";
import { SENTIMENT_GRADIENT, daysAgoLabel, figureDisplayScore, markerLeft, sentimentLabel } from "@/lib/design";
import { GROUPS, groupLabel, groupOf, isGroupId, type GroupId } from "@/lib/groups";
import type { FigureSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Semua tokoh · Jejak Suara",
  description: "Tokoh publik yang kami pantau, diurutkan menurut seberapa sering mereka diberitakan.",
};

const WEEKS = 12;
/** Rows per step of "Muat lagi". */
const STEP = 22;

const SORTS = [
  { id: "aktif", label: "Teraktif 4 minggu" },
  { id: "terbanyak", label: "Terbanyak dicatat" },
  { id: "baru", label: "Baru ditambahkan" },
  { id: "az", label: "A–Z" },
] as const;
type SortId = (typeof SORTS)[number]["id"];

interface Row {
  figure: FigureSummary;
  group: GroupId;
  weeks: number[];
  /** Records in the last four weeks, what "Teraktif" ranks by. */
  recent: number;
}

/** Lower case without accents, so "dedi" finds "Dédi" and "jabar" its alias. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function aliasesOf(f: FigureSummary): string[] {
  // getFigures hands the column over as stored: a JSON array in text.
  const raw: unknown = f.aliases;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const byTime = (a: string | null, b: string | null) => (b ?? "").localeCompare(a ?? "");

const ORDER: Record<SortId, (a: Row, b: Row) => number> = {
  aktif: (a, b) => b.recent - a.recent || byTime(a.figure.last_record_at, b.figure.last_record_at),
  terbanyak: (a, b) => Number(b.figure.event_count) - Number(a.figure.event_count),
  baru: (a, b) => byTime(a.figure.first_record_at, b.figure.first_record_at),
  az: (a, b) => a.figure.name.localeCompare(b.figure.name, "id"),
};

export default async function SemuaTokoh({
  searchParams,
}: {
  searchParams: Promise<{ urut?: string; grup?: string; q?: string; n?: string }>;
}) {
  const params = await searchParams;
  const sort: SortId = SORTS.some((s) => s.id === params.urut) ? (params.urut as SortId) : "aktif";
  const group: GroupId | null = isGroupId(params.grup) ? params.grup : null;
  const q = (params.q ?? "").trim();
  const shown = Math.max(STEP, Math.floor(Number(params.n) / STEP) * STEP || STEP);

  const [figures, weeks] = await Promise.all([getFigures(), getFigureWeeks(WEEKS)]);
  const empty = Array<number>(WEEKS).fill(0);
  const all: Row[] = figures.map((figure) => {
    const w = weeks.get(figure.id) ?? empty;
    return { figure, group: groupOf(figure), weeks: w, recent: w.slice(-4).reduce((a, b) => a + b, 0) };
  });

  const needle = fold(q);
  const rows = all
    .filter((r) => !group || r.group === group)
    .filter(
      (r) =>
        !needle ||
        fold([r.figure.name, r.figure.role, ...aliasesOf(r.figure)].join(" ")).includes(needle)
    )
    .sort(ORDER[sort]);
  const page = rows.slice(0, shown);

  // Every control keeps the others: a sort keeps the group and the search.
  const href = (over: Partial<Record<"urut" | "grup" | "q" | "n", string | null>>) => {
    const p = new URLSearchParams();
    const next = { urut: sort === "aktif" ? null : sort, grup: group, q: q || null, ...over };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/tokoh?${s}` : "/tokoh";
  };

  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav active="/tokoh" crumbs={[{ label: "Beranda", href: "/" }, { label: "Tokoh" }]} />
      <div className="container-page" style={{ maxWidth: 1184 }}>
        <header className="dir-head rule-heavy">
          <div>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Direktori</div>
            <h1 className="dir-title">Semua tokoh.</h1>
            <p className="dir-lede">
              {all.length} tokoh yang kami pantau, diurutkan menurut seberapa sering mereka muncul
              dalam pemberitaan belakangan ini.
            </p>
          </div>
          <form action="/tokoh" method="get" role="search" className="dir-search">
            {sort !== "aktif" ? <input type="hidden" name="urut" value={sort} /> : null}
            {group ? <input type="hidden" name="grup" value={group} /> : null}
            <label className="dir-search-box">
              <svg aria-hidden viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="M13 13l4.5 4.5" strokeLinecap="round" />
              </svg>
              <span className="sr-only">Cari tokoh</span>
              <input type="search" name="q" defaultValue={q} placeholder="Cari nama atau jabatan…" />
            </label>
          </form>
        </header>

        <section aria-labelledby="papan" style={{ paddingTop: 34 }}>
          <div className="dir-board-head">
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Papan aktivitas</div>
              <h2 id="papan" className="dir-board-title">Siapa yang sedang diberitakan.</h2>
            </div>
            <nav aria-label="Urutkan" className="dir-chips">
              {SORTS.map((s) => (
                <Link
                  key={s.id}
                  href={href({ urut: s.id === "aktif" ? null : s.id })}
                  className="dir-chip"
                  aria-current={sort === s.id ? "true" : undefined}
                >
                  {s.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="dir-filter">
            <nav aria-label="Kelompok" className="dir-chips dir-chips--small">
              <Link href={href({ grup: null })} className="dir-chip" aria-current={!group ? "true" : undefined}>
                Semua
              </Link>
              {GROUPS.map((g) => (
                <Link
                  key={g.id}
                  href={href({ grup: g.id })}
                  className="dir-chip"
                  aria-current={group === g.id ? "true" : undefined}
                >
                  {g.label}
                </Link>
              ))}
            </nav>
            <span className="dir-legend" aria-hidden>
              0
              {[0, 1, 2, 3, 4].map((l) => (
                <span key={l} className="wk-cell" data-level={l} />
              ))}
              10+ catatan / minggu
            </span>
          </div>

          <div className="dir-row dir-row--head" aria-hidden>
            <span>#</span>
            <span>Tokoh</span>
            <span>{WEEKS} minggu terakhir</span>
            <span>Catatan</span>
            <span>Reaksi publik</span>
            <span>Terakhir</span>
          </div>

          {page.length ? (
            <ol className="dir-list">
              {page.map((r, i) => {
                const f = r.figure;
                const thisWeek = r.weeks[WEEKS - 1] > 0;
                const reaction = figureDisplayScore(f.figure_stance);
                return (
                  <li key={f.id} className="dir-row" data-week={thisWeek ? "" : undefined}>
                    <span className="dir-rank">{String(i + 1).padStart(2, "0")}</span>
                    <span className="dir-who">
                      <FigurePortrait figureId={f.id} name={f.name} width={38} round fontSize={13} hatchStep={4} />
                      <span style={{ minWidth: 0 }}>
                        <span className="dir-name-line">
                          <Link href={`/tokoh/${f.id}`} className="dir-name">{f.name}</Link>
                          {thisWeek ? <span className="dir-badge">Minggu ini</span> : null}
                        </span>
                        <span className="dir-role">
                          {f.role ? `${f.role} · ` : ""}
                          {groupLabel(r.group)}
                        </span>
                      </span>
                    </span>
                    <span className="dir-weeks">
                      <WeekStrip counts={r.weeks} />
                    </span>
                    <span className="dir-count">
                      {Number(f.event_count).toLocaleString("id-ID")}
                      <span className="dir-count-unit"> catatan</span>
                    </span>
                    <span className="dir-react">
                      {reaction === null ? (
                        <span className="dir-muted">belum ada</span>
                      ) : (
                        <span
                          className="dir-react-track"
                          style={{ background: SENTIMENT_GRADIENT }}
                          role="img"
                          aria-label={`${sentimentLabel(reaction)}, dari ${f.figure_stance.total} komentar`}
                        >
                          <span className="dir-react-mark" style={{ left: markerLeft(reaction) }} />
                        </span>
                      )}
                    </span>
                    <span className="dir-last">{daysAgoLabel(f.last_record_at)}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="dir-empty">
              Tidak ada tokoh yang cocok{q ? ` dengan “${q}”` : ""}.{" "}
              <Link href="/tokoh" className="link-subtle">Lihat semua tokoh</Link>
            </p>
          )}

          <div className="dir-more">
            <span>
              Menampilkan {page.length} dari {rows.length} tokoh
            </span>
            {rows.length > shown ? (
              <Link href={href({ n: String(shown + STEP) })} scroll={false} className="dir-more-btn">
                Muat {Math.min(STEP, rows.length - shown)} lagi
              </Link>
            ) : null}
          </div>
        </section>

        <div className="dir-notes">
          <p>
            <b>{WEEKS} minggu terakhir.</b> Satu kotak satu minggu; makin pekat makin banyak catatan baru.
          </p>
          <p>
            <b>Reaksi publik</b> adalah rata-rata sikap komentator di platform, bukan penilaian kami atas
            tokohnya.
          </p>
          <p>
            <b>Terakhir</b> dihitung dari artikel terbaru yang masuk ke rekam jejak tokoh itu.
          </p>
        </div>
      </div>
    </div>
  );
}
