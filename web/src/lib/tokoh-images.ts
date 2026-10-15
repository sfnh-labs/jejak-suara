/**
 * figure id -> generated portrait files under /public/images/tokoh.
 *
 * Static manifest for the same reason as `peristiwa-images.ts`: production
 * runs on Cloudflare Workers, where `fs` is not available at request time.
 * Update this when scripts/gen_figure_portrait_webui.py produces new files.
 *
 * Two files per figure. The generator makes a full podium scene, which is the
 * right thing on the profile panel and unreadable in a 24px circle — at that
 * size a full-frame crop is mostly robe. `avatar` is a face crop of the same
 * image, cut once with sharp rather than per request.
 *
 * These are illustrations, not photographs, and the likeness is a build-and-
 * role resemblance rather than a face match. `FigurePortrait` is what renders
 * them; nothing should reach for these paths without that context.
 */
type Portrait = { portrait: string; avatar: string };

export const TOKOH_IMAGES: Record<string, Portrait> = {
  "prabowo-subianto": {
    portrait: "prabowo-subianto.webp",
    avatar: "prabowo-subianto-avatar.webp",
  },
  "gibran-rakabuming-raka": {
    portrait: "gibran-rakabuming-raka.webp",
    avatar: "gibran-rakabuming-raka-avatar.webp",
  },
  "gus-ipul": {
    portrait: "gus-ipul.webp",
    avatar: "gus-ipul-avatar.webp",
  },
  "jumhur-hidayat": {
    portrait: "jumhur-hidayat.webp",
    avatar: "jumhur-hidayat-avatar.webp",
  },
  "megawati-soekarnoputri": {
    portrait: "megawati-soekarnoputri.webp",
    avatar: "megawati-soekarnoputri-avatar.webp",
  },
  "pramono-anung-wibowo": {
    portrait: "pramono-anung-wibowo.webp",
    avatar: "pramono-anung-wibowo-avatar.webp",
  },
  "prasetyo-hadi": {
    portrait: "prasetyo-hadi.webp",
    avatar: "prasetyo-hadi-avatar.webp",
  },
  "puan-maharani": {
    portrait: "puan-maharani.webp",
    avatar: "puan-maharani-avatar.webp",
  },
  "saan-mustopa": {
    portrait: "saan-mustopa.webp",
    avatar: "saan-mustopa-avatar.webp",
  },
  "tito-karnavian": {
    portrait: "tito-karnavian.webp",
    avatar: "tito-karnavian-avatar.webp",
  },
  "zulkifli-hasan": {
    portrait: "zulkifli-hasan.webp",
    avatar: "zulkifli-hasan-avatar.webp",
  },
};

export function figureImage(
  figureId: string,
  variant: keyof Portrait = "portrait"
): string | null {
  const entry = TOKOH_IMAGES[figureId];
  return entry ? `/images/tokoh/${entry[variant]}` : null;
}
