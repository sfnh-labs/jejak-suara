"""Batch: generate ukiyo-e event illustrations via A1111 WebUI's API, matching the
accepted reference's exact recipe (steps=8, cfg=2, DPM++ SDE Karras, ADetailer
face+hand+face passes) instead of the bare sd-cli.exe path that produced mangled
faces/hands.

Requires WebUI running with --api (see D:\\Tools\\stable-diffusion\\webui-user.bat).

Usage: python scripts/gen_event_images_webui.py [--smoke]
"""
import glob, json, os, re, sys, time, base64, urllib.request

API = "http://127.0.0.1:7860"
STYLE_SUFFIX = (
    "sumi ink bold outlines, woodblock print, flat colors indigo blue madder red ochre, "
    "dramatic perspective, washi paper texture"
)
NEGATIVE = "photorealistic, 3d, modern, digital art, painting, crowd, many people, multiple people, background characters"
OUT_DIR = r"D:\Projects\jejak-suara\web\public\images\peristiwa"

ADETAILER_UNIT = {
    "ad_confidence": 0.3,
    "ad_dilate_erode": 4,
    "ad_mask_blur": 4,
    "ad_denoising_strength": 0.4,
    "ad_inpaint_only_masked": True,
    "ad_inpaint_only_masked_padding": 32,
}

