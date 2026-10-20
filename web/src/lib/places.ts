/**
 * Where a headline is: Indonesian provinces, each with the names that place a
 * story in it — the province itself, its capital, and the cities, regencies
 * and landmarks the news names most. Not a full gazetteer; a name it lacks
 * just places nothing.
 *
 * Used by /kurasi to show when one event's articles are set in different
 * provinces, the commonest sign that clustering merged two stories.
 */
export const PROVINCES: Record<string, { label: string; names: string[] }> = {
  aceh: { label: "Aceh", names: ["aceh", "banda aceh", "lhokseumawe", "meulaboh", "sabang", "langsa", "bireuen", "pidie"] },
  sumut: { label: "Sumatera Utara", names: ["sumatera utara", "sumut", "medan", "deli serdang", "binjai", "pematangsiantar", "siantar", "nias", "tapanuli", "toba", "sibolga", "karo", "langkat", "asahan", "labuhanbatu", "padang lawas", "mandailing natal", "tebing tinggi", "sergai", "serdang bedagai"] },
  sumbar: { label: "Sumatera Barat", names: ["sumatera barat", "sumbar", "padang", "bukittinggi", "payakumbuh", "agam", "pariaman", "solok", "pesisir selatan", "mentawai", "tanah datar", "sawahlunto", "pasaman", "dharmasraya", "sijunjung"] },
  riau: { label: "Riau", names: ["riau", "pekanbaru", "dumai", "siak", "bengkalis", "kampar", "rokan hulu", "rokan hilir", "indragiri", "pelalawan", "kuantan singingi", "meranti"] },
  kepri: { label: "Kepulauan Riau", names: ["kepulauan riau", "kepri", "batam", "tanjungpinang", "bintan", "karimun", "natuna", "lingga", "anambas"] },
  jambi: { label: "Jambi", names: ["jambi", "muaro jambi", "kerinci", "sungai penuh", "tebo", "bungo", "merangin", "sarolangun", "batanghari", "tanjung jabung"] },
  sumsel: { label: "Sumatera Selatan", names: ["sumatera selatan", "sumsel", "palembang", "prabumulih", "lubuklinggau", "ogan komering", "ogan ilir", "musi banyuasin", "musi rawas", "muara enim", "lahat", "pagar alam", "banyuasin", "empat lawang", "pali"] },
  babel: { label: "Bangka Belitung", names: ["bangka belitung", "babel", "pangkalpinang", "bangka", "belitung"] },
  bengkulu: { label: "Bengkulu", names: ["bengkulu", "rejang lebong", "mukomuko", "kaur", "seluma", "kepahiang", "lebong"] },
  lampung: { label: "Lampung", names: ["lampung", "bandar lampung", "metro", "pesawaran", "pringsewu", "tanggamus", "tulang bawang", "way kanan", "mesuji"] },
  jakarta: { label: "Jakarta", names: ["jakarta", "dki", "jaksel", "jakut", "jakbar", "jaktim", "jakpus", "kepulauan seribu", "monas", "senayan", "gbk", "kemayoran", "tanjung priok", "cilincing", "kebayoran", "cakung", "penjaringan", "menteng", "tanah abang", "glodok", "kelapa gading", "pluit", "cengkareng", "kalideres", "pasar minggu", "cilandak", "pancoran", "jatinegara", "kramat jati", "cipayung", "matraman", "duren sawit"] },
  banten: { label: "Banten", names: ["banten", "serang", "cilegon", "tangerang", "tangsel", "pandeglang", "lebak", "legok", "bsd", "cikupa", "balaraja", "ciputat", "pamulang", "serpong", "karawaci", "pik 2"] },
  jabar: { label: "Jawa Barat", names: ["jawa barat", "jabar", "bandung", "bogor", "depok", "bekasi", "cimahi", "sukabumi", "cianjur", "garut", "tasikmalaya", "ciamis", "banjar", "kuningan", "cirebon", "indramayu", "majalengka", "sumedang", "subang", "purwakarta", "karawang", "pangandaran", "cibinong", "puncak", "cikarang", "lembang"] },
  jateng: { label: "Jawa Tengah", names: ["jawa tengah", "jateng", "semarang", "solo", "surakarta", "magelang", "salatiga", "pekalongan", "tegal", "brebes", "pemalang", "batang", "kendal", "demak", "kudus", "jepara", "pati", "rembang", "blora", "grobogan", "boyolali", "klaten", "sukoharjo", "wonogiri", "karanganyar", "sragen", "purworejo", "kebumen", "banyumas", "purwokerto", "cilacap", "purbalingga", "banjarnegara", "wonosobo", "temanggung"] },
  diy: { label: "DI Yogyakarta", names: ["yogyakarta", "jogja", "yogya", "diy", "sleman", "bantul", "gunungkidul", "kulon progo"] },
  jatim: { label: "Jawa Timur", names: ["jawa timur", "jatim", "surabaya", "malang", "batu", "kediri", "blitar", "madiun", "mojokerto", "pasuruan", "probolinggo", "sidoarjo", "gresik", "lamongan", "tuban", "bojonegoro", "ngawi", "magetan", "ponorogo", "pacitan", "trenggalek", "tulungagung", "nganjuk", "jombang", "lumajang", "jember", "bondowoso", "situbondo", "banyuwangi", "madura", "bangkalan", "sampang", "pamekasan", "sumenep", "semeru", "bromo"] },
  bali: { label: "Bali", names: ["bali", "denpasar", "badung", "gianyar", "tabanan", "klungkung", "bangli", "karangasem", "buleleng", "jembrana", "kuta", "ubud", "nusa dua"] },
  ntb: { label: "Nusa Tenggara Barat", names: ["nusa tenggara barat", "ntb", "mataram", "lombok", "sumbawa", "bima", "dompu", "mandalika", "rinjani"] },
  ntt: { label: "Nusa Tenggara Timur", names: ["nusa tenggara timur", "ntt", "kupang", "flores", "sikka", "maumere", "ende", "manggarai", "labuan bajo", "sumba", "alor", "lembata", "rote", "belu", "atambua", "ngada", "nagekeo", "timor tengah", "malaka", "sabu"] },
  kalbar: { label: "Kalimantan Barat", names: ["kalimantan barat", "kalbar", "pontianak", "singkawang", "ketapang", "sambas", "sanggau", "sintang", "kapuas hulu", "mempawah", "kubu raya", "landak", "bengkayang", "melawi", "sekadau", "kayong"] },
  kalteng: { label: "Kalimantan Tengah", names: ["kalimantan tengah", "kalteng", "palangka raya", "palangkaraya", "kotawaringin", "kapuas", "barito", "katingan", "seruyan", "sukamara", "lamandau", "gunung mas", "pulang pisau", "murung raya"] },
  kalsel: { label: "Kalimantan Selatan", names: ["kalimantan selatan", "kalsel", "banjarmasin", "banjarbaru", "martapura", "kotabaru", "tanah laut", "tanah bumbu", "tabalong", "hulu sungai", "barito kuala", "balangan", "tapin"] },
  kaltim: { label: "Kalimantan Timur", names: ["kalimantan timur", "kaltim", "samarinda", "balikpapan", "bontang", "kutai", "ikn", "nusantara", "penajam", "paser", "berau", "mahakam"] },
  kaltara: { label: "Kalimantan Utara", names: ["kalimantan utara", "kaltara", "tarakan", "nunukan", "bulungan", "malinau", "tana tidung"] },
  sulut: { label: "Sulawesi Utara", names: ["sulawesi utara", "sulut", "manado", "bitung", "tomohon", "kotamobagu", "minahasa", "bolaang mongondow", "sangihe", "talaud", "sitaro", "lokon", "bunaken"] },
  gorontalo: { label: "Gorontalo", names: ["gorontalo", "boalemo", "pohuwato", "bone bolango"] },
  sulteng: { label: "Sulawesi Tengah", names: ["sulawesi tengah", "sulteng", "palu", "poso", "morowali", "banggai", "donggala", "sigi", "parigi moutong", "tolitoli", "buol", "tojo una-una"] },
  sulbar: { label: "Sulawesi Barat", names: ["sulawesi barat", "sulbar", "mamuju", "majene", "polewali mandar", "mamasa", "pasangkayu"] },
  sulsel: { label: "Sulawesi Selatan", names: ["sulawesi selatan", "sulsel", "makassar", "gowa", "maros", "parepare", "palopo", "bone", "bulukumba", "sinjai", "takalar", "jeneponto", "bantaeng", "selayar", "pangkep", "barru", "sidrap", "pinrang", "enrekang", "tana toraja", "toraja", "luwu", "wajo", "soppeng"] },
  sultra: { label: "Sulawesi Tenggara", names: ["sulawesi tenggara", "sultra", "kendari", "baubau", "kolaka", "konawe", "muna", "buton", "wakatobi", "bombana"] },
  maluku: { label: "Maluku", names: ["maluku", "ambon", "tual", "seram", "buru", "aru", "saumlaki", "banda neira"] },
  malut: { label: "Maluku Utara", names: ["maluku utara", "malut", "ternate", "tidore", "halmahera", "sofifi", "morotai", "sula"] },
  papua: { label: "Papua", names: ["papua", "jayapura", "keerom", "sarmi", "biak", "yapen", "waropen", "mamberamo"] },
  papbar: { label: "Papua Barat", names: ["papua barat", "manokwari", "fakfak", "kaimana", "teluk bintuni", "teluk wondama"] },
  papbd: { label: "Papua Barat Daya", names: ["papua barat daya", "sorong", "raja ampat", "maybrat", "tambrauw"] },
  papteng: { label: "Papua Tengah", names: ["papua tengah", "nabire", "mimika", "timika", "paniai", "puncak jaya", "intan jaya", "dogiyai", "deiyai"] },
  pappeg: { label: "Papua Pegunungan", names: ["papua pegunungan", "wamena", "jayawijaya", "lanny jaya", "yahukimo", "tolikara", "nduga", "pegunungan bintang", "yalimo"] },
  papsel: { label: "Papua Selatan", names: ["papua selatan", "merauke", "boven digoel", "mappi", "asmat"] },
};

