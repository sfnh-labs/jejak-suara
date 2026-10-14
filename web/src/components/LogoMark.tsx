import type { CSSProperties } from "react";
import { CLAY, INK } from "@/lib/design";

/**
 * The footprint mark and the Jejak Suara lockups, as drawn on the Logo sheet
 * ("Lembar Logo" on the design canvas).
 *
 * The mark comes in four tiers, each drawn for its size: smaller tiers have
 * fewer, thicker voice lines and drop from five toes to four. A large tier
 * scaled down turns to mush, so a size always picks its own tier rather than
 * shrinking a bigger one. Toes stay round at every size.
 */

type Rect = [x: number, y: number, w: number, h: number];
type Toe = [cx: number, cy: number, r: number];

interface Tier {
  rects: Rect[];
  toes: Toe[];
  /** The mark's own bounds, for use beside a wordmark. */
  crop: string;
}

const TIERS = {
  // ≥ 64px · 8 lines · 5 toes
  L: {
    rects: [
      [20.79, 19.28, 20.97, 2.4], [14.18, 24.25, 32.74, 2.4], [17.72, 29.23, 27.08, 2.4],
      [24.55, 34.2, 19.18, 2.4], [24.78, 39.18, 17.47, 2.4], [23.7, 44.15, 17.77, 2.4],
      [23.27, 49.13, 18.61, 2.4], [27.07, 54.1, 11.54, 2.4],
    ],
    toes: [[17.7, 12.66, 5.16], [28.8, 12.46, 3.53], [37.41, 13.26, 3.01], [44.51, 15.66, 2.58], [49.3, 19.96, 2.15]],
    crop: "12.55 7.50 38.91 49.01",
  },
  // 36–48px · 6 lines · 5 toes; also the lockup's mark
  M: {
    rects: [
      [19.49, 19.92, 23.12, 3.2], [14.52, 26.55, 32.58, 3.2], [23.85, 33.19, 20.11, 3.2],
      [25.96, 39.82, 14.63, 3.2], [23.46, 46.45, 18.09, 3.2], [27.17, 53.09, 11.21, 3.2],
    ],
    toes: [[17.7, 12.87, 5.16], [28.8, 12.67, 3.53], [37.41, 13.47, 3.01], [44.51, 15.87, 2.58], [49.3, 20.17, 2.15]],
    crop: "12.55 7.71 38.91 48.58",
  },
  // 24–32px · 5 lines · 4 toes
  S: {
    rects: [
      [17.67, 20.05, 28.09, 4.6], [16.35, 28.01, 31.23, 4.6], [25.66, 35.97, 18.53, 4.6],
      [24.78, 43.93, 17.23, 4.6], [28.22, 51.89, 10.68, 4.6],
    ],
    toes: [[18.64, 12.84, 5.33], [30.74, 12.34, 3.87], [40.34, 13.64, 3.27], [47.94, 17.24, 2.75]],
    crop: "13.31 7.51 37.38 48.98",
  },
  // 16px · 4 lines · 4 toes
  XS: {
    rects: [[15.61, 20.78, 29.47, 6], [19.52, 30.73, 25.99, 6], [24.45, 40.68, 16.2, 6], [27.32, 50.63, 10.04, 6]],
    toes: [[17.48, 12.87, 5.5], [30.88, 12.37, 3.96], [41.48, 14.47, 3.27], [49.27, 19.77, 2.75]],
    crop: "11.98 7.37 40.04 49.26",
  },
} satisfies Record<string, Tier>;

export type TierName = keyof typeof TIERS;

/** The tier drawn for a mark this many pixels tall. */
export function tierFor(px: number): TierName {
  if (px >= 64) return "L";
  if (px >= 26) return "M";
  if (px >= 17) return "S";
  return "XS";
}

/** The mark's shapes, for an `<svg>` built elsewhere (icons, OG image). */
export function markShapes(tier: TierName, fill: string) {
  const t = TIERS[tier];
  return (
    // As a style, not the attribute: a presentation attribute takes no var().
    <g style={{ fill }}>
      {t.rects.map(([x, y, w, h], i) => (
        <rect key={`r${i}`} x={x} y={y} width={w} height={h} rx={h / 2} />
      ))}
      {t.toes.map(([cx, cy, r], i) => (
        <circle key={`c${i}`} cx={cx} cy={cy} r={r} />
      ))}
    </g>
  );
}

export function markCrop(tier: TierName): string {
  return TIERS[tier].crop;
}

/** On a dark ground the red would sink; the sheet swaps it for this orange. */
export const MARK_ON_DARK = "#E0714F";

/**
 * The mark alone. `height` is the drawn height; `crop` trims it to its own
 * bounds (beside a wordmark, inside a block), otherwise it sits in its 64-unit
 * square (icons).
 */
export function LogoMark({
  height,
  color = CLAY,
  crop = true,
  tier,
  style,
}: {
  height: number;
  color?: string;
  crop?: boolean;
  tier?: TierName;
  style?: CSSProperties;
}) {
  const name = tier ?? tierFor(height);
  const viewBox = crop ? TIERS[name].crop : "0 0 64 64";
  const [, , vw, vh] = viewBox.split(" ").map(Number);
  return (
    <svg
      aria-hidden
      viewBox={viewBox}
      width={Math.round((height * vw) / vh * 10) / 10}
      height={height}
      style={{ display: "block", flex: "none", ...style }}
    >
      {markShapes(name, color)}
    </svg>
  );
}

/**
 * The horizontal lockup: mark left of the wordmark, its body (sole to heel)
 * spanning cap height to baseline. Toes and the j's tail sit outside that.
 * Ratios are the sheet's: at 64px type the mark is 61.1px tall, lifted 16.6px
 * and 18.8px from the word.
 */
export function Logo({
  fontSize,
  tone = "light",
  className,
  style,
}: {
  fontSize: number;
  tone?: "light" | "dark";
  className?: string;
  style?: CSSProperties;
}) {
  const height = fontSize * 0.955;
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "flex-end",
        gap: fontSize * 0.294,
        color: tone === "dark" ? "var(--color-cream)" : INK,
        ...style,
      }}
    >
      <LogoMark
        height={height}
        tier={tierFor(height) === "L" ? "M" : undefined}
        color={tone === "dark" ? MARK_ON_DARK : CLAY}
        style={{ marginBottom: fontSize * 0.26 }}
      />
      <span
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 700,
          fontSize,
          lineHeight: 1,
          letterSpacing: "-0.015em",
          whiteSpace: "nowrap",
        }}
      >
        Jejak Suara
      </span>
    </span>
  );
}