# (event_id, title, scene) — trimmed to 2-4 figures; crowds mangle at 8 steps.
EVENTS = [
    (16576, 'MTQ Nasional XXXI Berlangsung dengan Sukses di Jawa Tengah',
     'national Quran recitation contest, a young reciter in a white cap and robe standing on a decorated stage with a hand raised mid-recitation, three seated judges at a long table with score sheets, an ornate mosque-shaped backdrop'),
    (16543, 'DPRD DKI Dorong Desalinasi Air Laut untuk Antisipasi Kekeringan',
     'seawater desalination proposal, a city councillor in a dark suit and an engineer in a hard hat standing beside a seaside pipe and tank structure, a model of a desalination plant on a table, the sea and a harbour behind'),
    (16419, 'Pembukaan LRT Jakarta Rute Kelapa Gading-Manggarai',
     'light rail line opens, a governor in a plain uniform shirt and a transport official cutting a ribbon at a station platform, a short train waiting at the platform behind them, a bridge-like elevated track'),
    (16383, 'Pramono Anung Wibowo Inginkan Renovasi RPTRA Kalijodo',
     'park renovation plan, a governor in a plain uniform shirt unrolling a design sketch beside a worn playground, two children on a swing, a worker with a paint bucket, a city park with trees and a river behind'),
    (16043, 'Pemerintah Ingatkan Distribusi dan Kualitas Beras Sesuai Standar',
     'rice quality warning, an official in a batik shirt holding up a sample of rice grains at a wholesale warehouse table, a wholesaler beside him with a weighing scale, tall stacks of rice sacks behind'),
    (16011, 'Waka MPR Meminta Dukungan Kampus untuk RUU Pengendalian Perubahan Iklim',
     'climate bill seeks campus support, a deputy assembly speaker in a dark suit and a university rector in academic robes seated at a table with a bill folder, a globe on the table, tall arched campus windows with trees outside'),
    (15614, 'Pengesahan UU Reforma Agraria',
     'land reform law passed, a parliament leader in a dark suit raising a gavel at the dais, a smiling farmer in a straw hat holding a land certificate scroll standing before it, a field-and-plot map on the wall'),
    (15608, 'Gubernur Kaltim Meliburkan Sekolah Akibat Asap Kebakaran Hutan',
     'school closed because of smoke, a governor in a plain uniform shirt announcing at a school gate with a closed sign, two schoolchildren in masks holding bags, a hazy orange sky and a river behind'),
    (15600, 'Pergantian Menteri Keuangan Suahasil Nasution',
     'finance minister handover, an outgoing minister in a dark suit passing a leather briefcase to his successor across a desk, a staff member holding a ceremonial document, a wall chart of coins and bars'),
    (15150, 'Pekanbaru Menorehkan Pertumbuhan Ekonomi Tertinggi Triwulan II 2026',
     'city economic growth, a mayor in a formal uniform standing before a rising bar chart on a large board, a city statistician beside him, a river city skyline with a bridge and oil-palm trucks behind'),
    (15134, 'Tito Imbau Kepala Daerah Dukung Verifikasi Pembangunan Koperasi Desa',
     'interior minister urges verification of cooperatives, a minister in a civil-service uniform at a long table addressing two district heads who nod, a stack of cooperative files and a village map on the table'),
    (15126, 'Pelantikan Menteri di Istana Kepresidenan',
     'ministers sworn in, a new minister in a dark suit raising his right hand over a holy book held by an attendant, the president in a batik jacket standing opposite, palace pillars and a national emblem behind'),
    (14926, 'Kenaikan Harga Pangan Ditegaskan oleh BPS dan Ditanggapi Mendagri',
     'food price rise confirmed, a statistics official holding a chart of rising chilli and shallot prices and a minister in a civil-service uniform looking at it, a market stall with chilies and onions beside them'),
    (14904, 'Pramono Anung Umumkan Tarif LRT Kelapa Gading-Manggarai',
     'light rail fare announced, a governor in a plain uniform shirt pointing at a board with a fare list at a station entrance, a commuter reading the board, a train and elevated track behind'),
    (16547, 'Mendagri Dorong Pengelolaan Perbatasan dan Pelayanan Publik',
     'border management and public services, a minister in a civil-service uniform pointing at a border map beside a border post with a flag, a local official and a border guard at attention, green hills behind'),
    (15163, 'Perkuatan Sistem Pencegahan Kebakaran di Indonesia',
     'fire prevention system, two firefighters in helmets and a forestry official checking a tall wooden fire watchtower with a radio, a hose reel and a map of hotspots, a green forest behind'),
    (15131, 'Pendidikan dan Peluang Pendidikan Bagi Anak-Anak Putus Sekolah di SKB',
     'second-chance learning centre, a teacher in a batik shirt at a chalkboard teaching three young students at wooden desks, a banner of a community learning centre, books stacked on a shelf behind'),
    (15972, 'RUU Pemilu dan Ambang Batas Parlemen',
     'election bill threshold debate, two legislators in suits arguing over a bar chart of vote shares across a long table, a stack of draft documents, a parliament emblem on the wall behind'),
    (16583, 'DPRD Surabaya Dorong Pengerjaan Proyek Pengendalian',
     'flood control project, a city councillor in a dark suit and a contractor in a helmet inspecting a large drainage box culvert under construction, a pump and a yellow excavator behind, a city skyline'),
    (14894, 'Sidang dan Pengesahan Peraturan Daerah di DKI Jakarta',
     'city council passes a regulation, a council chairman at a dais raising a gavel, two councillors seated below clapping, a city coat of arms on the wall and a wooden bench'),
    (22839, "Komjen Suyudi Janji Warga Tak Perlu Tunggu 'No Viral No Justice'",
     'police general promises accessible justice, a senior police officer in dress uniform seated at a wooden desk speaking kindly to a villager in plain clothes who holds a written complaint, a scales-of-justice scroll behind'),
    (22812, 'Kualitas Udara di Berbagai Wilayah Sumatera Selatan Terancam Asap Karhutla',
     'smoky air over a river town, a health worker in a mask holding up an air-quality gauge on a wooden pier, a boatman in a mask beside his boat, grey haze over the river and stilt houses, a pale orange sun'),
    (22779, 'Legislator PDI Perjuangan Tinjau Pengerjaan Saluran Air di Jelambar Baru Cegah Banjir',
     'legislator inspects a drainage canal, a man in a red party jacket standing on a canal bank beside two labourers in conical hats digging out a channel, a city neighbourhood of tiled roofs behind them'),
    (22745, 'Wamendagri Dorong Sumbar Perkuat Ketangguhan Menghadapi Bencana',
     'disaster resilience briefing, a deputy minister in a field vest pointing at a hazard map pinned on a wooden board, a local official and a rescue volunteer in an orange vest listening, green hills and a lake behind'),
    (22741, 'Pramono Anung Umumkan Beberapa Peristiwa dan Rencana di DKI Jakarta',
     'governor announces city plans, a middle-aged man in a plain governor uniform shirt standing at a small podium in front of a city hall with a city model on a table beside him, two reporters with notebooks'),
    (22721, 'Pasar Serdang Terbakar dan Akan Direvitalisasi',
     'market burned and to be rebuilt, two traders sorting through blackened wooden stalls with charred beams, a city official unrolling a plan of the new market on a table, smoke fading in the sky behind'),
    (22714, 'Bapanas Menegaskan Harga Beras Premium di PIBC Masih Wajar',
     'rice price check at a wholesale market, an official in a batik shirt inspecting a sack of premium rice with a scoop, a wholesaler beside him with a scale, tall stacks of rice sacks behind them'),
    (22636, 'Menkum Supratman Klaim Mediasi Sukses di Posbankum, Hemat Negara Rp1,2 Triliun',
     'legal aid mediation success, a minister in a dark suit standing beside a village legal aid post with a signboard, a village head and a villager shaking hands after a mediation, a stack of closed case files on a bench'),
    (22485, 'Pemprov Jawa Barat Hentikan Sementara Pembangunan Pusat Data AI di Jatiluhur',
     'construction halted beside a reservoir, a provincial official holding up one hand in a stop gesture to a contractor in a hard hat, an unfinished concrete building and a wide reservoir with green hills behind'),
    (22479, 'Wamendagri Tekankan Kolaborasi Lintas Sektor dalam Upaya Eliminasi TBC di Pulau Jawa',
     'tuberculosis elimination meeting, a deputy minister at the head of a meeting table with a health official and a doctor in a white coat, a wall chart showing a map of Java islands, folded masks on the table'),
    (22558, 'Kabel Semrawut di Jalan Kuningan Barat Raya, Jakarta Selatan',
     'tangled overhead cables above a street, a city worker on a ladder lifting a bundle of sagging cables off a utility pole, a street vendor and a passer-by looking up, shop awnings and a narrow city street'),
    (22381, 'Pedoman Upacara Hari Kesaktian Pancasila 2026 Ditetapkan',
     'ceremony guidelines for Pancasila Day, a ceremony officer in dress uniform holding a rolled guidebook beside a flagpole, two schoolchildren in uniform raising a red-and-white flag, a garuda emblem on a banner'),
    (22326, 'Pendaftaran SMA KTB Tahun Ajaran 2027/2028 Dibuka',
     'school registration opens, a teacher in a batik shirt at a registration desk handing a form to a student in a white-and-grey uniform, a parent standing behind, a school gate with a banner above'),
    (22169, 'Imam Masjidil Aqsa Mengajak Bersatu Untuk Palestina dan Al-Aqsa',
     'a call for unity, an imam in a white robe and turban standing at a mosque pulpit raising one hand in prayer, a golden dome and a large flag of Palestine hanging on the arched wall behind him'),
    (22082, 'BPS Memberikan Penghargaan untuk Kontribusi Data Statistik',
     'statistics agency award ceremony, an official in a formal jacket presenting a plaque to a data officer who bows to receive it, a wall chart of rising bars behind them, a vase of flowers on a table'),
    (22028, 'Rahmat Erwin Raih Medali Emas Angkat Besi Kategori 75 Kg Asian Games 2026',
     'weightlifting gold medal, a strong young weightlifter in a red singlet holding a gold medal up with one hand, a coach in a tracksuit clapping beside him, a barbell on a platform behind'),
    (21905, 'Pembiayaan UMKM Melalui Transaksi QRIS',
     'small business financing by QR payment, a smiling market stall owner holding up a phone showing a square QR code to a customer, a bank officer in a neat uniform standing beside the stall holding a folder'),
    (21895, 'Peringatan Hari Bhakti Postel Tahun 81 dengan Tema T3',
     'post and telecom day anniversary, a postal worker in an orange uniform with a mailbag and a telecom engineer in a hard hat standing side by side before an old post office building with a banner and bunting'),
    (21887, 'Gunung Semeru Erupsi Berulang dan Hujan Abu di Beberapa Daerah',
     'volcanic ash falling on a village, two villagers in masks sweeping grey ash off a tiled roof with brooms, a motorbike coated in ash below, a smoking volcano cone against a dim sky'),
    (21726, 'Kementerian PU Berupaya Mengatasi Kekeringan di Jawa Barat dan Bekasi',
     'drought relief, an engineer in a helmet and a local official standing beside a cracked dry reservoir bed, a pump and a pipe laid across the cracked earth, a water tanker truck waiting behind'),
    (21645, 'Petani Jakarta dan Seputaran Manfaatkan Lahan untuk Urban Farming',
     'urban farming, a woman farmer in a conical hat and an older man planting seedlings in raised beds on a vacant lot, tall apartment blocks looming behind, watering cans on the ground'),
    (21635, 'Kementerian Kebudayaan Mulai Revitalisasi Keraton Surakarta',
     'palace restoration begins, a restoration expert in a traditional batik outfit and a worker with a brush on scaffolding repairing a carved pavilion roof, a palace courtyard with a banyan tree and ornate gates'),
    (21616, 'Layanan SIM Keliling Tersedia di Lima Lokasi Jakarta',
     'mobile driving licence service, a police officer in uniform at a small table beside a van with a service signboard, a young man having his photo taken for a licence, a queue sign and a tree-lined street behind'),
    (21684, 'Muhammadiyah Optimalkan Peran Jamaah Tani dalam Pertanian',
     "farmers' congregation programme, a community leader in a white shirt and black cap teaching two farmers in straw hats beside a demonstration plot of young rice, a sun-lit paddy field and a small mosque beyond"),
    (23373, '53 Jemaah Umroh Makassar Batal Berangkat Imbas Serangan Houthi di Riyadh',
     'pilgrims cancel a trip abroad, two elderly pilgrims in white garments sitting on a bench at an airport hall holding folded travel papers and looking worried, a tour guide in a sash beside them, a large window with a grounded airplane behind'),
    (23246, 'Imigrasi Tolak Visa Musisi Israel Houghton',
     'immigration refuses a visa, a stern immigration officer in uniform behind a wooden counter stamping a red refusal mark on a passport, a traveller with a guitar case waiting on the other side, a national emblem on the wall'),
    (22531, 'Penyesuaian Tarif Transjakarta dan Transportasi DKI di 2027',
     'city bus fare adjustment announced, a transport official in a batik shirt pointing at a fare chart pinned to a board beside a long bus shelter, a bus stopped at the platform behind, a commuter reading the chart'),
    (22530, 'Pemerintah Siapkan Sistem Saluran Subsidi dan Bantuan di Kopdes Merah Putih',
     'village cooperative to distribute subsidies, a village head and a cooperative manager standing at a wooden counter stacked with sacks of rice and a ledger, a red-and-white signboard above the door, rice fields visible through the doorway'),
    (22629, 'PT KAI Evaluasi Setelah Temuan KNKT',
     'railway company reviews a safety finding, a railway executive in a uniform cap and an investigator with a report folder studying a model of a level crossing on a table, a stopped train and signal tower visible through the window'),
    (23179, 'Surat MA Nyasar ke Pengadilan Agama, Bupati Gowa Laporkan PT Pos',
     'misdelivered court letter, a district head in a formal uniform holding up a sealed envelope and pointing at the wrong address, a postal clerk in an orange uniform across a post-office counter looking apologetic'),
    (22580, 'Menteri Koordinator Bidang Pangan Tawarkan Insentif Pasar Karbon',
     'carbon market incentive offered, a senior minister in a batik shirt presenting a scroll with a forest and coin diagram to two investors seated at a low table, a lush green mangrove forest through the open window behind'),
    (23621, 'KPK Lakukan Operasi Tangkap Tangan di BNPB',
     'anti-corruption commission sting at a disaster agency office, two investigators in dark jackets carrying sealed evidence boxes past a startled official at a desk covered in paperwork, an agency signboard on the wall'),
    (23618, 'Kapal Wisata KM Feronia Tenggelam di Labuan Bajo, 24 Penumpang Selamat',
     'tourist boat sinks near a harbour island, rescuers in a small wooden boat pulling two relieved passengers in orange life jackets aboard, a half-submerged tour boat and rocky islands behind them'),
    (23605, '100 Hektare Kebakaran di Cagar Alam Gunung Lokon',
     'forest fire on a volcanic nature reserve, two firefighters in helmets dragging a hose up a slope, orange flames and rising smoke on the ridge, a volcano cone in the distance'),
    (23581, 'BI Sulsel dan Koderal VI Bawa Rp25 Miliar ke Pulau 3T',
     'central bank and navy carry cash to remote islands, a bank officer and a navy sailor lifting a sealed cash box from a gray warship onto a wooden jetty, a small island village behind them'),
    (23337, 'Menlu RI Tegaskan Komitmen Mendukung Palestina',
     'foreign minister reaffirms support for Palestine, a diplomat in a dark suit at a lectern before a wall of international flags, an aide beside him holding a folder, one hand raised in emphasis'),
    (23321, 'Ijazah Wapres Gibran Masih Jadi Polemik',
     'diploma controversy around the vice president, a young man in a suit holding a framed certificate and looking down at it, two officials across a table examining a stack of documents with a magnifying glass'),
    (23313, 'Kabut Asap Akibat Karhutla Menyelimuti Sejumlah Daerah',
     'haze from forest fires blankets a town, a commuter in a face mask on a motorbike and a street vendor in a mask beside a stall, a dim orange sun barely visible through grey smoke over rooftops'),
    (23305, 'Kapolri Rombak Jabatan Strategis Korlantas dan TNI AU',
     'police chief reshuffles senior posts, a police general in dress uniform handing a decree scroll to a bowing officer, an air force officer standing at attention beside them, the national emblem behind'),
    (23103, 'Pertandingan Final FIFA ASEAN Cup 2026 Terlaksana di GBK, Indonesia Juara',
     'football final won at a national stadium, two players in red shirts raising a golden trophy together on the pitch, a coach hugging one of them, floodlights and empty stands behind them at dusk'),
    (22930, 'Presiden Prabowo Lantik Syahganda Nainggolan Menjadi Kepala Bakom',
     'swearing-in of an agency head, the president in a formal batik jacket standing before a new official who raises his right hand over a holy book held by an attendant, palace pillars and the national emblem behind'),
    (22890, 'Presiden Prabowo Melantik Pejabat Baru',
     'president inaugurates new officials, the president at a wooden table presenting a decree scroll to a newly appointed minister in a dark suit, two aides standing by with folders, palace hall behind'),
    (22748, 'Pencalonan dan Pengangkatan Jenderal Suyudi Sebagai Kapolri',
     'police general nominated as national police chief, a police general in dress uniform with medals standing before a parliamentary panel seated at a long table, one hand raised as he answers questions'),
    (22562, 'Pertemuan Antara Prabowo dan Megawati untuk Makan Nasi Goreng',
     'two political elders share a casual meal, a heavyset president and an elderly woman party chair seated across a small table with two plates of fried rice, warm lamplight, a quiet garden through the window'),
    (23121, 'Gempa Mengguncang Sumba Barat Daya, Rusak Ribuan Bangunan',
     'earthquake damages homes in an island district, two villagers carrying a salvaged cooking pot past a house with a collapsed thatched roof, cracked walls, hills and palm trees behind'),
    (23348, 'Pemerintah Tetapkan Kebakaran Hutan Masih Dalam Kontrol',
     'government declares the wildfires under control, a minister in a field jacket and a forestry officer standing at a command tent table with a map of burned areas, a thin smoke line far behind'),
    (22523, 'Pengunduran Diri dan Sidang Terdakwa Roy Suryo',
     "court hearing for a defendant, a man in a dark suit seated in the defendant's chair beside his lawyer, a robed judge at the high bench and a clerk, a wooden courtroom with a scales emblem"),
    (762, "KPK ajak publik pantau sidang Yaqut",
     "KPK court trial hearing, a formal Indonesian courtroom with a wooden judges bench, "
     "a judge in a black robe seated behind the bench, a defendant standing at a podium "
     "with an escort officer beside him, a red KPK emblem banner on the wall"),
    (761, "Rektor USU kebijakan strategis lima pilar",
     "university rector policy address, a rector in academic robes standing at a wooden "
     "lectern beside an aide holding a scroll with five pillar diagrams, tall arched "
     "windows behind them"),
    (760, "Kunjungan Jokowi perkuat PSI",
     "former president visits political party headquarters, a distinguished elder "
     "statesman shaking hands with a young party leader, a large survey chart scroll "
     "hanging on the wall behind them, festive bunting"),
    (758, "Waketum MUI Marsudi Syuhud calon Ketum PBNU",
     "Islamic organization leadership candidacy announcement, a religious leader in white "
     "peci and sarong standing at a podium raising one hand, an aide beside him holding "
     "papers, a large calligraphy banner overhead"),
    (728, "Pimpinan MPR temui Prabowo di Istana",
     "parliamentary leaders meet the president at the palace, the president in a formal "
     "batik jacket seated at a wooden table, two parliament leaders in dark suits sitting "
     "across from him mid conversation, tall palace pillars and a national emblem visible "
     "through a window behind them"),
    (719, "DPR safari ke partai nonparlemen bahas RUU Pemilu",
     "parliament delegation visits minor party office, a legislator in a suit seated "
     "across a low table from a party representative, stacks of draft election law "
     "documents between them, a small party flag on the wall"),
    (707, "Menhan: latihan bersama pasukan khusus RI-Thailand",
     "defense minister announces joint special forces training, a minister in military "
     "uniform gesturing toward a map of joint exercise routes, one special forces soldier "
     "standing at attention beside him, national flags crossed overhead"),
    (689, "Koalisi Buruh batal demo, cemas ada penyusup",
     "labor coalition cancels planned protest, two worker leaders in headbands and vests "
     "seated at a table looking wary, a protest banner rolled up and set aside in the corner"),
    (677, "Kejagung geledah 4 perusahaan Don Ritto",
     "prosecutors raid company office for a money laundering probe, an investigator in a "
     "dark jacket carrying a document box past a startled clerk at a desk covered in "
     "ledgers, a company signboard askew above the door"),
]


