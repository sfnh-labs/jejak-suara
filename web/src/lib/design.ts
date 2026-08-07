/**
 * The v2 design system's data-driven bits, in one place.
 *
 * Category colours, event-type chips, outlet monograms and the sentiment scale
 * were previously re-declared in every page file — the two sentiment ladders
 * disagreed, so the same score rendered a different face depending on which
 * page you were on.
 */
import { OUTLET_LOGO_FILES } from "./outlet-logos.generated";

export const PAPER = "#f6f2e9";
export const INK = "#16130f";
export const CLAY = "#8b2e1f";

export const SENTIMENT_GRADIENT =
  "linear-gradient(90deg,#d6453e,#e0a53b 50%,#2e9e6b)";

export interface ChipStyle {
  color: string;
  bg: string;
  border: string;
}

/**
 * Hand-picked colours for the categories common enough to deserve their own —
 * everything else still gets a colour, just a computed one (see below).
 */
export const EVENT_TYPE_CHIPS: Record<string, ChipStyle> = {
  Demonstrasi: { color: "#8b2e1f", bg: "#f5e7e3", border: "#e3c9c1" },
  Debat: { color: "#3a4a8b", bg: "#e8eaf3", border: "#cdd2e6" },
  Kebijakan: { color: "#3d6b4a", bg: "#e6efe8", border: "#bcd6c3" },
  Hukum: { color: "#7a5a2e", bg: "#f1e9da", border: "#dccdb0" },
  Bencana: { color: "#9b6a1f", bg: "#f5ecd9", border: "#e2d0a8" },
  Pemilu: { color: "#6b3a6b", bg: "#efe6ef", border: "#d9c5d9" },
  Ekonomi: { color: "#1f6b6b", bg: "#e0efef", border: "#bcdada" },
};

/** "We don't know the type" — a not-yet-summarized event, nothing else. */
const NEUTRAL_CHIP: ChipStyle = {
  color: "#6b645b",
  bg: "#efe9dc",
  border: "#ddd3bf",
};

/**
 * A stable colour for a category outside the curated set above.
 *
 * `jejak/summarize.py` tags events from an open, growing vocabulary — a
 * lecturer's or an executive's record needs categories no fixed list would
 * anticipate. A hash-derived hue means every distinct tag still gets its own
 * consistent colour instead of collapsing into one flat grey, without a code
 * change each time the pipeline coins a new one. Deterministic (same string,
 * same hue) so server and client render identically and repeat visits don't
 * see a category's colour drift.
 */
