"use client";

import { useState } from "react";
import { outletLogo } from "@/lib/design";

/**
 * A source's mark: its own logo where we have one, monogram otherwise.
 *
 * Client-side because of `onError`. A bundled icon can still fail — a redeploy
 * that drops public/outlets, or a format an older browser will not decode — and
 * a broken-image glyph next to a claim about a public figure reads as a broken
 * citation. Failing back to the monogram keeps the source legible.
 */
export default function OutletTile({
  source,
  size = 22,
  ring = "#f6f2e9",
}: {
  source: string;
  size?: number;
  ring?: string;
}) {
  const mark = outletLogo(source);
  const [failed, setFailed] = useState(false);
  const showImage = mark.src !== null && !failed;

  return (
    <span
      title={mark.label}
      style={{
        flex: "none",
        width: size,
        height: size,
        borderRadius: 5,
        // White behind a logo: most outlet marks are drawn for a light ground
        // and disappear against the paper tone.
        background: showImage ? "#fff" : mark.color,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        fontFamily: "var(--font-serif)",
        fontSize: size * 0.55,
        fontWeight: 600,
        lineHeight: 1,
        border: `1.5px solid ${ring}`,
        marginLeft: -5,
      }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mark.src!}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        mark.mono
      )}
    </span>
  );
}