def slug(text, n=60):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:n]


def post(path, payload, timeout=3600):
    req = urllib.request.Request(
        f"{API}{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def build_payload(scene):
    return {
        "prompt": f"Ukiyo-e Art, {scene}, {STYLE_SUFFIX}",
        "negative_prompt": NEGATIVE,
        "steps": 8,
        "cfg_scale": 2,
        "width": 1216,
        "height": 832,
        "sampler_name": "DPM++ SDE",
        "scheduler": "Karras",
        "seed": -1,
        "batch_size": 1,
        "override_settings": {"sd_model_checkpoint": "DreamShaperXL_Turbo_v2_1.safetensors"},
        "override_settings_restore_afterwards": False,
        "alwayson_scripts": {
            "ADetailer": {
                "args": [
                    True, False,
                    {"ad_model": "face_yolov8n.pt", **ADETAILER_UNIT},
                    {"ad_model": "hand_yolov8n.pt", **ADETAILER_UNIT},
                    {"ad_model": "face_yolov8n.pt", **ADETAILER_UNIT},
                ]
            }
        },
    }


def generate(event_id, title, scene):
    payload = build_payload(scene)
    out = os.path.join(OUT_DIR, f"{event_id}-{slug(title)}.png")
    print(f"[{event_id}] {title}")
    t0 = time.time()
    result = post("/sdapi/v1/txt2img", payload)
    img_b64 = result["images"][0]
    with open(out, "wb") as f:
        f.write(base64.b64decode(img_b64))
    print(f"  saved {out} ({time.time() - t0:.1f}s)")
    return out


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    if "--smoke" in sys.argv:
        eid, title, scene = next(e for e in EVENTS if e[0] == 728)
        generate(eid, f"SMOKETEST-{title}", scene)
    else:
        limit = None
        for a in sys.argv:
            if a.startswith("--count="):
                limit = int(a.split("=", 1)[1])
        until = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--until=")), None)
        done = 0
        for eid, title, scene in EVENTS:
            if limit is not None and done >= limit:
                break
            # an event takes ~17 min; do not start one that cannot finish by the deadline
            if until and time.strftime("%H:%M", time.localtime(time.time() + 1100)) >= until:
                print(f"deadline {until} reached, stopping")
                break
            if glob.glob(os.path.join(OUT_DIR, f"{eid}-*.*")):
                print(f"[{eid}] {title} -- already done, skipping")
                continue
            generate(eid, title, scene)
            done += 1
        print("ALL DONE")