function hashedChip(type: string): ChipStyle {
  let h = 0;
  for (let i = 0; i < type.length; i++) {
    h = (h * 31 + type.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return {
    color: `hsl(${hue} 42% 30%)`,
    bg: `hsl(${hue} 45% 93%)`,
    border: `hsl(${hue} 35% 82%)`,
  };
}

export function eventTypeChip(type?: string | null): ChipStyle {
  if (!type || type.toLowerCase() === "other") return NEUTRAL_CHIP;
  return EVENT_TYPE_CHIPS[type] ?? hashedChip(type);
}

/** Fallback monograms, used when an outlet has no bundled icon. */
const OUTLET_LOGOS: Record<string, { mono: string; color: string }> = {
  detikcom: { mono: "d", color: "#1467c8" },
  Detik: { mono: "d", color: "#1467c8" },
  Kompas: { mono: "K", color: "#1a6aa8" },
  Antara: { mono: "A", color: "#c8102e" },
  CNBC: { mono: "C", color: "#13314f" },
  Tempo: { mono: "T", color: "#b01e2e" },
  Republika: { mono: "R", color: "#1f7a4d" },
  Bisnis: { mono: "B", color: "#1f6fb2" },
  "CNN Indonesia": { mono: "C", color: "#cc0000" },
  Kontan: { mono: "K", color: "#e07b00" },
  "BBC News": { mono: "BBC", color: "#bb1919" },
  "The Guardian": { mono: "G", color: "#052962" },
  "Al Jazeera": { mono: "AJ", color: "#fa9000" },
};

export interface OutletMark {
  /** Bundled icon under /outlets, or null when we have none for this source. */
  src: string | null;
  /** Shown when there is no icon, and while/if the icon fails to load. */
  mono: string;
  color: string;
  label: string;
}

/**
 * How a source is identified on a card.
 *
 * Icons are bundled by `scripts/fetch-outlet-logos.mjs`, not hotlinked — see
 * that file for why. Sources with no bundled icon keep the monogram, which is
 * why `mono` and `color` are always populated: the tile has to render something
 * even if the image 404s after a redeploy.
 *
 * YouTube sources are per-channel, so there is no logo to bundle for each one.
 * They share the platform mark instead, which is the useful distinction anyway
 * — a viewer needs to know this came from video, not from an outlet's desk.
 */
export function outletLogo(name: string): OutletMark {
  if (name?.startsWith("YouTube/")) {
    const channel = name.slice("YouTube/".length).trim();
    return { src: null, mono: "▶", color: "#cc0000", label: channel || "YouTube" };
  }
  const known = OUTLET_LOGOS[name];
  return {
    src: OUTLET_LOGO_FILES[name] ?? null,
    mono: known?.mono ?? ((name || "?").trim().charAt(0).toUpperCase() || "?"),
    color: known?.color ?? "#6b645b",
    label: name || "Sumber",
  };
}

/**
 * The single sentiment ladder. Scores are stored in [-1, 1] by
 * `jejak/sentiment.py`; the design works in [-100, 100].
 */
export function toDisplayScore(score: number | null | undefined): number | null {
  if (score === null || score === undefined) return null;
  return Math.round(score * 100);
}

export function sentimentEmoji(display: number): string {
  if (display <= -40) return "😡";
  if (display <= -10) return "🙁";
  if (display < 16) return "😐";
  if (display < 46) return "🙂";
  return "😄";
}

export function sentimentColor(display: number): string {
  if (display <= -10) return "#c0392b";
  if (display < 16) return "#9b7b3f";
  return "#2e7a52";
}

export function sentimentLabel(display: number): string {
  if (display <= -46) return "Mayoritas menolak";
  if (display <= -10) return "Cenderung negatif";
  if (display < 16) return "Terbelah";
  if (display < 46) return "Cenderung positif";
  return "Mayoritas mendukung";
}

/** Marker position along the gradient track, as a CSS percentage. */
export function markerLeft(display: number): string {
  const clamped = Math.max(-100, Math.min(100, display));
  return `${(clamped + 100) / 2}%`;
}

/** Ring colour for the home page story bubbles. */
export function sentimentRing(display: number | null): string {
  if (display === null) return "linear-gradient(135deg,#d8cfba,#e4ddcf)";
  if (display <= -10) return "linear-gradient(135deg,#d6453e,#e7807a)";
  if (display < 16) return "linear-gradient(135deg,#e0a53b,#edc784)";
  return "linear-gradient(135deg,#2e9e6b,#7bc6a0)";
}

const BULAN = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const BULAN_SHORT = [
  "", "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
];

function parts(iso: string | null | undefined) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

export function formatDate(iso: string | null | undefined): string {
  const p = parts(iso);
  return p ? `${p.day} ${BULAN[p.month]} ${p.year}` : "";
}

export function formatDateShort(iso: string | null | undefined): string {
  const p = parts(iso);
  return p ? `${p.day} ${BULAN_SHORT[p.month]} ${p.year}` : "";
}

/** "12 Jun" — the pill that sits on the timeline rail. */
export function dayBadge(iso: string | null | undefined): string {
  const p = parts(iso);
  return p ? `${p.day} ${BULAN_SHORT[p.month]}` : "—";
}

export function monthGroupLabel(iso: string | null | undefined): string {
  const p = parts(iso);
  return p ? `${BULAN[p.month]} ${p.year}` : "Tanpa tanggal";
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Diagonal hatch used for figure portraits — there are no real photos yet. */
export function hatch(step = 6): string {
  return `repeating-linear-gradient(135deg,#e4ddcf,#e4ddcf ${step}px,#ece6d9 ${step}px,#ece6d9 ${step * 2}px)`;
}

export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** Compact Indonesian count: 8100 -> "8,1 rb". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = (n / 1000).toFixed(1).replace(".", ",").replace(",0", "");
    return `${v} rb`;
  }
  const v = (n / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "");
  return `${v} jt`;
}
