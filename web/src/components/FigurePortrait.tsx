import type { CSSProperties } from "react";
import { hatch, initials } from "@/lib/design";
import { figureImage } from "@/lib/tokoh-images";

/**
 * A figure's portrait, or the hatched initials placeholder when there is none.
 *
 * The portraits are generated woodblock illustrations
 * (scripts/gen_figure_portrait_webui.py), not photographs, and the likeness is
 * a build-and-role resemblance rather than a face match. Every use here sits
 * beside the figure's name, so the image is decorative to a screen reader —
 * but see the caption on the figure page: a drawing of a real person needs to
 * be labelled as one somewhere the reader can see it.
 *
 * The sources are full-height podium scenes and every use crops far tighter,
 * so the default focal point sits above centre, where the face is.
 */
export default function FigurePortrait({
  figureId,
  name,
  width,
  height = width,
  round = false,
  fontSize,
  hatchStep = 6,
  align = "center",
  objectPosition,
}: {
  figureId: string;
  name: string;
  width: number | string;
  height?: number | string;
  round?: boolean;
  fontSize: number;
  hatchStep?: number;
  align?: CSSProperties["alignItems"];
  objectPosition?: string;
}) {
  // A 24px circle of the full podium scene is mostly robe; the face crop is
  // the same picture, cut for the size it is actually shown at.
  const src = figureImage(figureId, round ? "avatar" : "portrait");
  const box: CSSProperties = {
    flex: "none",
    width,
    height,
    borderRadius: round ? "50%" : 0,
    border: "1px solid #16130f",
    overflow: "hidden",
  };

  if (src) {
    return (
      <div aria-hidden style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: objectPosition ?? (round ? "50% 50%" : "50% 14%"),
            display: "block",
          }}
        />
      </div>
    );
  }

  return (
    <div
      aria-hidden
      style={{
        ...box,
        background: hatch(hatchStep),
        display: "flex",
        alignItems: align,
        justifyContent: "center",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-serif)",
          fontSize,
          color: "#b9ab93",
          paddingBottom: align === "flex-end" ? 8 : 0,
        }}
      >
        {initials(name)}
      </span>
    </div>
  );
}
