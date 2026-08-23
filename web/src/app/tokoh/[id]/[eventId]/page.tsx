import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import OutletTile from "@/components/OutletTile";
import SentimentTrack from "@/components/SentimentTrack";
import SummaryList from "@/components/SummaryList";
import {
  getBuzzerSignal,
  getEvent,
  getEventComments,
  getEventNeighbours,
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

  const [comments, buzzer, neighbours] = await Promise.all([
    getEventComments(numericId),
    getBuzzerSignal(numericId),
    getEventNeighbours(id, record.event_date),
  ]);

  const display = toDisplayScore(record.sentiment_score);
  const { positive, neutral, negative, total } = record.stance;
  const sources = record.sources ?? [];
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
          {record.title || "Tanpa judul"}
        </h1>
        <p style={{ fontSize: 13, color: "#7a7264", margin: "0 0 26px" }}>
          {formatDate(record.event_date)} · tentang{" "}
          <Link href={`/tokoh/${id}`} className="fig-link" style={{ color: "#16130f", fontWeight: 600 }}>
            {record.figure_name}
          </Link>
        </p>

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

        <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 19, fontWeight: 600, margin: "0 0 12px" }}>Ringkasan</h2>
        {record.summary ? (
          <SummaryList summary={record.summary} size={15.5} />
        ) : (
          // A record is published as soon as it clusters, so it can arrive here
          // before the summarize stage has run. Say so rather than showing a
          // blank section — the source articles below still carry the story.
          <div style={{ fontSize: 14.5, lineHeight: 1.7, color: "#7a7264", fontStyle: "italic" }}>
            Ringkasan belum tersedia. Baca artikel sumber di bawah.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "20px 0 34px" }}>
          {record.single_source_flag ? null : (
            <Badge tone="ok" text={`✓ Dikuatkan ${record.corroboration_count} media`} />
          )}
          <Badge tone="quiet" text={`${sources.length} artikel sumber`} />
        </div>

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
                    borderRadius: 99,
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
        <ol style={{ listStyle: "none", margin: "0 0 40px", padding: 0 }}>
          {sources.map((s, i) => {
            return (
              <li key={s.url} style={{ borderBottom: "1px solid #e4dcc9" }}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "flex", gap: 14, alignItems: "center", padding: "13px 0", textDecoration: "none", color: "inherit" }}
                >
                  <span style={{ flex: "none", fontFamily: "var(--font-serif)", fontSize: 13, color: "#bcb3a0", width: 22 }}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <OutletTile source={s.source} size={26} ring="#f6f2e9" />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{s.title}</span>
                    <span style={{ display: "block", fontSize: 11.5, color: "#7a7264", marginTop: 2 }}>
                      {s.source} · {formatDateShort(s.published_at)}
                    </span>
                  </span>
                  <span style={{ flex: "none", fontSize: 11.5, fontWeight: 600, color: "#8b2e1f" }}>Buka ↗</span>
                </a>
              </li>
            );
          })}
        </ol>

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
    borderRadius: 99,
    border: "1px solid",
    textDecoration: "none",
  };
  if (!href) {
    return (
      <span style={{ ...style, color: "#bcb3a0", borderColor: "#e4dcc9" }} aria-disabled>
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      style={{
        ...style,
        color: muted ? "#7a7264" : "#8b2e1f",
        borderColor: muted ? "#d8cfba" : "#d8a99f",
      }}
    >
      {label}
    </Link>
  );
}

function Badge({ tone, text }: { tone: "ok" | "warn" | "quiet"; text: string }) {
  const tones = {
    ok: { color: "#3d6b4a", bg: "#e6efe8", border: "#b6d0bd" },
    warn: { color: "#8b2e1f", bg: "#f5e7e3", border: "#d8a99f" },
    quiet: { color: "#6b645b", bg: "#efe9dc", border: "#ddd3bf" },
  }[tone];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: tones.color,
        background: tones.bg,
        border: `1px solid ${tones.border}`,
        borderRadius: 2,
        padding: "4px 9px",
      }}
    >
      {text}
    </span>
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
