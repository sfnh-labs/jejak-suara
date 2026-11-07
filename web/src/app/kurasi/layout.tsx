import Link from "next/link";
import { notFound } from "next/navigation";
import { isCurationHost } from "@/lib/localDb";
import { getNavCounts } from "@/lib/kurasiNav";
import { Masthead } from "@/components/Nav";
import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import { ActionFeedback } from "./ActionFeedback";
import { NavTabs } from "./NavTabs";
import { PanelPending } from "./PanelPending";

/**
 * /kurasi exists only where jejak.db is: the curator's machine, with JEJAK_DB
 * set. The deployed site has no curation pages at all.
 *
 * It wears the site's own chrome, so the tools and the site read as one
 * paper: the masthead, with the curation desk where the edition box sits,
 * and the nav strip, its tabs one per kind of data with what waits in each.
 */
export default async function KurasiLayout({ children }: { children: React.ReactNode }) {
  if (!isCurationHost()) notFound();
  const n = await getNavCounts();
  const num = (x: number) => x.toLocaleString("id-ID");
  return (
    <div style={{ minHeight: "100vh" }}>
      <Masthead
        aside={
          <Link href="/kurasi" className="masthead-edition box-stamp" style={{ color: "var(--color-ink)", textDecoration: "none" }} aria-label={`Meja kurasi: ${num(n.records)} catatan menunggu`}>
            <span className="masthead-edition-day">Meja kurasi</span>
            <span className="masthead-edition-stamp" style={{ fontSize: 38 }}>{num(n.records)}</span>
            <span className="masthead-edition-month">menunggu{n.points ? ` · ${num(n.points)} poin` : ""}</span>
          </Link>
        }
      />
      <NavTabs
        tabs={[
          { href: "/kurasi", label: "Antrean", count: n.points ? `${num(n.points)} poin` : undefined, match: ["/kurasi"] },
          { href: "/kurasi/peristiwa", label: "Peristiwa", count: n.peristiwa ? num(n.peristiwa) : undefined, match: ["/kurasi/peristiwa"] },
          { href: "/kurasi/tokoh", label: "Tokoh", count: num(n.figures), match: ["/kurasi/tokoh"] },
          { href: "/kurasi/lini", label: "Lini cerita", count: n.lini ? `${num(n.lini)} usulan` : undefined, match: ["/kurasi/lini"] },
          { href: "/kurasi/organisasi", label: "Organisasi", count: num(n.organisations), match: ["/kurasi/organisasi"] },
          { href: "/kurasi/kandidat", label: "Nama baru", count: n.names ? num(n.names) : undefined, match: ["/kurasi/kandidat"] },
        ]}
        extra={[{ href: "/kurasi/pelajaran", label: "Pelajaran", match: ["/kurasi/pelajaran"] }]}
      />
      {children}
      <Suspense fallback={null}>
        <PanelPending />
        {/* A fresh stamp on every server render: how the feedback knows an action's new page has arrived. */}
        <ActionFeedback stamp={randomUUID()} />
      </Suspense>
    </div>
  );
}
