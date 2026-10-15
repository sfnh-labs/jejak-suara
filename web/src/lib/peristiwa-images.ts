/**
 * event_id -> generated illustration filename under /public/images/peristiwa.
 *
 * Static manifest, not a runtime directory scan: production runs on
 * Cloudflare Workers, where `fs` isn't available at request time. Update this
 * when scripts/gen_event_images_webui.py produces new files.
 */
export const PERISTIWA_IMAGES: Record<number, string> = {
  23621: "23621-kpk-lakukan-operasi-tangkap-tangan-di-bnpb.webp",
  23618: "23618-kapal-wisata-km-feronia-tenggelam-di-labuan-bajo-24-penumpan.webp",
  23605: "23605-100-hektare-kebakaran-di-cagar-alam-gunung-lokon.webp",
  23581: "23581-bi-sulsel-dan-koderal-vi-bawa-rp25-miliar-ke-pulau-3t.webp",
  23337: "23337-menlu-ri-tegaskan-komitmen-mendukung-palestina.webp",
  23321: "23321-ijazah-wapres-gibran-masih-jadi-polemik.webp",
  23313: "23313-kabut-asap-akibat-karhutla-menyelimuti-sejumlah-daerah.webp",
  23305: "23305-kapolri-rombak-jabatan-strategis-korlantas-dan-tni-au.webp",
  23103: "23103-pertandingan-final-fifa-asean-cup-2026-terlaksana-di-gbk-ind.webp",
  762: "762-kpk-ajak-publik-pantau-sidang-yaqut.webp",
  761: "761-rektor-usu-kebijakan-strategis-lima-pilar.webp",
  760: "760-kunjungan-jokowi-perkuat-psi.webp",
  758: "758-waketum-mui-marsudi-syuhud-calon-ketum-pbnu.webp",
};

export function peristiwaImage(eventId: number): string | null {
  const file = PERISTIWA_IMAGES[eventId];
  return file ? `/images/peristiwa/${file}` : null;
}

/**
 * Illustrations shared by a whole kind of story: a peristiwa with no picture
 * of its own (or from its story) takes the one whose pattern its title
 * matches. Forest and land fires run for weeks as dozens of separate events,
 * and one image says "karhutla" better than a blank tile.
 */
const THEME_IMAGES: { theme: string; pattern: RegExp; eventId: number }[] = [
  {
    theme: "Karhutla",
    pattern: /\bkarhutla\b|kebakaran hutan|hutan dan lahan|kebakaran lahan|titik panas|\bhotspot|(kebakaran|terbakar)\b.*\b(gunung|cagar alam|taman nasional|savana)\b|\b(gunung|cagar alam|taman nasional)\b.*\b(kebakaran|terbakar|berkobar)\b/i,
    eventId: 23605,
  },
];

export function themeImage(title: string | null | undefined): { src: string; theme: string } | null {
  if (!title) return null;
  for (const t of THEME_IMAGES) {
    const src = peristiwaImage(t.eventId);
    if (src && t.pattern.test(title)) return { src, theme: t.theme };
  }
  return null;
}
