import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import RecordCard from "@/components/RecordCard";
import { EventBody } from "@/components/EventCard";
import { getPeristiwaById, getPeristiwaRecords } from "@/lib/data";
import { formatDate } from "@/lib/design";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const peristiwa = Number.isInteger(id) ? await getPeristiwaById(id) : null;
  return { title: `${peristiwa?.title ?? "Peristiwa"} · Jejak Suara` };
}

/**
 * One peristiwa: the event itself, then what each tracked figure said or did
 * in it.
 *
 * The body is the same EventBody the Linimasa card and the home feed's callout
 * show; this page adds only the records a curator linked to it in /kurasi —
 * the reverse of a record page's "Bagian dari peristiwa".
 */
export default async function DetailPeristiwa({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();

  const [peristiwa, records] = await Promise.all([getPeristiwaById(id), getPeristiwaRecords(id)]);
  if (!peristiwa) notFound();

  return (
    <div style={{ minHeight: "100vh" }}>
      <Nav active="/linimasa" />
      <div className="container-page" style={{ maxWidth: 820 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "24px 0 0", flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-clay)" }}>
            Peristiwa · {formatDate(peristiwa.event_date)}
          </div>
          <Link href="/linimasa" className="link-subtle" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-stone)" }}>
            ← Linimasa
          </Link>
        </div>

        {peristiwa.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={peristiwa.image}
            alt=""
            style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block", margin: "16px 0 22px" }}
          />
        ) : (
          <div aria-hidden style={{ height: 14 }} />
        )}

        <div style={{ paddingBottom: 30 }}>
          <EventBody
            peristiwa={peristiwa}
            heading="h1"
            titleSize="clamp(28px, 5.5vw, 40px)"
            size={15.5}
            linkTitle={false}
          />
        </div>

        <section className="rule-heavy" style={{ paddingTop: 22, paddingBottom: 60 }}>
          <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 21, fontWeight: 600, margin: "0 0 6px" }}>
            Tokoh dalam peristiwa ini
          </h2>
          {records.length ? (
            <>
              <p style={{ fontSize: 13, color: "var(--color-stone)", margin: "0 0 22px", lineHeight: 1.5 }}>
                Catatan tokoh yang dipastikan kurator sebagai bagian dari peristiwa ini, dari yang paling awal.
              </p>
              <div>
                {records.map((r) => (
                  <RecordCard key={r.event_id} record={r} showFigure />
                ))}
              </div>
            </>
          ) : (
            <p style={{ fontSize: 14, color: "var(--color-stone)", margin: 0, lineHeight: 1.6 }}>
              Belum ada catatan tokoh yang dikaitkan dengan peristiwa ini.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