// Longest first, so "papua barat daya" wins over "papua" and "maluku utara"
// over "maluku".
const NAMES = Object.entries(PROVINCES)
  .flatMap(([id, p]) => p.names.map((n) => [n, id] as const))
  .sort((a, b) => b[0].length - a[0].length);
const LOOKUP = new Map<string, string>(NAMES);
const RX = new RegExp(`\\b(${NAMES.map(([n]) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");

/** The provinces a text names, as ids of PROVINCES. */
export function provincesIn(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(RX)) {
    const id = LOOKUP.get(m[1].toLowerCase());
    if (id) out.add(id);
  }
  return out;
}

/**
 * Group a set of texts by place: texts naming a shared province fall in one
 * group, and a text naming none is left out. More than one group means the
 * texts are set in places nothing connects, as a Lokon wildfire and a
 * Tangerang factory fire are.
 */
export function placeGroups(texts: (string | null)[]): { provinces: string[]; count: number }[] {
  const groups: { provinces: Set<string>; count: number }[] = [];
  for (const text of texts) {
    let here = provincesIn(text);
    if (here.size === 0) continue;
    let count = 1;
    for (const g of groups.filter((g) => [...g.provinces].some((p) => here.has(p)))) {
      groups.splice(groups.indexOf(g), 1);
      here = new Set([...here, ...g.provinces]);
      count += g.count;
    }
    groups.push({ provinces: here, count });
  }
  return groups
    .map((g) => ({ provinces: [...g.provinces].sort(), count: g.count }))
    .sort((a, b) => b.count - a.count);
}

export function provinceLabel(id: string): string {
  return PROVINCES[id]?.label ?? id;
}
