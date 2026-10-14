import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import SourceList from "@/components/SourceList";
import { Quote } from "@/components/RecordCard";
import SentimentTrack from "@/components/SentimentTrack";
import SummaryList, { withoutTitleRepeats } from "@/components/SummaryList";
import {
  getBuzzerSignal,
  getEvent,
  getEventComments,
  getEventNeighbours,
  getRecordPeristiwa,
} from "@/lib/data";
import {
  formatCount,
  formatDate,
  formatDateShort,
  initials,
  percent,
  sentimentColor,
  sentimentLabel,
  toDisplayScore,
} from "@/lib/design";
import type { PublicComment } from "@/lib/types";

export const dynamic = "force-dynamic";

const SIGNAL_LABELS: Record<string, string> = {
  cross_event: "Lintas peristiwa",
  copypasta: "Teks berulang",
  extremity: "Polarisasi ekstrem",
  velocity: "Lonjakan cepat",
  volume: "Volume tidak wajar",
};

const STANCE_STYLE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  positive: { color: "#2e7a52", bg: "#e6efe8", border: "#b6d0bd", label: "Positif" },
  neutral: { color: "#7a6a45", bg: "#efe9dc", border: "#ddd3bf", label: "Netral" },
  negative: { color: "#c0392b", bg: "#f5e7e3", border: "#d8a99f", label: "Negatif" },
};

