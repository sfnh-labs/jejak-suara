import Link from "next/link";
import { INK, MUTED, RULE } from "./ui";

/**
 * The building blocks every /kurasi page is made of. The layout follows the
 * Kurasi Workflow prototype (a main column, a side column, the right-hand
 * drawer); the look is the public site's, so the tools and the site read as
 * one paper: clay eyebrows, serif headlines, uppercase section labels over a
 * double rule, outline pills for links and square tags for states.
 */

/** Pages line up with the site's content column (globals.css --frame-pad). */
export function Page({ children, width }: { children: React.ReactNode; width?: number }) {
  return (
    <div style={{ padding: "26px var(--frame-pad) 120px" }}>
      <div style={{ maxWidth: width, margin: width ? "0 auto" : undefined, display: "flex", flexDirection: "column", gap: 26 }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Title and a line under it, as the public /tokoh board heads its page
 * (globals.css .dir-head): a clay eyebrow, the big serif title, the lede,
 * and the search or actions on the right, over the double rule.
 */
export function PageHead({ title, lede, crumb, actions }: {
  title: React.ReactNode;
  lede?: React.ReactNode;
  crumb?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="dir-head rule-heavy" style={{ paddingTop: 0 }}>
      <div style={{ minWidth: 0 }}>
        {crumb ? <div className="eyebrow" style={{ marginBottom: 12 }}>{crumb}</div> : null}
        <h1 className="dir-title">{title}</h1>
        {lede ? <p className="dir-lede">{lede}</p> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{actions}</div> : null}
    </header>
  );
}

/** The board's square filter chips; the current one is inked (.dir-chip). */
export function ChipNav({ label, items, small = false }: {
  label: string;
  items: { href: string; label: React.ReactNode; count?: React.ReactNode; current: boolean }[];
  small?: boolean;
}) {
  return (
    <nav aria-label={label} className={small ? "dir-chips dir-chips--small" : "dir-chips"}>
      {items.map((it) => (
        <Link key={it.href} href={it.href} className="dir-chip" aria-current={it.current ? "true" : undefined}>
          {it.label}
          {it.count !== undefined ? <span style={{ fontWeight: 500, letterSpacing: 0, marginLeft: 6, opacity: 0.75 }}>{it.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** The board's search box, a GET form; `keep` carries the other filters along. */
export function SearchBox({ action, q, placeholder, label, keep }: {
  action: string;
  q: string;
  placeholder: string;
  label: string;
  keep?: Record<string, string>;
}) {
  return (
    <form action={action} method="get" role="search" className="dir-search">
      {keep ? <Hidden fields={keep} /> : null}
      <label className="dir-search-box">
        <svg aria-hidden viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="M13 13l4.5 4.5" strokeLinecap="round" />
        </svg>
        <span className="sr-only">{label}</span>
        <input type="search" name="q" defaultValue={q} placeholder={placeholder} />
      </label>
    </form>
  );
}

/** The site's page headline. */
export const headline = {
  margin: 0, fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: "clamp(28px, 4.5vw, 38px)", lineHeight: 1.12, letterSpacing: "-0.01em", color: INK,
} as const;

/** The clay kicker over a headline, as on a record page: "PELANTIKAN · 30 SEP 2026". */
export const eyebrow = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-clay)",
} as const;

/** The small uppercase label over a group, as the profile rail's "CATATAN". */
export const groupLabel = {
  fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: MUTED,
} as const;

/** Main column beside a side column; the side drops under it when narrow. */
export function Columns({ main, side, sideWidth = 340 }: { main: React.ReactNode; side: React.ReactNode; sideWidth?: number }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: 44, rowGap: 32, alignItems: "flex-start" }}>
      <div style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 36 }}>{main}</div>
      <div style={{ flex: `1 1 ${sideWidth}px`, minWidth: 0, display: "flex", flexDirection: "column", gap: 36 }}>{side}</div>
    </div>
  );
}

/**
 * A section as the site sets one: its label in small capitals over a double
 * rule ("ARTIKEL SUMBER (47)"), a note, an action on the right, then the body.
 */
export function Card({ id, title, count, note, action, children, flush = false, as = "section" }: {
  id?: string;
  title: React.ReactNode;
  count?: React.ReactNode;
  note?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  /** Rows that carry their own spacing start right under the rule. */
  flush?: boolean;
  as?: "section" | "aside";
}) {
  const Tag = as;
  return (
    <Tag id={id} aria-label={typeof title === "string" ? title : undefined} style={{ scrollMarginTop: "calc(var(--strip-h) + 80px)" }}>
      <div className="rule-heavy" style={{ paddingBottom: 10, display: "flex", gap: 12, alignItems: "flex-end", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="section-label" style={{ margin: 0 }}>
            {title}
            {count !== undefined ? <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: "none", color: MUTED, marginLeft: 8 }}>{count}</span> : null}
          </h2>
          {note ? <p style={{ margin: "5px 0 0", fontSize: 12.5, lineHeight: 1.5, color: MUTED }}>{note}</p> : null}
        </div>
        {action ? <div style={{ flex: "none" }}>{action}</div> : null}
      </div>
      {children ? <div style={flush ? undefined : { paddingTop: 16 }}>{children}</div> : null}
    </Tag>
  );
}

/** One block inside a side section, under its label and an optional action link. */
export function Group({ label, action, children, last = false }: { label: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ padding: "16px 0", borderBottom: last ? "none" : `1px solid ${RULE}`, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <span style={groupLabel}>{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** A text action: clay and bold like the site's action links, or a quiet underlined one. */
export function TextLink({ href, children, tone = "ink" }: { href: string; children: React.ReactNode; tone?: "ink" | "muted" }) {
  return tone === "ink" ? (
    <Link href={href} scroll={false} className="link" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{children}</Link>
  ) : (
    <span style={{ fontSize: 12.5, color: MUTED, whiteSpace: "nowrap" }}>
      <Link href={href} scroll={false} className="link-subtle">{children}</Link>
    </span>
  );
}

export type PillTone = "neutral" | "ink" | "accept" | "danger" | "pending";

export const PILL_LOOK: Record<PillTone, { color: string; background: string; border: string }> = {
  neutral: { color: "var(--color-mud)", background: "var(--color-cream-dark)", border: RULE },
  ink: { color: "var(--color-cream)", background: INK, border: INK },
  accept: { color: "var(--color-sage)", background: "var(--color-sage-bg)", border: "var(--color-sage-border)" },
  danger: { color: "var(--color-clay)", background: "var(--color-warn-bg)", border: "var(--color-warn-border)" },
  pending: { color: "#7a5a12", background: "#fbf1d9", border: "#e6cf96" },
};

/** A state, not a link: square-cornered, as the site keeps rounded pills for links. */
export function Pill({ tone = "neutral", title, children }: { tone?: PillTone; title?: string; children: React.ReactNode }) {
  const look = PILL_LOOK[tone];
  return (
    <span
      title={title}
      style={{
        display: "inline-block", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
        lineHeight: 1.5, padding: "1px 7px", borderRadius: 2, whiteSpace: "nowrap",
        color: look.color, background: look.background, border: `1px solid ${look.border}`,
      }}
    >
      {children}
    </span>
  );
}

/**
 * A name as the site's outline pill: Disebut, Tokoh terkait. A new name,
 * not yet a figure, has a dashed edge; "+n lainnya" is the clay one.
 */
export function Chip({ href, tone = "neutral", children, title }: { href: string; tone?: "neutral" | "pending" | "outline"; children: React.ReactNode; title?: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      title={title}
      className={tone === "outline" ? "pill-link is-primary" : "pill-link"}
      style={{ fontSize: 12.5, padding: "4px 11px", lineHeight: 1.35, ...(tone === "pending" ? { borderStyle: "dashed", borderColor: "var(--color-parchment-dark)" } : {}) }}
    >
      {children}
    </Link>
  );
}

export function Hidden({ fields }: { fields: Record<string, string | number> }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

/**
 * The right-hand drawer: each data model's own form or a read of another
 * record, over the page it was opened from. Named in the URL like every
 * panel here, so it needs no client script; the backdrop and ✕ are links
 * back to the page without it.
 */
export function Drawer({ crumb, title, closeHref, width = 560, aside, children }: {
  crumb: React.ReactNode;
  title: React.ReactNode;
  closeHref: string;
  width?: number;
  /** A link beside the title: "Buka halaman tokoh". */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <Link href={closeHref} scroll={false} aria-label="Tutup panel" tabIndex={-1} style={{ position: "fixed", inset: 0, background: "rgba(22, 19, 15, 0.38)", zIndex: 40 }} />
      <div role="dialog" aria-modal="false" style={{ position: "fixed", top: 0, right: 0, bottom: 0, width, maxWidth: "100%", zIndex: 41, background: "var(--color-cream)", borderLeft: `3px double ${INK}`, boxShadow: "-12px 0 40px rgba(22, 19, 15, 0.25)", display: "flex", flexDirection: "column" }}>
        <div className="rule-heavy" style={{ padding: "18px 24px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={eyebrow}>{crumb}</div>
            <Link href={closeHref} scroll={false} aria-label="Tutup" className="pill-link" style={{ width: 34, height: 34, flex: "none", display: "grid", placeItems: "center" }}>
              <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
            </Link>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 26, lineHeight: 1.15, letterSpacing: "-0.01em" }}>{title}</h2>
            {aside}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "18px 24px 40px", display: "flex", flexDirection: "column", gap: 14 }}>
          {children}
        </div>
      </div>
    </>
  );
}

/** A row in a list: the whole row is the link, tinted on hover like the site's source rows. */
export function RowLink({ href, first, children }: { href: string; first: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className="source-row" style={{ gap: 14, padding: "13px 8px", borderTop: first ? "none" : `1px solid ${RULE}`, borderRadius: 0, color: INK }}>
      {children}
    </Link>
  );
}
