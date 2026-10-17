/**
 * event_id -> generated illustration filename under /public/images/peristiwa.
 *
 * Static manifest, not a runtime directory scan: production runs on
 * Cloudflare Workers, where `fs` isn't available at request time. Update this
 * when scripts/gen_event_images_webui.py produces new files.
 */
export const PERISTIWA_IMAGES: Record<number, string> = {
  22636: "22636-menkum-supratman-klaim-mediasi-sukses-di-posbankum-hemat-neg.webp",
  22485: "22485-pemprov-jawa-barat-hentikan-sementara-pembangunan-pusat-data.webp",
  23373: "23373-53-jemaah-umroh-makassar-batal-berangkat-imbas-serangan-hout.webp",
  23246: "23246-imigrasi-tolak-visa-musisi-israel-houghton.webp",
  23179: "23179-surat-ma-nyasar-ke-pengadilan-agama-bupati-gowa-laporkan-pt-.webp",
  22839: "22839-komjen-suyudi-janji-warga-tak-perlu-tunggu-no-viral-no-justi.webp",
  22812: "22812-kualitas-udara-di-berbagai-wilayah-sumatera-selatan-terancam.webp",
  22779: "22779-legislator-pdi-perjuangan-tinjau-pengerjaan-saluran-air-di-j.webp",
  22745: "22745-wamendagri-dorong-sumbar-perkuat-ketangguhan-menghadapi-benc.webp",
  22741: "22741-pramono-anung-umumkan-beberapa-peristiwa-dan-rencana-di-dki-.webp",
  22721: "22721-pasar-serdang-terbakar-dan-akan-direvitalisasi.webp",
  22714: "22714-bapanas-menegaskan-harga-beras-premium-di-pibc-masih-wajar.webp",
  22629: "22629-pt-kai-evaluasi-setelah-temuan-knkt.webp",
  22531: "22531-penyesuaian-tarif-transjakarta-dan-transportasi-dki-di-2027.webp",
  22530: "22530-pemerintah-siapkan-sistem-saluran-subsidi-dan-bantuan-di-kop.webp",
  16583: "16583-dprd-surabaya-dorong-pengerjaan-proyek-pengendalian.webp",
  16576: "16576-mtq-nasional-xxxi-berlangsung-dengan-sukses-di-jawa-tengah.webp",
  16547: "16547-mendagri-dorong-pengelolaan-perbatasan-dan-pelayanan-publik.webp",
  16543: "16543-dprd-dki-dorong-desalinasi-air-laut-untuk-antisipasi-kekerin.webp",
  16419: "16419-pembukaan-lrt-jakarta-rute-kelapa-gading-manggarai.webp",
  16383: "16383-pramono-anung-wibowo-inginkan-renovasi-rptra-kalijodo.webp",
  16043: "16043-pemerintah-ingatkan-distribusi-dan-kualitas-beras-sesuai-sta.webp",
  16011: "16011-waka-mpr-meminta-dukungan-kampus-untuk-ruu-pengendalian-peru.webp",
  15972: "15972-ruu-pemilu-dan-ambang-batas-parlemen.webp",
  15614: "15614-pengesahan-uu-reforma-agraria.webp",
  15608: "15608-gubernur-kaltim-meliburkan-sekolah-akibat-asap-kebakaran-hut.webp",
  15600: "15600-pergantian-menteri-keuangan-suahasil-nasution.webp",
  15163: "15163-perkuatan-sistem-pencegahan-kebakaran-di-indonesia.webp",
  15150: "15150-pekanbaru-menorehkan-pertumbuhan-ekonomi-tertinggi-triwulan-.webp",
  15134: "15134-tito-imbau-kepala-daerah-dukung-verifikasi-pembangunan-koper.webp",
  15131: "15131-pendidikan-dan-peluang-pendidikan-bagi-anak-anak-putus-sekol.webp",
  15126: "15126-pelantikan-menteri-di-istana-kepresidenan.webp",
  14926: "14926-kenaikan-harga-pangan-ditegaskan-oleh-bps-dan-ditanggapi-men.webp",
  14904: "14904-pramono-anung-umumkan-tarif-lrt-kelapa-gading-manggarai.webp",
  14894: "14894-sidang-dan-pengesahan-peraturan-daerah-di-dki-jakarta.webp",
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
