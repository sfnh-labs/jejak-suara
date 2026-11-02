"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface Tab {
  href: string;
  label: string;
  count?: string;
  /** Path prefixes that make this tab the current one, besides its own. */
  match: string[];
}

/**
 * The site's nav strip, with the curation tabs in place of the site's links.
 * A client component only to know which tab is current: the layout that
 * renders it does not get the path.
 */
export function NavTabs({ tabs, extra }: { tabs: Tab[]; extra?: Tab[] }) {
  const path = usePathname();
  // The longest prefix wins, so /kurasi/tokoh is Tokoh and not Antrean.
  const all = [...tabs, ...(extra ?? [])];
  const best = all
    .flatMap((t) => t.match.map((m) => ({ t, m })))
    .filter(({ m }) => (m === "/kurasi" ? path === m || /^\/kurasi\/\d+/.test(path) : path === m || path.startsWith(`${m}/`)))
    .sort((a, b) => b.m.length - a.m.length)[0]?.t;
  const item = (t: Tab) => (
    <Link key={t.href} href={t.href} className="nav-link" aria-current={t === best ? "page" : undefined} style={{ whiteSpace: "nowrap" }}>
      {t.label}
      {t.count ? <span style={{ marginLeft: 6, fontWeight: 500, letterSpacing: 0, textTransform: "none", color: "var(--color-stone)" }}>{t.count}</span> : null}
    </Link>
  );
  return (
    <div className="nav-strip">
      <div className="nav-strip-inner">
        <nav aria-label="Kurasi" className="nav-links" style={{ overflowX: "auto", maxWidth: "100%" }}>
          {tabs.map(item)}
        </nav>
        {extra?.length ? <nav aria-label="Lainnya" className="nav-links">{extra.map(item)}</nav> : null}
      </div>
    </div>
  );
}
