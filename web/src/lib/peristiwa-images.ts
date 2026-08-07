/**
 * event_id -> generated illustration filename under /public/images/peristiwa.
 *
 * Static manifest, not a runtime directory scan: production runs on
 * Cloudflare Workers, where `fs` isn't available at request time. Update this
 * when scripts/gen_event_images_webui.py produces new files.
 */
export const PERISTIWA_IMAGES: Record<number, string> = {
  762: "762-kpk-ajak-publik-pantau-sidang-yaqut.webp",
  761: "761-rektor-usu-kebijakan-strategis-lima-pilar.webp",
  760: "760-kunjungan-jokowi-perkuat-psi.webp",
  758: "758-waketum-mui-marsudi-syuhud-calon-ketum-pbnu.webp",
};

export function peristiwaImage(eventId: number): string | null {
  const file = PERISTIWA_IMAGES[eventId];
  return file ? `/images/peristiwa/${file}` : null;
}
