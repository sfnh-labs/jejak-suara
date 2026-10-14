/** Shared look for the internal curation pages. */

export const INK = "var(--color-ink)";
export const MUTED = "var(--color-stone)";
export const RULE = "var(--color-parchment)";
export const ACCEPT = "#3d6b4a";

export function button(tone: "accept" | "danger" | "quiet" | "ink") {
  const bg = { accept: ACCEPT, danger: "var(--color-clay)", quiet: "transparent", ink: INK }[tone];
  return {
    fontSize: 12.5,
    fontWeight: 600,
    padding: "6px 13px",
    borderRadius: 3,
    cursor: "pointer",
    border: `1px solid ${tone === "quiet" ? RULE : bg}`,
    background: bg,
    color: tone === "quiet" ? MUTED : "var(--color-cream)",
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

export function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "tanpa tanggal";
}
