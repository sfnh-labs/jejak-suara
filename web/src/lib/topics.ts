/**
 * The topic a peristiwa is about, for the Linimasa filters.
 *
 * The model's KATEGORI says what *kind of act* an event was ("Pernyataan",
 * "Kunjungan") — useful on a record, useless for finding events: a quarter of
 * all peristiwa are "Pernyataan", about anything at all. A topic is what the
 * event concerns, so it is read from the title and summary instead, with the
 * KATEGORI as one more hint when it happens to imply a topic ("Kebakaran").
 *
 * Keyword scoring rather than a model call: it runs at request time over data
 * already published, needs no re-run of the pipeline, and is easy to correct by
 * editing a list. Anything matching nothing is "lainnya".
 */

export type TopicId =
  | "bencana"
  | "hukum"
  | "politik"
  | "ekonomi"
  | "sosial"
  | "infrastruktur"
  | "olahraga"
  | "internasional"
  | "lainnya";

export const TOPICS: { id: TopicId; label: string }[] = [
  { id: "politik", label: "Politik & Pemerintahan" },
  { id: "hukum", label: "Hukum & Keamanan" },
  { id: "bencana", label: "Bencana & Lingkungan" },
  { id: "ekonomi", label: "Ekonomi" },
  { id: "sosial", label: "Sosial, Pendidikan & Kesehatan" },
  { id: "infrastruktur", label: "Infrastruktur & Transportasi" },
  { id: "olahraga", label: "Olahraga" },
  { id: "internasional", label: "Internasional" },
  { id: "lainnya", label: "Lainnya" },
];

type Classified = Exclude<TopicId, "lainnya">;

/** Hue per topic for its label on a card; fixed so a topic keeps its colour. */
const TOPIC_HUE: Record<Classified, number> = {
  politik: 222,
  hukum: 8,
  bencana: 28,
  ekonomi: 145,
  sosial: 290,
  infrastruktur: 195,
  olahraga: 95,
  internasional: 255,
};

/** Text, fill and border for a topic's label, in the event-chip palette. */
export function topicChip(id: TopicId): { color: string; bg: string; border: string } {
  if (id === "lainnya") return { color: "#6b645b", bg: "#efe9dc", border: "#ddd3bf" };
  const hue = TOPIC_HUE[id];
  return {
    color: `hsl(${hue} 42% 30%)`,
    bg: `hsl(${hue} 45% 93%)`,
    border: `hsl(${hue} 35% 82%)`,
  };
}

/** The fill behind a peristiwa tile that has no image: the topic's hue, dark. */
export function topicBanner(id: TopicId): string {
  return id === "lainnya" ? "#3a352d" : `hsl(${TOPIC_HUE[id]} 32% 24%)`;
}

export function topicLabel(id: TopicId): string {
  return TOPICS.find((t) => t.id === id)!.label;
}

/**
 * Lowercase words and phrases per topic, matched on word boundaries. A prefix
 * ending in "*" matches any continuation ("korup*" → korupsi, koruptor).
 */