export default async function DetailCatatan({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id, eventId } = await params;
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId)) notFound();

  const record = await getEvent(numericId);
  if (!record || record.figure_id !== id) notFound();

  const [comments, buzzer, neighbours, partOf] = await Promise.all([
    getEventComments(numericId),
    getBuzzerSignal(numericId),
    getEventNeighbours(id, record.event_date),
    getRecordPeristiwa(numericId),
  ]);

  const display = toDisplayScore(record.sentiment_score);
  const { positive, neutral, negative, total } = record.stance;
  const sources = record.sources ?? [];
  const { title, summary } = withoutTitleRepeats(record.title, record.summary);
  const signals = (buzzer?.signals_triggered ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav />
      <div className="container-page" style={{ maxWidth: 820 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "24px 0 0", flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#8b2e1f" }}>
            {record.event_type ? `${record.event_type} · ` : ""}
            {formatDateShort(record.event_date)}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <NeighbourLink
              href={neighbours.prev ? `/tokoh/${id}/${neighbours.prev.id}` : null}
              label="← Sebelumnya"
              muted
            />
            <NeighbourLink
              href={neighbours.next ? `/tokoh/${id}/${neighbours.next.id}` : null}
              label="Berikutnya →"
            />
          </div>
        </div>

        <h1
          style={{
            fontFamily: "var(--font-serif)",
            fontWeight: 600,
            fontSize: "clamp(28px, 5.5vw, 40px)",
            lineHeight: 1.12,
            margin: "14px 0 10px",
            letterSpacing: "-0.01em",
          }}
        >
          {title || "Tanpa judul"}
        </h1>
        <p style={{ fontSize: 13, color: "#7a7264", margin: "0 0 26px" }}>
          {formatDate(record.event_date)} · tentang{" "}
          <Link href={`/tokoh/${id}`} className="link-subtle" style={{ color: "#16130f", fontWeight: 600 }}>
            {record.figure_name}
          </Link>
        </p>

        {partOf.length > 0 ? (
          // The national story this action belongs to. Confirmed by a curator:
          // clustering keeps a figure's coverage and the general coverage of
          // the same event apart, so nothing else connects the two.
          <div style={{ borderLeft: "3px solid var(--color-parchment)", paddingLeft: 12, margin: "-12px 0 26px" }}>
            <div className="section-label" style={{ marginBottom: 4 }}>Bagian dari peristiwa</div>
            {partOf.map((p) => (
              <div key={p.event_id} style={{ fontFamily: "var(--font-serif)", fontSize: 15.5, lineHeight: 1.45 }}>
                {p.title ?? "Tanpa judul"}
                <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--color-stone)", marginLeft: 8 }}>
                  {formatDateShort(p.event_date)}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {display !== null ? (
          <section className="rule-heavy" style={{ paddingBottom: 22, marginBottom: 26 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 34, color: sentimentColor(display), lineHeight: 1 }}>
                {display > 0 ? "+" : ""}{display}
              </div>
              <div style={{ flex: "1 1 240px", minWidth: 200 }}>
                <SentimentTrack display={display} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, marginTop: 10, fontSize: 12, color: "#7a7264", flexWrap: "wrap" }}>
              <span>{percent(positive, total)}% positif</span>
              <span>{percent(neutral, total)}% netral</span>
              <span>{percent(negative, total)}% negatif</span>
              <span style={{ marginLeft: "auto", color: "#9b9285" }}>
                {formatCount(record.sentiment_sample_size ?? total)} komentar · {sentimentLabel(display)}
              </span>
            </div>
          </section>
        ) : null}

        {record.quote ? <Quote record={record} sources={record.sources ?? []} /> : null}

        {/* A summary whose bullets all repeat the heading has nothing left to
            show, so the section goes rather than claiming none exists. */}
        {summary || !record.summary ? (
          <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 19, fontWeight: 600, margin: "0 0 12px" }}>Ringkasan</h2>
        ) : null}
        {summary ? (
          <SummaryList summary={summary} sources={sources} size={15.5} />
        ) : record.summary ? null : (
          // A record is published as soon as it clusters, so it can arrive here
          // before the summarize stage has run. Say so rather than showing a
          // blank section — the source articles below still carry the story.
          <div style={{ fontSize: 14.5, lineHeight: 1.7, color: "#7a7264", fontStyle: "italic" }}>
            Ringkasan belum tersedia. Baca artikel sumber di bawah.
          </div>
        )}

        {/* No "N artikel sumber" badge: it looked like a button, and the
            Artikel Sumber heading below already gives the count. */}
        <div aria-hidden style={{ height: 34 }} />

        {buzzer && buzzer.anomaly_pct ? (
          <details style={{ background: "#f5e7e3", border: "1px solid #d8a99f", padding: "12px 16px", marginBottom: 34 }}>
            <summary style={{ fontSize: 12.5, fontWeight: 700, color: "#8b2e1f", cursor: "pointer" }}>
              ⚠ {Math.round(buzzer.anomaly_pct)}% komentar menunjukkan pola terkoordinasi
            </summary>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {signals.map((s) => (
                <span
                  key={s}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#8b2e1f",
                    background: "#f6f2e9",
                    border: "1px solid #d8a99f",
                    // Square-cornered: rounded pills on this site are links.
                    borderRadius: 2,
                    padding: "3px 10px",
                  }}
                >
                  {SIGNAL_LABELS[s] ?? s}
                </span>
              ))}
            </div>
            <p style={{ fontSize: 12.5, color: "#7a6a45", lineHeight: 1.6, margin: "12px 0 0" }}>
              Indikator statistik, bukan tuduhan. Pola ini bisa muncul dari
              percakapan organik yang seragam.
            </p>
          </details>
        ) : null}

        <h2 className="section-label rule-heavy" style={{ padding: "0 0 10px", margin: "0 0 16px" }}>
          Artikel Sumber ({sources.length})
        </h2>
        <div style={{ marginBottom: 40 }}>
          <SourceList sources={sources} large />
        </div>

        <h2 className="section-label rule-heavy" style={{ padding: "0 0 10px", margin: "0 0 8px" }}>
          Komentar Publik
        </h2>
        <p style={{ fontSize: 12.5, color: "#7a7264", margin: "0 0 20px", lineHeight: 1.6 }}>
          Reaksi publik di satu platform, apa adanya. Bukan penilaian benar atau
          salah, dan rentan dibanjiri kampanye terkoordinasi.
        </p>
        {comments.length === 0 ? (
          <p style={{ fontSize: 14, color: "#7a7264" }}>Belum ada komentar yang terkumpul untuk catatan ini.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {comments.map((c) => (
              <Comment key={c.id} comment={c} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NeighbourLink({ href, label, muted }: { href: string | null; label: string; muted?: boolean }) {
  const style: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    padding: "5px 12px",
  };
  if (!href) {
    // Square and faded, so it does not read as a link that failed to work.
    return (
      <span style={{ ...style, color: "#bcb3a0", border: "1px solid #e4dcc9", borderRadius: 2 }} aria-disabled>
        {label}
      </span>
    );
  }
  return (
    <Link href={href} className={muted ? "pill-link" : "pill-link is-primary"} style={style}>
      {label}
    </Link>
  );
}

/**
 * Commenters' names are redacted, not replaced ("@Gu**sih" — see
 * jejak/anonymize.py). Plain initials would read "@" for every YouTube handle
 * and "*" for a name short enough to be hidden outright, so the avatar takes
 * the first letters that actually survived the redaction.
 */
function avatarToken(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 1) return initials(name);
  const legible = name.replace(/[^\p{L}\p{N}]/gu, "");
  return legible.slice(0, 2).toUpperCase() || "?";
}

function Comment({ comment }: { comment: PublicComment }) {
  const stance = STANCE_STYLE[comment.stance ?? "neutral"] ?? STANCE_STYLE.neutral;
  const name = comment.author_name || "Anonim";
  const token = avatarToken(name);
  return (
    <li style={{ display: "flex", gap: 12, padding: "16px 0", borderBottom: "1px solid #e4dcc9" }}>
      <div
        aria-hidden
        style={{
          flex: "none",
          width: 38,
          height: 38,
          borderRadius: "50%",
          background: "#efe9dc",
          border: "1px solid #ddd3bf",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: token.length > 2 ? "var(--font-mono, monospace)" : "var(--font-serif)",
          fontSize: token.length > 2 ? 11 : 15,
          letterSpacing: token.length > 2 ? "0.02em" : undefined,
          color: "#9b8f7d",
        }}
      >
        {token}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {name}
            {comment.channel ? (
              <span style={{ fontWeight: 400, color: "#9b9285" }}> di {comment.channel}</span>
            ) : null}
          </span>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: stance.color,
              background: stance.bg,
              border: `1px solid ${stance.border}`,
              borderRadius: 2,
              padding: "1px 7px",
            }}
          >
            {stance.label}
          </span>
          <span style={{ fontSize: 11.5, color: "#9b9285" }}>{formatDateShort(comment.published_at)}</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "#3e382f", margin: "6px 0 0" }}>{comment.text}</p>
        {comment.like_count ? (
          <div style={{ fontSize: 11.5, color: "#9b9285", marginTop: 6 }}>♥ {formatCount(comment.like_count)}</div>
        ) : null}
      </div>
    </li>
  );
}
