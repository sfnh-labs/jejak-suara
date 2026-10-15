import Link from "next/link";
import {
  getCandidateCounts,
  getCandidates,
  type CandidateFilter,
  type CandidateRow,
} from "@/lib/candidates";
import { AcceptCandidateForm } from "../AcceptCandidateForm";
import { annotate, decide, rejectMany } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kandidat Tokoh · Jejak Suara",
  robots: { index: false, follow: false },
};

const TABS: { key: CandidateFilter; label: string }[] = [
  { key: "undecided", label: "Belum diputus" },
  { key: "promote", label: "Diterima" },
  { key: "reject", label: "Ditolak" },
  { key: "all", label: "Semua" },
];

const INK = "var(--color-ink)";
const MUTED = "var(--color-stone)";
const RULE = "var(--color-parchment)";

function button(tone: "accept" | "danger" | "quiet") {
  const bg = { accept: "#3d6b4a", danger: "var(--color-clay)", quiet: "transparent" }[tone];
  return {
    fontSize: 12.5,
    fontWeight: 600,
    padding: "6px 13px",
    borderRadius: 3,
    cursor: "pointer",
    border: `1px solid ${tone === "quiet" ? RULE : bg}`,
    background: bg,
    color: tone === "quiet" ? MUTED : "var(--color-cream)",
  } as const;
}

const input = {
  fontSize: 13,
  padding: "6px 9px",
  border: `1px solid ${RULE}`,
  borderRadius: 3,
  background: "#fffdf8",
  color: INK,
  minWidth: 0,
} as const;

