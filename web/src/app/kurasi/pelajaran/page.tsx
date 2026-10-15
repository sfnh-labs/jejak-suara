import Link from "next/link";
import { getLatestReport, getLessons, type Lesson } from "@/lib/curation";
import { toggleLesson } from "../actions";
import { INK, MUTED, RULE, SURFACE, button, day } from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Pelajaran model · Kurasi",
  robots: { index: false, follow: false },
};

/**
 * What the local model has learned from the curator (jejak/kurasi.py): each
 * accepted rework or corrected CV draft, shown to the model as a worked
 * example the next time it writes something similar. A lesson that teaches
 * the wrong thing is switched off here.
 */
export default async function Pelajaran() {
  const [lessons, report] = await Promise.all([getLessons(), getLatestReport()]);
  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="container-page" style={{ maxWidth: 880, paddingBottom: 80 }}>
        <header className="rule-heavy" style={{ padding: "clamp(24px, 4vw, 40px) 0 22px" }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Internal · <Link href="/kurasi" style={{ color: MUTED }}>Kurasi</Link>
          </div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "clamp(26px, 4.5vw, 36px)", margin: "0 0 12px" }}>
            Pelajaran model
          </h1>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--color-mud)", margin: 0, maxWidth: 640 }}>
            Setiap draf ulang yang kamu terima, dan setiap draf CV yang kamu koreksi, menjadi contoh bagi model
            lokal: draf yang keliru, catatanmu, dan versi yang diterima. Saat menulis entri yang mirip (tokoh
            sama atau kata-kata khas yang sama), model diperlihatkan dua contoh terdekat. Matikan pelajaran yang
            justru mengajarkan hal keliru.
          </p>
          {report ? (
            <p style={{ fontSize: 12.5, color: MUTED, margin: "10px 0 0" }}>
              Putaran terakhir {day(report.run_at)} · {report.labels} alasan penurunan dipakai saran otomatis
              {report.name_prefixes.length ? ` · nama diawali ${report.name_prefixes.join(", ")} tidak diajukan lagi` : ""}
            </p>
          ) : null}
        </header>
        {lessons.length === 0 ? (
          <p style={{ fontSize: 14, color: MUTED, padding: "24px 0" }}>
            Belum ada pelajaran. Pelajaran muncul setelah kamu menerima draf “Kerjakan ulang” atau mengoreksi draf
            “Jadikan info CV”, dan putaran kurasi berikutnya berjalan.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {lessons.map((l) => <LessonItem key={l.id} lesson={l} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function LessonItem({ lesson: l }: { lesson: Lesson }) {
  const box = { background: SURFACE, border: `1px solid ${RULE}`, borderRadius: 6, padding: "8px 10px", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-line" as const, margin: 0 };
  return (
    <li style={{ padding: "16px 0", borderBottom: `1px solid ${RULE}`, opacity: l.active ? 1 : 0.55 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: INK }}>{l.kind === "summary" ? "Judul & ringkasan" : "Info CV"}</strong>
        {l.figure_id ? <span style={{ fontSize: 12, color: MUTED }}>{l.figure_id}</span> : null}
        {l.event_id ? <Link href={`/kurasi/${l.event_id}`} style={{ fontSize: 12, color: MUTED }}>catatan #{l.event_id}</Link> : null}
        <span style={{ fontSize: 12, color: MUTED }}>{day(l.created_at)}</span>
        <span style={{ flex: 1 }} />
        <form action={toggleLesson}>
          <input type="hidden" name="lesson_id" value={l.id} />
          <input type="hidden" name="active" value={l.active ? "0" : "1"} />
          <button type="submit" style={button("quiet")}>{l.active ? "Matikan" : "Aktifkan lagi"}</button>
        </form>
      </div>
      {l.note ? <p style={{ fontSize: 13.5, margin: "0 0 8px", color: "var(--color-mud)" }}>Catatanmu: “{l.note}”</p> : null}
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        <div><div style={{ fontSize: 11, color: MUTED, marginBottom: 3 }}>Draf model</div><p style={box}>{l.wrong}</p></div>
        <div><div style={{ fontSize: 11, color: MUTED, marginBottom: 3 }}>Yang diterima</div><p style={box}>{l.right}</p></div>
      </div>
    </li>
  );
}
