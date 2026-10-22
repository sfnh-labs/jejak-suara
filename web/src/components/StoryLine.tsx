import Link from "next/link";
import { formatDateShort } from "@/lib/design";
import type { StoryStep } from "@/lib/types";

/**
 * "Lini cerita": the confirmed chain of follow-ups an event belongs to,
 * oldest first, with the event being read marked. Steps link only where the
 * caller has a page to send them to.
 */
export default function StoryLine({
  steps,
  href,
}: {
  steps: StoryStep[];
  href?: (eventId: number) => string;
}) {
  if (steps.length < 2) return null;
  return (
    <div style={{ borderLeft: "3px solid var(--color-parchment)", paddingLeft: 12 }}>
      <div className="section-label" style={{ marginBottom: 6 }}>Lini cerita</div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 5 }}>
        {steps.map((s) => {
          const label = s.title ?? "Tanpa judul";
          return (
            <li key={s.event_id} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13.5, lineHeight: 1.4 }}>
              <span style={{ flex: "0 0 auto", fontSize: 11.5, color: "var(--color-stone)", minWidth: 52 }}>
                {formatDateShort(s.event_date)}
              </span>
              {s.current ? (
                <strong style={{ fontFamily: "var(--font-serif)", fontWeight: 600 }} aria-current="true">{label}</strong>
              ) : href ? (
                <Link href={href(s.event_id)} className="link-subtle" style={{ fontFamily: "var(--font-serif)", color: "var(--color-ink)" }}>
                  {label}
                </Link>
              ) : (
                <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-mud)" }}>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