export default async function KandidatTokoh({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: raw } = await searchParams;
  const filter: CandidateFilter =
    raw === "promote" || raw === "reject" || raw === "all" ? raw : "undecided";

  const [rows, counts] = await Promise.all([
    getCandidates(filter),
    getCandidateCounts(),
  ]);

  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 860 }}>
        <header className="rule-heavy" style={{ padding: "clamp(24px, 4vw, 40px) 0 22px" }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Internal · <Link href="/kurasi" style={{ color: MUTED }}>Kurasi catatan</Link>
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
            Kandidat Tokoh
          </h1>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--color-mud)", margin: 0, maxWidth: 620 }}>
            Nama-nama yang cukup sering disebut media tapi belum menjadi tokoh.
            Di sini cukup <strong>menyaring</strong>: centang yang jelas bukan
            orang (&ldquo;Dasar&rdquo;, &ldquo;Lalu&rdquo;, separuh jabatan)
            lalu tolak sekaligus. Yang mungkin orang, buka{" "}
            <strong>Periksa di catatan</strong> — diterima di sana, di samping
            liputannya. Keputusan langsung berlaku di pipeline; tokoh baru
            tampil di situs setelah push berikutnya.
          </p>
        </header>

        <div style={{ display: "flex", gap: 18, padding: "18px 0", fontSize: 13, fontWeight: 600, flexWrap: "wrap" }}>
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              href={`/kurasi/kandidat?filter=${tab.key}`}
              style={{
                color: filter === tab.key ? INK : MUTED,
                textDecoration: "none",
                paddingBottom: 2,
                borderBottom: `2px solid ${filter === tab.key ? "var(--color-clay)" : "transparent"}`,
              }}
            >
              {tab.label} <span style={{ color: MUTED, fontWeight: 400 }}>{counts[tab.key]}</span>
            </Link>
          ))}
        </div>

        {rows.length === 0 ? (
          <p style={{ fontSize: 14.5, color: MUTED, padding: "24px 0 60px" }}>
            Tidak ada kandidat pada saringan ini. Jalankan{" "}
            <code>python scripts/sync_to_neon.py --push</code> kalau antrean
            lokal belum terkirim.
          </p>
        ) : (
          <div style={{ paddingBottom: 60 }}>
            {filter === "undecided" ? (
              <form
                id={BULK}
                action={rejectMany}
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                  padding: "10px 0",
                  background: "var(--color-cream)",
                  borderBottom: `1px solid ${RULE}`,
                }}
              >
                <button type="submit" style={button("danger")}>Tolak yang dicentang</button>
                <span style={{ fontSize: 12, color: MUTED }}>
                  Urut dari yang paling banyak disebut media.
                </span>
              </form>
            ) : null}
            {rows.map((r) => (
              <CandidateItem key={r.slug} row={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The candidate's name, marked where it appears in the quoted sentence. */
function highlight(text: string, name: string) {
  const at = text.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <strong style={{ background: "#f3e6c9", color: INK }}>
        {text.slice(at, at + name.length)}
      </strong>
      {text.slice(at + name.length)}
    </>
  );
}

/** The bulk-reject form. Rows tick into it from outside, by `form=`, because
 *  each row already holds forms of its own and forms cannot nest. */
const BULK = "tolak-massal";

/**
 * One name, as a line to triage rather than a form to fill.
 *
 * Accepting happens on the record page, beside the coverage the name came
 * from; this row only says whether that is worth opening. A name no record
 * carries has nowhere to send the curator, so it keeps the form here.
 */
function CandidateItem({ row: r }: { row: CandidateRow }) {
  const decided = r.verdict !== null;
  const context = r.headlines.map((h) => h.context).find((c): c is string => Boolean(c));
  const [first, ...others] = r.records;
  return (
    <article style={{ display: "flex", gap: 12, padding: "16px 0", borderBottom: `1px solid ${RULE}` }}>
      <div style={{ width: 20, flex: "none", paddingTop: 4 }}>
        {decided ? null : (
          <input
            type="checkbox"
            name="slug"
            value={r.slug}
            form={BULK}
            aria-label={`Tolak ${r.name}`}
            style={{ width: 16, height: 16, cursor: "pointer" }}
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 2 }}>
          <h2 style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 18, margin: 0 }}>
            {r.name}
          </h2>
          <span style={{ fontSize: 12, color: MUTED }}>
            {r.outlets} media · {r.mentions} penyebutan
            {r.role ? ` · disebut sebagai ${r.role}` : ""}
          </span>
          {r.verdict ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: r.verdict === "promote" ? "#3d6b4a" : "var(--color-clay)",
              }}
            >
              {r.verdict === "promote" ? "diterima" : "ditolak"}
            </span>
          ) : null}
        </div>

        {context ? (
          // The sentence that produced the name — usually enough on its own:
          // "Jaksa Agung ST Burhanuddin" says at once that "Agung" is half an
          // office.
          <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--color-mud)", margin: "4px 0 8px", borderLeft: `3px solid ${RULE}`, paddingLeft: 10 }}>
            {highlight(context, r.name)}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {decided ? (
            <>
              {r.verdict === "promote" ? (
                <span style={{ fontSize: 13, color: "var(--color-mud)" }}>
                  Akan tampil sebagai <strong>{r.full_name || r.name}</strong>
                  {r.curated_role || r.role ? ` · ${r.curated_role || r.role}` : ""}
                </span>
              ) : null}
              {/* A promote made a figure; it is retired on its own page, not undone here. */}
              {r.verdict === "reject" ? (
                <form action={decide}>
                  <input type="hidden" name="slug" value={r.slug} />
                  <input type="hidden" name="verdict" value="" />
                  <button type="submit" style={button("quiet")}>Batalkan penolakan</button>
                </form>
              ) : null}
            </>
          ) : (
            <>
              {first ? (
                <Link href={`/kurasi/${first.id}#nama-${r.slug}`} style={{ ...button("accept"), textDecoration: "none" }}>
                  Periksa di catatan →
                </Link>
              ) : null}
              <form action={decide}>
                <input type="hidden" name="slug" value={r.slug} />
                <input type="hidden" name="verdict" value="reject" />
                <button type="submit" style={button("danger")}>Tolak</button>
              </form>
            </>
          )}
          {first ? (
            <span style={{ fontSize: 12, color: MUTED, minWidth: 0 }}>
              {first.title}
              {others.length ? ` · +${others.length} catatan lain` : ""}
            </span>
          ) : null}
        </div>

        {!decided && !first ? (
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 12, fontWeight: 700, color: MUTED, cursor: "pointer" }}>
              Tidak ada di catatan mana pun — terima di sini
            </summary>
            <div style={{ marginTop: 10 }}>
              <AcceptCandidateForm slug={r.slug} name={r.name} role={r.role} withReject={false} />
            </div>
          </details>
        ) : null}

        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, cursor: "pointer" }}>
            Bukti dan catatan{r.notes ? " · ada catatan" : ""}
          </summary>
          {others.length ? (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13.5, lineHeight: 1.55, fontFamily: "var(--font-serif)" }}>
              {r.records.map((rec) => (
                <li key={rec.id}>
                  <Link href={`/kurasi/${rec.id}#nama-${r.slug}`} style={{ color: INK }}>{rec.title}</Link>
                </li>
              ))}
            </ul>
          ) : null}
          {r.headlines.length > 0 ? (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "var(--color-mud)" }}>
              {r.headlines.map((h, i) => (
                <li key={i}>
                  {h.source ? (
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: MUTED, marginRight: 6 }}>{h.source}</span>
                  ) : null}
                  {h.url ? (
                    <a href={h.url} target="_blank" rel="noreferrer" style={{ color: "var(--color-mud)" }}>{h.title}</a>
                  ) : (
                    h.title
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {/* Kept apart from the verdict: the note is what the next round of
              extractor tuning reads, so it outlives a cleared decision. */}
          <form action={annotate} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
            <input type="hidden" name="slug" value={r.slug} />
            <label style={{ fontSize: 11.5, color: MUTED, display: "grid", gap: 3, flex: "1 1 360px", minWidth: 0 }}>
              Catatan — apa yang kamu lihat di sini
              <textarea
                name="notes"
                rows={2}
                defaultValue={r.notes ?? ""}
                placeholder="mis. ini pangkat polisi, bukan nama · orang yang sama dengan tokoh X"
                style={{ ...input, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
                aria-label={`Catatan untuk ${r.name}`}
              />
            </label>
            <button type="submit" style={button("quiet")}>Simpan catatan</button>
          </form>
        </details>
      </div>
    </article>
  );
}
