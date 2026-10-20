import Link from "next/link";
import { hatch } from "@/lib/design";
import { peristiwaImage, themeImage } from "@/lib/peristiwa-images";
import { MUTED } from "./ui";

/**
 * A peristiwa's banner as the site shows it, for the curator to see: its own
 * illustration, one borrowed from its story (said so, with a link to the
 * owner), or a hatched placeholder where the site shows none.
 *
 * Records have no banner on the site, so they get none here either.
 */
export function EventBanner({ eventId, image }: {
  eventId: number;
  image: { src: string; from: number | null; theme?: string } | null;
}) {
  const borrowed = image && image.from !== null && image.from !== eventId;
  return (
    <figure style={{ margin: "0 0 16px" }}>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.src}
          alt=""
          style={{ width: "100%", maxHeight: 300, aspectRatio: "16 / 11", objectFit: "cover", display: "block", border: "1px solid var(--color-parchment)" }}
        />
      ) : (
        <Placeholder style={{ width: "100%", height: 120 }} label="Belum ada gambar" />
      )}
      <figcaption style={{ fontSize: 11.5, color: MUTED, marginTop: 5 }}>
        {!image
          ? "Situs menampilkan peristiwa ini tanpa gambar."
          : borrowed
            ? <>Gambar dipinjam dari lini cerita: <Link href={`/kurasi/${image.from}`} style={{ color: MUTED }}>peristiwa #{image.from}</Link>. Hilang bila tautannya dibatalkan.</>
            : image.theme
              ? `Gambar tema ${image.theme}: dipakai semua peristiwa ${image.theme.toLowerCase()} yang belum punya gambar sendiri.`
              : "Gambar peristiwa ini sendiri."}
      </figcaption>
    </figure>
  );
}

/** The queue's thumbnail: own or theme illustration. The queue does not walk
 *  story links, so a banner borrowed from a story shows on the item page only. */
export function EventThumb({ eventId, title }: { eventId: number; title: string | null }) {
  const src = peristiwaImage(eventId) ?? themeImage(title)?.src ?? null;
  const box = { width: 72, height: 50, flex: "none" } as const;
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" style={{ ...box, objectFit: "cover", display: "block", border: "1px solid var(--color-parchment)" }} />
  ) : (
    <Placeholder style={box} />
  );
}

function Placeholder({ style, label }: { style: React.CSSProperties; label?: string }) {
  return (
    <div
      aria-hidden={label ? undefined : true}
      style={{
        ...style,
        background: hatch(label ? 8 : 4),
        border: "1px dashed var(--color-parchment)",
        display: "grid",
        placeItems: "center",
        fontSize: 12,
        fontWeight: 600,
        color: MUTED,
      }}
    >
      {label ?? null}
    </div>
  );
}
