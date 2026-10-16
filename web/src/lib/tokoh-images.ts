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
  "agung-nugroho": {
    portrait: "agung-nugroho.webp",
    avatar: "agung-nugroho-avatar.webp",
  },
  "agus-harimurti-yudhoyono": {
    portrait: "agus-harimurti-yudhoyono.webp",
    avatar: "agus-harimurti-yudhoyono-avatar.webp",
  },
  "agus-jabo-priyono": {
    portrait: "agus-jabo-priyono.webp",
    avatar: "agus-jabo-priyono-avatar.webp",
  },
  "agus-subiyanto": {
    portrait: "agus-subiyanto.webp",
    avatar: "agus-subiyanto-avatar.webp",
  },
  "agustiar-sabran": {
    portrait: "agustiar-sabran.webp",
    avatar: "agustiar-sabran-avatar.webp",
  },
  "ahmad-doli-kurnia": {
    portrait: "ahmad-doli-kurnia.webp",
    avatar: "ahmad-doli-kurnia-avatar.webp",
  },
  "ahmad-luthfi": {
    portrait: "ahmad-luthfi.webp",
    avatar: "ahmad-luthfi-avatar.webp",
  },
  "ahmad-muzani": {
    portrait: "ahmad-muzani.webp",
    avatar: "ahmad-muzani-avatar.webp",
  },
  "ahmad-sahroni": {
    portrait: "ahmad-sahroni.webp",
    avatar: "ahmad-sahroni-avatar.webp",
  },
  "airlangga-hartarto": {
    portrait: "airlangga-hartarto.webp",
    avatar: "airlangga-hartarto-avatar.webp",
  },
  "amran-sulaiman": {
    portrait: "amran-sulaiman.webp",
    avatar: "amran-sulaiman-avatar.webp",
  },
  "andi-sudirman-sulaiman": {
    portrait: "andi-sudirman-sulaiman.webp",
    avatar: "andi-sudirman-sulaiman-avatar.webp",
  },
  "andra-soni": {
    portrait: "andra-soni.webp",
    avatar: "andra-soni-avatar.webp",
  },
  "andre-rosiade": {
    portrait: "andre-rosiade.webp",
    avatar: "andre-rosiade-avatar.webp",
  },
  "anies-baswedan": {
    portrait: "anies-baswedan.webp",
    avatar: "anies-baswedan-avatar.webp",
  },
  "anindya-bakrie": {
    portrait: "anindya-bakrie.webp",
    avatar: "anindya-bakrie-avatar.webp",
  },
  "anutin-charnvirakul": {
    portrait: "anutin-charnvirakul.webp",
    avatar: "anutin-charnvirakul-avatar.webp",
  },
  "anwar-ibrahim": {
    portrait: "anwar-ibrahim.webp",
    avatar: "anwar-ibrahim-avatar.webp",
  },
  "aries-syahbudin": {
    portrait: "aries-syahbudin.webp",
    avatar: "aries-syahbudin-avatar.webp",
  },
  "arif-satria": {
    portrait: "arif-satria.webp",
    avatar: "arif-satria-avatar.webp",
  },
  "bahlil-lahadalia": {
    portrait: "bahlil-lahadalia.webp",
    avatar: "bahlil-lahadalia-avatar.webp",
  },
  "basuki-hadimuljono": {
    portrait: "basuki-hadimuljono.webp",
    avatar: "basuki-hadimuljono-avatar.webp",
  },
  "benjamin-netanyahu": {
    portrait: "benjamin-netanyahu.webp",
    avatar: "benjamin-netanyahu-avatar.webp",
  },
  "bima-arya-sugiarto": {
    portrait: "bima-arya-sugiarto.webp",
    avatar: "bima-arya-sugiarto-avatar.webp",
  },
  "bobby-nasution": {
    portrait: "bobby-nasution.webp",
    avatar: "bobby-nasution-avatar.webp",
  },
  "budi-gunadi-sadikin": {
    portrait: "budi-gunadi-sadikin.webp",
    avatar: "budi-gunadi-sadikin-avatar.webp",
  },
  "budi-prasetyo": {
    portrait: "budi-prasetyo.webp",
    avatar: "budi-prasetyo-avatar.webp",
  },
  "budi-santoso": {
    portrait: "budi-santoso.webp",
    avatar: "budi-santoso-avatar.webp",
  },
  "budiman-sudjatmiko": {
    portrait: "budiman-sudjatmiko.webp",
    avatar: "budiman-sudjatmiko-avatar.webp",
  },
  "cak-imin": {
    portrait: "cak-imin.webp",
    avatar: "cak-imin-avatar.webp",
  },
  "dadan-hindayana": {
    portrait: "dadan-hindayana.webp",
    avatar: "dadan-hindayana-avatar.webp",
  },
  "daniel-johan": {
    portrait: "daniel-johan.webp",
    avatar: "daniel-johan-avatar.webp",
  },
  "dede-yusuf": {
    portrait: "dede-yusuf.webp",
    avatar: "dede-yusuf-avatar.webp",
  },
  "dedi-mulyadi": {
    portrait: "dedi-mulyadi.webp",
    avatar: "dedi-mulyadi-avatar.webp",
  },
  "djamari-chaniago": {
    portrait: "djamari-chaniago.webp",
    avatar: "djamari-chaniago-avatar.webp",
  },
  "dody-hanggodo": {
    portrait: "dody-hanggodo.webp",
    avatar: "dody-hanggodo-avatar.webp",
  },
  "donald-trump": {
    portrait: "donald-trump.webp",
    avatar: "donald-trump-avatar.webp",
  },
  "donny-ermawan": {
    portrait: "donny-ermawan.webp",
    avatar: "donny-ermawan-avatar.webp",
  },
  "dudung-abdurachman": {
    portrait: "dudung-abdurachman.webp",
    avatar: "dudung-abdurachman-avatar.webp",
  },
  "dudy-purwagandhi": {
    portrait: "dudy-purwagandhi.webp",
    avatar: "dudy-purwagandhi-avatar.webp",
  },
  "eddy-soeparno": {
    portrait: "eddy-soeparno.webp",
    avatar: "eddy-soeparno-avatar.webp",
  },
  "erick-thohir": {
    portrait: "erick-thohir.webp",
    avatar: "erick-thohir-avatar.webp",
  },
  "fadli-zon": {
    portrait: "fadli-zon.webp",
    avatar: "fadli-zon-avatar.webp",
  },
  "febri-diansyah": {
    portrait: "febri-diansyah.webp",
    avatar: "febri-diansyah-avatar.webp",
  },
  "ferry-juliantono": {
    portrait: "ferry-juliantono.webp",
    avatar: "ferry-juliantono-avatar.webp",
  },
  "ganjar-pranowo": {
    portrait: "ganjar-pranowo.webp",
    avatar: "ganjar-pranowo-avatar.webp",
  },
  "gerindra-bambang-haryadi": {
    portrait: "gerindra-bambang-haryadi.webp",
    avatar: "gerindra-bambang-haryadi-avatar.webp",
  },
  "hasto-kristiyanto": {
    portrait: "hasto-kristiyanto.webp",
    avatar: "hasto-kristiyanto-avatar.webp",
  },
  "imipas-agus-andrianto": {
    portrait: "imipas-agus-andrianto.webp",
    avatar: "imipas-agus-andrianto-avatar.webp",
  },
  "joko-widodo": {
    portrait: "joko-widodo.webp",
    avatar: "joko-widodo-avatar.webp",
  },
  "khofifah-indar-parawansa": {
    portrait: "khofifah-indar-parawansa.webp",
    avatar: "khofifah-indar-parawansa-avatar.webp",
  },
  "lawrence-wong": {
    portrait: "lawrence-wong.webp",
    avatar: "lawrence-wong-avatar.webp",
  },
  "maman-abdurrahman": {
    portrait: "maman-abdurrahman.webp",
    avatar: "maman-abdurrahman-avatar.webp",
  },
  "maruli-simanjuntak": {
    portrait: "maruli-simanjuntak.webp",
    avatar: "maruli-simanjuntak-avatar.webp",
  },
  "meutya-hafid": {
    portrait: "meutya-hafid.webp",
    avatar: "meutya-hafid-avatar.webp",
  },
  "muhaimin-iskandar": {
    portrait: "muhaimin-iskandar.webp",
    avatar: "muhaimin-iskandar-avatar.webp",
  },
  "muzakir-manaf": {
    portrait: "muzakir-manaf.webp",
    avatar: "muzakir-manaf-avatar.webp",
  },
  "narendra-modi": {
    portrait: "narendra-modi.webp",
    avatar: "narendra-modi-avatar.webp",
  },
  "nasaruddin-umar": {
    portrait: "nasaruddin-umar.webp",
    avatar: "nasaruddin-umar-avatar.webp",
  },
  "natalius-pigai": {
    portrait: "natalius-pigai.webp",
    avatar: "natalius-pigai-avatar.webp",
  },
  "nusron-wahid": {
    portrait: "nusron-wahid.webp",
    avatar: "nusron-wahid-avatar.webp",
  },
  "purbaya-yudhi-sadewa": {
    portrait: "purbaya-yudhi-sadewa.webp",
    avatar: "purbaya-yudhi-sadewa-avatar.webp",
  },
  "rahmat-mirzani-djausal": {
    portrait: "rahmat-mirzani-djausal.webp",
    avatar: "rahmat-mirzani-djausal-avatar.webp",
  },
  "rano-karno": {
    portrait: "rano-karno.webp",
    avatar: "rano-karno-avatar.webp",
  },
  "rini-widyantini": {
    portrait: "rini-widyantini.webp",
    avatar: "rini-widyantini-avatar.webp",
  },
  "rosan-roeslani": {
    portrait: "rosan-roeslani.webp",
    avatar: "rosan-roeslani-avatar.webp",
  },
  "rudy-susmanto": {
    portrait: "rudy-susmanto.webp",
    avatar: "rudy-susmanto-avatar.webp",
  },
  "said-abdullah": {
    portrait: "said-abdullah.webp",
    avatar: "said-abdullah-avatar.webp",
  },
  "said-iqbal": {
    portrait: "said-iqbal.webp",
    avatar: "said-iqbal-avatar.webp",
  },
  "saiful-bahri": {
    portrait: "saiful-bahri.webp",
    avatar: "saiful-bahri-avatar.webp",
  },
  "setyo-budiyanto": {
    portrait: "setyo-budiyanto.webp",
    avatar: "setyo-budiyanto-avatar.webp",
  },
  "sitti-husniah-talenrang": {
    portrait: "sitti-husniah-talenrang.webp",
    avatar: "sitti-husniah-talenrang-avatar.webp",
  },
  "sjafrie-sjamsoeddin": {
    portrait: "sjafrie-sjamsoeddin.webp",
    avatar: "sjafrie-sjamsoeddin-avatar.webp",
  },
  "sufmi-dasco-ahmad": {
    portrait: "sufmi-dasco-ahmad.webp",
    avatar: "sufmi-dasco-ahmad-avatar.webp",
  },
  "supratman-andi-agtas": {
    portrait: "supratman-andi-agtas.webp",
    avatar: "supratman-andi-agtas-avatar.webp",
  },
  "surya-paloh": {
    portrait: "surya-paloh.webp",
    avatar: "surya-paloh-avatar.webp",
  },
  "suyudi-ario-seto": {
    portrait: "suyudi-ario-seto.webp",
    avatar: "suyudi-ario-seto-avatar.webp",
  },
  "taj-yasin-maimoen": {
    portrait: "taj-yasin-maimoen.webp",
    avatar: "taj-yasin-maimoen-avatar.webp",
  },
  "teddy-indra-wijaya": {
    portrait: "teddy-indra-wijaya.webp",
    avatar: "teddy-indra-wijaya-avatar.webp",
  },
  "teuku-riefky-harsya": {
    portrait: "teuku-riefky-harsya.webp",
    avatar: "teuku-riefky-harsya-avatar.webp",
  },
  "titiek-soeharto": {
    portrait: "titiek-soeharto.webp",
    avatar: "titiek-soeharto-avatar.webp",
  },
  "tri-adhianto": {
    portrait: "tri-adhianto.webp",
    avatar: "tri-adhianto-avatar.webp",
  },
  "viva-yoga-mauladi": {
    portrait: "viva-yoga-mauladi.webp",
    avatar: "viva-yoga-mauladi-avatar.webp",
  },
  "vladimir-putin": {
    portrait: "vladimir-putin.webp",
    avatar: "vladimir-putin-avatar.webp",
  },
  "wahyu-hidayat": {
    portrait: "wahyu-hidayat.webp",
    avatar: "wahyu-hidayat-avatar.webp",
  },
  "wayan-koster": {
    portrait: "wayan-koster.webp",
    avatar: "wayan-koster-avatar.webp",
  },
  "willy-aditya": {
    portrait: "willy-aditya.webp",
    avatar: "willy-aditya-avatar.webp",
  },
  "xi-jinping": {
    portrait: "xi-jinping.webp",
    avatar: "xi-jinping-avatar.webp",
  },
  "yandri-susanto": {
    portrait: "yandri-susanto.webp",
    avatar: "yandri-susanto-avatar.webp",
  },
  "yaqut-cholil-qoumas": {
    portrait: "yaqut-cholil-qoumas.webp",
    avatar: "yaqut-cholil-qoumas-avatar.webp",
  },
  "yusril-ihza-mahendra": {
    portrait: "yusril-ihza-mahendra.webp",
    avatar: "yusril-ihza-mahendra-avatar.webp",
  },
};

export function figureImage(
  figureId: string,
  variant: keyof Portrait = "portrait"
): string | null {
  const entry = TOKOH_IMAGES[figureId];
  return entry ? `/images/tokoh/${entry[variant]}` : null;
}
