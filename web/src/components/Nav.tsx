import Link from "next/link";
import { Logo, LogoMark } from "./LogoMark";
import { editionParts } from "@/lib/design";

const LINKS = [
  { href: "/", label: "Beranda" },
  { href: "/linimasa", label: "Linimasa" },
  { href: "/tentang", label: "Dukung Kami" },
];

/**
 * The masthead and the nav strip under it, on every page.
 *
 * The masthead is the wave banner with the logo box on the left and the
 * edition box on the right, both inset to the content column so their edges
 * line up with the page below. It scrolls away; the strip sticks, so the links
 * stay in reach. The strip's active underline sits on its own bottom rule.
 */
export interface Crumb {
  label: string;
  /** Omitted for the current page, the last crumb. */
  href?: string;
}

export default function Nav({
  active,
  stats,
  crumbs,
}: {
  active?: string;
  stats?: string[];
  /** The page's breadcrumb, in the strip's right side where the home page has its counts. */
  crumbs?: Crumb[];
}) {
  const edition = editionParts();
  return (
    <>
      <header className="masthead waves">
        <Link href="/" className="masthead-logo box-stamp" aria-label="Jejak Suara — Beranda">
          <span className="masthead-mark" aria-hidden>
            <LogoMark height={76} tier="L" color="var(--color-cream)" />
          </span>
          <span className="masthead-words">
            <span className="masthead-eyebrow">Portal Rekam Jejak Tokoh Publik</span>
            <span className="masthead-word">Jejak Suara</span>
          </span>
          {/* Phones: the sheet's horizontal lockup in place of the red block. */}
          <span className="masthead-compact">
            <Logo fontSize={30.6} />
          </span>
        </Link>
        <div className="masthead-edition box-stamp" aria-label={`Edisi ${edition.weekday}, ${edition.month}`}>
          <span className="masthead-edition-day">Edisi {edition.weekday}</span>
          <span className="masthead-edition-stamp">{edition.stamp}</span>
          <span className="masthead-edition-month">{edition.month}</span>
        </div>
      </header>

      <div className="nav-strip">
        <div className="nav-strip-inner">
          <nav aria-label="Utama" className="nav-links">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="nav-link"
                aria-current={active === link.href ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          {crumbs?.length ? (
            <nav aria-label="Breadcrumb" className="nav-crumbs">
              {crumbs.map((c, i) => (
                <span key={`${i}-${c.label}`}>
                  {i > 0 ? <span aria-hidden className="nav-crumbs-sep">·</span> : null}
                  {c.href ? (
                    <Link href={c.href} className="link-subtle">{c.label}</Link>
                  ) : (
                    <span aria-current="page" className="nav-crumbs-here">{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
          ) : null}
                    {stats?.length ? (
            <div className="nav-stats">
              {stats.map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
