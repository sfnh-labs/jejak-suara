import Link from "next/link";
import Nav from "@/components/Nav";
import EventCard from "@/components/EventCard";
import { getPeristiwa, getPeristiwaIndex } from "@/lib/data";
import { monthGroupLabel } from "@/lib/design";
import { TOPICS, isTopicId, topicOf, type TopicId } from "@/lib/topics";
import type { Peristiwa } from "@/lib/types";

/** Cards shown at once; the topic counts still cover every peristiwa. */
const PAGE_SIZE = 120;

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Linimasa · Jejak Suara",
  description: "Peristiwa yang diberitakan banyak media, berurutan dari yang terbaru.",
};

export default async function Linimasa({
  searchParams,
}: {
  searchParams: Promise<{ topik?: string }>;
}) {
  const { topik } = await searchParams;
  const active: TopicId | null = isTopicId(topik) ? topik : null;

  // Classify everything for the counts, then load full cards for the newest
  // PAGE_SIZE in the chosen topic.
  const index = await getPeristiwaIndex();
  const counts = new Map<TopicId, number>();
  const ids: number[] = [];
  for (const row of index) {
    const t = topicOf(row);
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if ((!active || t === active) && ids.length < PAGE_SIZE) ids.push(row.event_id);
  }
  const peristiwa = ids.length ? await getPeristiwa(PAGE_SIZE, ids) : [];

  const groups = new Map<string, Peristiwa[]>();
  for (const p of peristiwa) {
    const key = monthGroupLabel(p.event_date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav active="/linimasa" />
      <div className="container-page" style={{ maxWidth: 820 }}>
        <header className="rule-heavy" style={{ padding: "clamp(28px, 5vw, 48px) 0 26px" }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Peristiwa</div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 500,
              fontSize: "clamp(30px, 5.5vw, 44px)",
              lineHeight: 1.05,
              margin: "0 0 14px",
              letterSpacing: "-0.02em",
            }}
          >
            Linimasa
          </h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.6, color: "var(--color-mud)", margin: 0, maxWidth: 580 }}>
            Peristiwa yang diberitakan secara independen oleh beberapa media.
            Kami tidak menilai mana yang penting — yang tampil di sini adalah
            yang diliput luas.
          </p>
        </header>

        {index.length > 0 ? (
          <nav aria-label="Topik" style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "22px 0 6px" }}>
            <TopicLink href="/linimasa" label="Semua" count={index.length} active={!active} />
            {TOPICS.filter((t) => counts.get(t.id)).map((t) => (
              <TopicLink
                key={t.id}
                href={`/linimasa?topik=${t.id}`}
                label={t.label}
                count={counts.get(t.id)!}
                active={active === t.id}
              />
            ))}
          </nav>
        ) : null}

        {peristiwa.length === 0 ? (
          <p style={{ fontSize: 15, color: "var(--color-stone)", padding: "28px 0 60px", lineHeight: 1.6 }}>
            {active
              ? "Belum ada peristiwa untuk topik ini."
              : "Belum ada peristiwa yang cukup diberitakan untuk ditampilkan."}
          </p>
        ) : (
          [...groups.entries()].map(([month, rows]) => (
            <section key={month}>
              <h2 className="month-heading" style={{ margin: "22px 0 16px" }}>
                {month}
              </h2>
              <div style={{ display: "grid", gap: 16 }}>
                {rows.map((p) => (
                  <EventCard key={p.event_id} peristiwa={p} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function TopicLink({ href, label, count, active }: { href: string; label: string; count: number; active: boolean }) {
  return (
    <Link
      href={href}
      className="pill-link"
      aria-current={active ? "page" : undefined}
      style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px" }}
    >
      {label}
      <span className="pill-count"> {count}</span>
    </Link>
  );
}
