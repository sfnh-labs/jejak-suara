import { formatDateShort } from "@/lib/design";

/** Shared look for the internal curation pages. */

export const INK = "var(--color-ink)";
export const MUTED = "var(--color-stone)";
export const RULE = "var(--color-parchment)";
export const ACCEPT = "var(--color-sage)";
/** Card surface: one step lighter than the cream page, so a section reads as a block. */
export const SURFACE = "#fffdf8";

export function button(tone: "accept" | "danger" | "quiet" | "ink") {
  const bg = { accept: ACCEPT, danger: "var(--color-clay)", quiet: "transparent", ink: INK }[tone];
  // The site's voice for controls: small tracked capitals, square corners.
  return {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "8px 14px",
    minHeight: 36,
    borderRadius: 2,
    cursor: "pointer",
    border: `1px solid ${tone === "quiet" ? "var(--color-parchment-dark)" : bg}`,
    background: bg,
    color: tone === "quiet" ? INK : "var(--color-cream)",
  } as const;
}

export const input = {
  fontSize: 13,
  padding: "6px 9px",
  border: `1px solid ${RULE}`,
  borderRadius: 3,
  background: "#fffdf8",
  color: INK,
  minWidth: 0,
} as const;

export const label = {
  fontSize: 11.5,
  color: MUTED,
  display: "grid",
  gap: 3,
} as const;

export const sectionLabel = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--color-stone-light)",
  margin: "0 0 10px",
} as const;

/** A date as the site writes one: "2 Nov 2026". */
export function day(iso: string | null): string {
  return formatDateShort(iso) || "tanpa tanggal";
}