const KEYWORDS: Record<Classified, string[]> = {
  bencana: [
    "banjir*", "longsor*", "gempa*", "erupsi", "gunung api", "tsunami", "kebakaran",
    "terbakar", "karhutla", "kekeringan", "cuaca ekstrem", "angin kencang",
    "puting beliung", "bmkg", "bnpb", "bpbd", "basarnas", "evakuasi", "pengungsi*",
    "korban jiwa", "bencana", "abrasi", "rob", "polusi", "pencemaran", "sampah",
    "lingkungan hidup", "hutan", "deforestasi", "tambang ilegal", "kabut asap",
    "hujan deras", "siaga darurat", "tanggap darurat", "mangrove", "gambut",
    "kemarau", "kualitas udara", "satwa", "terdampar", "sungai", "kebakaran hutan",
  ],
  hukum: [
    "polisi", "polri", "polda", "polres*", "polsek", "kapolri", "kapolda", "kapolres",
    "kpk", "kejaksaan", "kejagung", "kejati", "kejari", "jaksa", "korup*", "suap",
    "gratifikasi", "tersangka", "terdakwa", "ditangkap", "penangkapan", "ditahan",
    "penahanan", "sidang", "persidangan", "vonis", "divonis", "hakim", "pengadilan",
    "mahkamah", "dakwaan", "tuntutan", "pidana", "narkoba", "narkotika", "sabu",
    "pembunuhan", "dibunuh", "pencurian", "penipuan", "penganiayaan", "pemerkosaan",
    "pelecehan", "kriminal", "penyelidikan", "penyidikan", "penggeledahan",
    "digeledah", "ott", "operasi tangkap tangan", "buron", "dpo", "lapas", "napi",
    "tahanan", "begal", "tawuran", "judi", "judol", "pemerasan", "pungli",
    "ricuh", "kericuhan", "bentrok", "laporan polisi", "praperadilan",
    "tni", "opm", "kkb", "kontak tembak", "teroris*", "densus", "keamanan",
    "mayat", "jenazah ditemukan",
  ],
  politik: [
    "dpr", "dprd", "mpr", "dpd", "partai", "pemilu", "pilkada", "pilpres", "kpu",
    "bawaslu", "kampanye", "koalisi", "oposisi", "menteri",
    "presiden", "wakil presiden", "wapres", "kabinet", "reshuffle", "istana",
    "gubernur", "bupati", "wali kota", "walikota", "pelantikan", "dilantik",
    "ruu", "undang-undang", "perppu", "perpres", "perda", "rapat paripurna",
    "fraksi", "muktamar", "kongres", "munas", "musda", "ketua umum", "caleg",
    "pemerintah daerah", "pemda", "pemprov", "pemkab", "pemkot", "asn", "pns",
    "birokrasi", "otonomi", "pemekaran", "demokrasi", "demonstrasi", "unjuk rasa",
    "demo", "mahasiswa menolak", "kependudukan", "dukcapil", "ktp",
  ],
  ekonomi: [
    "harga", "inflasi", "rupiah", "dolar", "saham", "ihsg", "bursa", "investasi",
    "investor", "ekspor", "impor", "pajak", "cukai", "apbn", "apbd", "anggaran",
    "bumn", "pertamina", "pln", "bank", "perbankan", "kredit", "pinjaman", "utang",
    "umkm", "industri", "perdagangan", "tarif", "subsidi", "bbm", "pangan", "beras",
    "pertanian", "petani", "pupuk", "nelayan", "perikanan", "ekonomi", "bisnis",
    "pengusaha", "perusahaan", "phk", "upah", "ump", "umr", "buruh", "tenaga kerja",
    "lapangan kerja", "pengangguran", "koperasi", "kopdes", "danantara", "ojk",
    "bank indonesia", "suku bunga", "nilai tukar", "minyak goreng", "gula",
    "cabai", "daging", "stok", "bulog", "pasar", "devisa", "hilirisasi", "nikel",
    "batu bara", "sawit",
  ],
  sosial: [
    "sekolah", "siswa", "murid", "guru", "kampus", "universitas", "mahasiswa",
    "pendidikan", "beasiswa", "kurikulum", "rumah sakit", "puskesmas", "kesehatan",
    "bpjs", "pasien", "dokter", "penyakit", "wabah", "virus", "dbd", "tbc",
    "stunting", "gizi", "mbg", "makan bergizi", "keracunan", "bansos",
    "bantuan sosial", "kemiskinan", "miskin", "warga", "haji", "umrah", "agama",
    "masjid", "gereja", "pesantren", "santri", "ulama", "budaya", "festival",
    "seni", "konser", "musik*", "film", "pariwisata", "wisata", "disabilitas",
    "anak", "perempuan", "lansia", "perumahan", "rumah subsidi", "sekolah rakyat",
    "kemanusiaan", "donasi", "relawan", "adat", "tradisi", "hari raya", "lebaran",
    "natal", "ramadan", "upacara", "hut ri", "kemerdekaan",
  ],
  infrastruktur: [
    "jalan", "jalan tol", "tol", "jembatan", "bandara", "pelabuhan", "kereta",
    "krl", "lrt", "mrt", "whoosh", "bus", "transjakarta", "transportasi",
    "angkutan", "kecelakaan", "tabrakan", "kapal", "tenggelam", "pesawat",
    "penerbangan", "maskapai", "mudik", "arus balik", "ikn", "ibu kota nusantara",
    "pembangunan", "proyek", "bendungan", "irigasi", "listrik", "pemadaman",
    "air bersih", "pdam", "infrastruktur", "renovasi", "revitalisasi",
    "rusun", "terminal", "stasiun", "lalu lintas", "kemacetan", "macet",
    "ganjil genap", "jalur", "rel",
  ],
  olahraga: [
    "timnas", "pssi", "sepak bola", "sepakbola", "liga", "piala", "asian games",
    "olimpiade", "sea games", "atlet", "pertandingan", "juara", "medali",
    "bulu tangkis", "bulutangkis", "badminton", "motogp", "formula", "persib",
    "persija", "arema", "pelatih", "stadion", "turnamen", "kejuaraan", "fifa",
    "afc", "aff", "voli", "basket", "tinju", "pon", "porprov", "kemenpora",
    "menpora", "olahraga", "pemain", "gol", "ufc", "super league", "nations league",
  ],
  internasional: [
    "israel", "palestina", "gaza", "amerika serikat", "tiongkok", "china", "rusia",
    "ukraina", "pbb", "asean", "ktt", "g20", "brics", "duta besar", "dubes",
    "kedutaan", "trump", "malaysia", "singapura", "jepang", "korea", "australia",
    "arab saudi", "iran", "india", "eropa", "inggris", "prancis", "jerman",
    "belanda", "timor leste", "filipina", "thailand", "vietnam", "myanmar",
    "luar negeri", "bilateral", "diplomasi", "wni", "pmi", "tki", "kemlu",
    "menlu", "internasional", "global", "perang", "gencatan senjata",
  ],
};

/** Acronyms that are ordinary words in lowercase ("as", "un"), matched as written. */
const CASED: Partial<Record<Classified, string[]>> = {
  internasional: ["AS", "UE"],
};

/**
 * KATEGORI labels that imply a topic on their own. Labels for acts that happen
 * in any field — Peresmian, Pemberian Bantuan, Pencarian — are left out: aid
 * after an earthquake is about the earthquake.
 */
const TYPE_HINT: Record<string, Classified> = {
  kebencana: "bencana",
  bencana: "bencana",
  kebakaran: "bencana",
  pemadaman: "bencana",
  kriminal: "hukum",
  penyelidikan: "hukum",
  penyidikan: "hukum",
  penangkapan: "hukum",
  sidang: "hukum",
  penggeledahan: "hukum",
  pembebasan: "hukum",
  pengungkapan: "hukum",
  kericuhan: "hukum",
  pelantikan: "politik",
  pencalonan: "politik",
  pemilu: "politik",
  pengesahan: "politik",
  "pengunduran diri": "politik",
  muktamar: "politik",
  demonstrasi: "politik",
  debat: "politik",
  pembiayaan: "ekonomi",
  pemakaman: "sosial",
  perayaan: "sosial",
  pameran: "sosial",
  pembangunan: "infrastruktur",
  renovasi: "infrastruktur",
  revitalisasi: "infrastruktur",
  pertandingan: "olahraga",
  "prestasi olahraga": "olahraga",
};

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pattern(word: string, flags: string): RegExp {
  const prefix = word.endsWith("*");
  const body = escape(prefix ? word.slice(0, -1) : word).replace(/ /g, "\\s+");
  // \p{L} boundaries rather than \b, which treats accented letters as breaks.
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${prefix ? "" : "(?![\\p{L}\\p{N}])"}`, flags);
}

const MATCHERS: [Classified, RegExp[], RegExp[]][] = (Object.keys(KEYWORDS) as Classified[]).map(
  (topic) => [
    topic,
    KEYWORDS[topic].map((w) => pattern(w, "giu")),
    (CASED[topic] ?? []).map((w) => pattern(w, "gu")),
  ]
);

function hits(text: string, lower: RegExp[], cased: RegExp[]): number {
  let n = 0;
  const low = text.toLowerCase();
  for (const re of lower) n += low.match(re)?.length ?? 0;
  for (const re of cased) n += text.match(re)?.length ?? 0;
  return n;
}

/**
 * The best-scoring topic. A title hit counts three times a summary hit — the
 * title names the event, the summary also carries background — and a KATEGORI
 * that implies a topic counts a little more than one title hit — the model's
 * labels are often loose ("Pembiayaan" on a course for advocates), so the
 * text has the final say.
 */
export function topicOf(e: { title: string | null; summary: string | null; event_type: string | null }): TopicId {
  const title = e.title ?? "";
  // Citations would otherwise match "sumber" lists; strip them.
  const summary = (e.summary ?? "").replace(/\[[^\]]*\]/g, " ");
  const hint = TYPE_HINT[(e.event_type ?? "").trim().toLowerCase()];

  let best: TopicId = "lainnya";
  let bestScore = 0;
  for (const [topic, lower, cased] of MATCHERS) {
    const score =
      3 * hits(title, lower, cased) + hits(summary, lower, cased) + (hint === topic ? 4 : 0);
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  return best;
}

export function isTopicId(value: string | undefined): value is TopicId {
  return TOPICS.some((t) => t.id === value);
}
