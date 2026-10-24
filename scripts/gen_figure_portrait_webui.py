"""Generate a stylized figure portrait — pure txt2img, same recipe as the
peristiwa event pipeline (gen_event_images_webui.py).

v1-v6 forced a real reference photo into img2img (pixels/edges) for likeness;
v10 tried IP-Adapter (CLIP-vision identity embedding) instead. Both fought the
same tension: any nonzero photo conditioning overpowers this checkpoint's weak
cfg=2 style prompt and drags the result toward photorealism, regardless of the
conditioning mechanism or weight (tested 0.75/0.35/0.2 — all photorealistic).

v11: drop identity conditioning entirely. Likeness only needs to be a build/
role resemblance, not a face match, so describe physique and role the same
way the event scenes describe figures (generic build cues, role, action/
podium framing) rather than itemizing facial features — v8's itemized
"bald head, thick mustache" description caused a cartoon caricature even with
those terms in the negative prompt. The event pipeline never hits this
failure because its figures are described the same lightweight way.

Requires WebUI running with --api.

Usage: python scripts/gen_figure_portrait_webui.py
"""
import glob, json, os, re, sys, time, base64, urllib.request

API = "http://127.0.0.1:7860"
STYLE_SUFFIX = (
    "sumi ink bold outlines, woodblock print, flat colors indigo blue madder red ochre, "
    "dramatic perspective, washi paper texture"
)
NEGATIVE = "photorealistic, 3d, modern, digital art, painting, crowd, many people, multiple people, background characters"
# Relative to this file, so a run from a worktree writes into that worktree.
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "public", "images", "tokoh")
WIDTH, HEIGHT = 768, 1024
STEPS = 8

ADETAILER_UNIT = {
    "ad_confidence": 0.3,
    "ad_dilate_erode": 4,
    "ad_mask_blur": 4,
    "ad_denoising_strength": 0.4,
    "ad_inpaint_only_masked": True,
    "ad_inpaint_only_masked_padding": 32,
}

FIGURES = [
    # Prabowo first; the rest follow in order of event coverage. Described by
    # role and setting only -- no itemised facial features (see the skill).
    (
        "prabowo-subianto",
        "Prabowo Subianto",
        "Indonesian president, a heavyset elder statesman with a very round plump face, "
        "double chin, and a stocky barrel-shaped body, close-cropped grey hair, standing "
        "at a wooden podium raising one hand while addressing an assembly, army officers "
        "seated behind him, a national emblem banner overhead",
    ),
    (
        'pramono-anung-wibowo',
        'Pramono Anung Wibowo',
        "a middle-aged man in a plain governor's uniform shirt, standing in a bustling market lane greeting two vendors, a city skyline and a commuter train behind him",
    ),
    (
        'tito-karnavian',
        'Tito Karnavian',
        'a lean middle-aged man in a formal dark civil-service uniform with a ministerial badge, seated at a long desk signing a document, a map of the archipelago on the wall behind him',
    ),
    (
        'gibran-rakabuming-raka',
        'Gibran Rakabuming Raka',
        'a tall young man in a white shirt with rolled sleeves and a dark vest, standing on a small stage presenting to an audience of schoolchildren, a youthful and energetic stance',
    ),
    (
        'prasetyo-hadi',
        'Prasetyo Hadi',
        'a middle-aged man in a dark suit speaking at a lectern with a cluster of microphones, a palace facade behind him, one hand gesturing as he addresses reporters',
    ),
    (
        'zulkifli-hasan',
        'Zulkifli Hasan',
        'a stocky older man in a batik shirt, standing in a rice warehouse beside tall stacks of sacks, inspecting a sack of grain with one hand',
    ),
    (
        'gus-ipul',
        'Gus Ipul',
        'a middle-aged man wearing a black peci cap and a white koko shirt, standing at a village hall table handing a packet of aid to a seated elderly villager',
    ),
    (
        'puan-maharani',
        'Puan Maharani',
        'a woman in her fifties in a formal kebaya jacket, seated at the high rostrum of a parliament chamber holding a wooden gavel, tiered benches behind her',
    ),
    (
        'megawati-soekarnoputri',
        'Megawati Soekarnoputri',
        'an elderly woman of dignified bearing with swept-back grey hair, standing at a wooden podium with one hand raised, addressing a party congress, red banners behind her',
    ),
    (
        'saan-mustopa',
        'Saan Mustopa',
        'a middle-aged man in a dark suit and songkok-style cap, seated at a committee table in a parliament meeting room, leaning forward as he questions a witness',
    ),
    (
        'jumhur-hidayat',
        'Jumhur Hidayat',
        'a middle-aged man in a field jacket, standing on a river bank holding up a water sample jar, factory chimneys and green hills behind him',
    ),
    (
        'amran-sulaiman',
        'Amran Sulaiman',
        "a sturdy middle-aged man in a farmer's wide-brimmed hat and work shirt, standing in a golden rice field holding a bundle of harvested stalks, a combine harvester far behind",
    ),
    (
        'nusron-wahid',
        'Nusron Wahid',
        'a middle-aged man in a land-office uniform shirt, standing before a large cadastral map pinned to a board, pointing at a boundary line with a pen',
    ),
    (
        'sjafrie-sjamsoeddin',
        'Sjafrie Sjamsoeddin',
        'a broad-shouldered older man in a defence ministry uniform with a peaked cap, standing at attention on a parade ground reviewing a line of soldiers, flags overhead',
    ),
    (
        'nasaruddin-umar',
        'Nasaruddin Umar',
        'a gentle elderly man in a white turban and robe, seated cross-legged on a mat in a mosque hall, an open book on a low wooden stand in front of him',
    ),
    (
        'bahlil-lahadalia',
        'Bahlil Lahadalia',
        'a middle-aged man in a dark suit and hard hat, standing beside oil pipelines and storage tanks at dusk, pointing toward a refinery tower',
    ),
    (
        'dedi-mulyadi',
        'Dedi Mulyadi',
        'a middle-aged man in a white shirt and a traditional Sundanese headcloth, standing in a green terraced rice field talking with a farmer, a mountain behind',
    ),
    (
        'bobby-nasution',
        'Bobby Nasution',
        'a tall younger man in a governor dress shirt, standing on a muddy road inspecting repairs with a clipboard, road machinery behind him',
    ),
    (
        'fadli-zon',
        'Fadli Zon',
        'a man in his fifties in a refined dark jacket, standing in a museum gallery beside a glass case of old manuscripts and ceremonial daggers, gesturing toward them',
    ),
    (
        'said-abdullah',
        'Said Abdullah',
        'a stocky middle-aged man in a suit with a red party lapel pin, seated at a party office desk with a stack of budget papers, a red flag behind him',
    ),
    (
        'andre-rosiade',
        'Andre Rosiade',
        'a middle-aged man in a dark suit, speaking energetically into a microphone at a parliamentary hearing table, one fist raised for emphasis',
    ),
    (
        'budiman-sudjatmiko',
        'Budiman Sudjatmiko',
        'a middle-aged man in a casual open-collar shirt, sitting on a village veranda reviewing a poverty-programme ledger with a local resident',
    ),
    (
        'ahmad-luthfi',
        'Ahmad Luthfi',
        'a broad middle-aged man in a governor formal uniform, standing before a map of Central Java, a temple silhouette beyond the window',
    ),
    (
        'erick-thohir',
        'Erick Thohir',
        'a fit middle-aged man in a sports tracksuit jacket, standing on a football pitch holding a ball under one arm, stadium stands behind him',
    ),
    (
        'meutya-hafid',
        'Meutya Hafid',
        'a woman in her forties in a smart blazer and headscarf, standing at a lectern in front of a large screen of network diagrams, presenting to an audience',
    ),
    (
        'ahmad-sahroni',
        'Ahmad Sahroni',
        'a middle-aged man in a dark suit seated at a long committee table, a gavel and microphone before him, leaning forward to ask a question',
    ),
    (
        'eddy-soeparno',
        'Eddy Soeparno',
        'a middle-aged man in a dark suit, seated on the dais of an assembly hall beneath a national emblem, reading from a bound document',
    ),
    (
        'rano-karno',
        'Rano Karno',
        'a distinguished older man in a Betawi-style traditional outfit with a sash, standing in an old Jakarta street with traditional wooden shopfronts, one hand raised in greeting',
    ),
    (
        'andra-soni',
        'Andra Soni',
        'a middle-aged man in a governor uniform shirt, standing on a coastal port quay beside stacked containers, a ship and cranes behind him',
    ),
    (
        'dudung-abdurachman',
        'Dudung Abdurachman',
        'a stern older man in a retired general civilian jacket with service ribbons, seated at a security briefing table with maps and telephones',
    ),
    (
        'hasto-kristiyanto',
        'Hasto Kristiyanto',
        'a lean middle-aged man in a dark shirt with a red party scarf, standing at a party headquarters press podium, speaking calmly to reporters',
    ),
    (
        'natalius-pigai',
        'Natalius Pigai',
        'a middle-aged man in a formal jacket, standing at a lectern in a human rights hall, one hand open as he speaks, a scales of justice emblem behind him',
    ),
    (
        'setyo-budiyanto',
        'Setyo Budiyanto',
        'a firm middle-aged man in an anti-corruption commission uniform with a peaked cap, standing before a table of seized evidence boxes at a press briefing',
    ),
    (
        'titiek-soeharto',
        'Titiek Soeharto',
        'a woman in her sixties in an elegant kebaya jacket, standing in a farmland field talking with farmers, a parliament lanyard around her neck',
    ),
    (
        'agung-nugroho',
        'Agung Nugroho',
        'a middle-aged man in a mayor sash and uniform, standing on a riverside promenade beside a new bridge, holding ribbon-cutting scissors',
    ),
    (
        'donald-trump',
        'Donald Trump',
        'an older tall heavyset man in a long dark suit and long red tie, standing at a large desk with a flag behind him, one hand pointing forward',
    ),
    (
        'benjamin-netanyahu',
        'Benjamin Netanyahu',
        'an older man in a dark suit with a blue tie, speaking at a wide assembly podium with a flag behind him, one finger raised',
    ),
    (
        'dede-yusuf',
        'Dede Yusuf',
        'a middle-aged man in a blue party jacket, standing on a rural road with a megaphone, a blue party flag behind him',
    ),
    (
        'febri-diansyah',
        'Febri Diansyah',
        'a lean middle-aged man in a dark suit, seated at a law office desk beneath bookshelves, reading a case file',
    ),
    (
        'ferry-juliantono',
        'Ferry Juliantono',
        'a middle-aged man in a batik shirt, standing in a village cooperative store handing over a ledger to a shopkeeper',
    ),
    (
        'rosan-roeslani',
        'Rosan Roeslani',
        'a middle-aged man in an immaculate dark suit, standing in a glass boardroom beside a wall chart of investments, shaking hands with a partner',
    ),
    (
        'ganjar-pranowo',
        'Ganjar Pranowo',
        'a middle-aged man with white hair in a white shirt and rolled sleeves, standing among farm fields with a smiling gesture, a red party scarf at his neck',
    ),
    (
        'vladimir-putin',
        'Vladimir Putin',
        'a compact middle-aged man in a dark suit and tie, seated at a long polished table in an ornate hall, hands folded, a tricolour flag behind him',
    ),
    (
        'xi-jinping',
        'Xi Jinping',
        'a stout older man in a dark Zhongshan-style suit, standing at a podium in a vast hall with a red flag behind him, speaking calmly',
    ),
    (
        'basuki-hadimuljono',
        'Basuki Hadimuljono',
        'a middle-aged man in a safety helmet and site vest, standing on a hill construction site overlooking a new city, holding a rolled blueprint',
    ),
    (
        'cak-imin',
        'Cak Imin',
        'a middle-aged man in a dark suit with a green party lapel pin, speaking to a seated assembly of villagers, a mosque dome visible behind',
    ),
    (
        'said-iqbal',
        'Said Iqbal',
        'a mid-sized middle-aged man in a labour-union jacket and cap, standing at a small stage holding a banner, a factory gate behind him',
    ),
    (
        'surya-paloh',
        'Surya Paloh',
        'an older man in a dark suit with a navy-blue party scarf, seated in a plush party headquarters armchair, hands clasped, a navy banner behind him',
    ),
    (
        'wayan-koster',
        'Wayan Koster',
        'a middle-aged man in a white Balinese headcloth and sash, standing before a carved temple gate with offerings, one hand raised in greeting',
    ),
    (
        'anwar-ibrahim',
        'Anwar Ibrahim',
        'an older man in a dark suit and songkok cap, speaking at a podium with a flag behind him, one hand gesturing outward',
    ),
    (
        'gerindra-bambang-haryadi',
        'Bambang Haryadi',
        'a middle-aged man in a dark suit with a party pin, seated at an energy committee meeting table with an oil rig diagram on a screen behind him',
    ),
    (
        'muzakir-manaf',
        'Muzakir Manaf',
        'a middle-aged man in a dark jacket and a traditional Acehnese embroidered cap, standing before a grand mosque with a seaside harbour behind him',
    ),
    (
        'narendra-modi',
        'Narendra Modi',
        'an older man with a white beard in a long tunic and a sleeveless jacket, standing at a podium with a saffron-and-green banner behind him, hands joined in greeting',
    ),
    (
        'anindya-bakrie',
        'Anindya Bakrie',
        'a younger middle-aged man in a business suit, standing in a bright trade hall with product stands, speaking to a small group of businessmen',
    ),
    (
        'anutin-charnvirakul',
        'Anutin Charnvirakul',
        'a middle-aged man in a dark suit, standing at a government house podium with a flag behind him, hands raised in a respectful greeting',
    ),
    (
        'lawrence-wong',
        'Lawrence Wong',
        'a lean middle-aged man in a white shirt without a tie, standing at a lectern with a city skyline and a harbour behind him',
    ),
    (
        'tri-adhianto',
        'Tri Adhianto',
        'a middle-aged man in a mayor uniform shirt, standing at a busy city intersection with a traffic signal behind him, speaking into a handheld radio',
    ),
    (
        'budi-prasetyo',
        'Budi Prasetyo',
        'a middle-aged man in a dark jacket, standing at a press podium in front of an anti-corruption commission building, holding a sheet of notes, speaking calmly to two reporters',
    ),
    (
        'joko-widodo',
        'Joko Widodo',
        'a lean elder statesman in a plain white shirt with rolled sleeves, walking along a riverside path greeting two villagers, a quiet bridge and green trees behind him',
    ),
    (
        'teddy-indra-wijaya',
        'Teddy Indra Wijaya',
        'a fit man in a crisp military dress uniform, standing at attention beside a palace doorway holding a leather folder, tall palace pillars behind him',
    ),
    (
        'sufmi-dasco-ahmad',
        'Sufmi Dasco Ahmad',
        'a middle-aged man in a dark suit, seated at the dais of a parliament chamber speaking into a microphone, a national emblem on the wall behind him',
    ),
    (
        'yaqut-cholil-qoumas',
        'Yaqut Cholil Qoumas',
        'a middle-aged man in a black songkok cap and dark jacket, standing at a pilgrimage hall podium with a model of a holy shrine beside him, one hand raised in greeting',
    ),
    (
        'djamari-chaniago',
        'Djamari Chaniago',
        'a stern older man in a retired general civilian jacket with service ribbons, seated at a security coordination table with maps, one hand resting on a folder',
    ),
    (
        'dudy-purwagandhi',
        'Dudy Purwagandhi',
        'a middle-aged man in a transport ministry uniform shirt, standing on a railway platform beside a train, pointing at a timetable board',
    ),
    (
        'agus-subiyanto',
        'Agus Subiyanto',
        'an armed forces commander in a green dress uniform with medals and a beret, standing at attention on a parade ground, flags and rows of soldiers far behind him',
    ),
    (
        'suyudi-ario-seto',
        'Suyudi Ario Seto',
        'a national police chief in a dark dress uniform with a peaked cap and medals, standing at a lectern before a police emblem, one hand holding his cap',
    ),
    (
        'bima-arya-sugiarto',
        'Bima Arya Sugiarto',
        'a tall middle-aged man in a batik shirt, speaking with two local officials beside a map of a region in a government hall, one hand pointing at the map',
    ),
    (
        'imipas-agus-andrianto',
        'Agus Andrianto',
        'a middle-aged man in a ministry uniform standing in a correctional facility corridor with a clipboard, a barred gate and a guard in the background',
    ),
    (
        'yusril-ihza-mahendra',
        'Yusril Ihza Mahendra',
        'a distinguished middle-aged man in a dark suit and cap, seated at a table stacked with law books, speaking while reading a legal document',
    ),
    (
        'dody-hanggodo',
        'Dody Hanggodo',
        'a middle-aged man in a safety helmet and public works vest, standing at a bridge construction site holding a rolled plan, a half-built bridge behind him',
    ),
    (
        'rudy-susmanto',
        'Rudy Susmanto',
        'a young middle-aged man in a district head uniform, standing at a village road repair site greeting a labourer, hills and tea fields behind him',
    ),
    (
        'ahmad-muzani',
        'Ahmad Muzani',
        "a middle-aged man in a dark suit, seated on the chairman's dais of an assembly hall, hands on a gavel, a large national emblem behind him",
    ),
    (
        'agus-harimurti-yudhoyono',
        'Agus Harimurti Yudhoyono',
        'a fit younger man in a blue party jacket, standing on a stage with a blue banner, one hand extended outward as he addresses a gathering',
    ),
    (
        'agus-jabo-priyono',
        'Agus Jabo Priyono',
        'a middle-aged man in a social-ministry uniform shirt, handing a food package to an elderly villager at a village hall table',
    ),
    (
        'purbaya-yudhi-sadewa',
        'Purbaya Yudhi Sadewa',
        'a middle-aged man in a dark suit, standing at a lectern in front of a large chart of bars and coins, pointing at the chart with a pen',
    ),
    (
        'budi-gunadi-sadikin',
        'Budi Gunadi Sadikin',
        'a middle-aged man in a white doctor coat over a shirt, standing in a clinic corridor holding a medical chart, a nurse beside him',
    ),
    (
        'ahmad-doli-kurnia',
        'Ahmad Doli Kurnia',
        'a middle-aged man in a yellow party jacket, seated at a committee table with a microphone, an election law book open before him',
    ),
    (
        'supratman-andi-agtas',
        'Supratman Andi Agtas',
        'a middle-aged man in a dark suit, standing at a ministry podium holding up a bound copy of a law, a scales of justice emblem behind him',
    ),
    (
        'yandri-susanto',
        'Yandri Susanto',
        'a middle-aged man in a village ministry uniform, standing in a village hall with a cardboard model of a village, speaking with a village head',
    ),
    (
        'dadan-hindayana',
        'Dadan Hindayana',
        'a middle-aged man in a dark jacket, standing in a school kitchen beside a long steel counter stacked with lunch trays, tasting a spoon of food',
    ),
    (
        'rahmat-mirzani-djausal',
        'Rahmat Mirzani Djausal',
        'a middle-aged man in a governor uniform shirt, standing on a farm road beside a pepper plantation, speaking with two farmers in straw hats, green hills behind',
    ),
    (
        'maruli-simanjuntak',
        'Maruli Simanjuntak',
        'an army chief of staff in a green dress uniform with medals and a beret, standing beside a military vehicle at a field camp, one hand resting on a map table',
    ),
    (
        'daniel-johan',
        'Daniel Johan',
        'a middle-aged man in a dark suit and a green party scarf, seated at a parliament committee table with a microphone, a farming policy report open before him',
    ),
    (
        'khofifah-indar-parawansa',
        'Khofifah Indar Parawansa',
        'a woman in her sixties in a neat headscarf and a long jacket, standing in a village hall giving a thumbs-up beside a table of local crafts, a regional banner behind her',
    ),
    (
        'muhaimin-iskandar',
        'Muhaimin Iskandar',
        'a middle-aged man in a dark suit and a green party scarf, seated in a party headquarters hall with a mosque-dome banner behind him, hands folded on a table',
    ),
    (
        'teuku-riefky-harsya',
        'Teuku Riefky Harsya',
        'a middle-aged man in a smart dark jacket, standing in a creative studio with a film camera, a drawing board and a stage model beside him',
    ),
    (
        'airlangga-hartarto',
        'Airlangga Hartarto',
        'a middle-aged man in a dark suit and a yellow party tie, standing in front of a large economic chart of rising lines, one hand gesturing, a port with cranes behind a window',
    ),
    (
        'andi-sudirman-sulaiman',
        'Andi Sudirman Sulaiman',
        'a middle-aged man in a governor uniform shirt standing on a harbour quay with traditional wooden boats, one hand raised toward the horizon, a rocky coast behind',
    ),
    (
        'sitti-husniah-talenrang',
        'Sitti Husniah Talenrang',
        'a woman in her fifties in a district head uniform and headscarf, standing at a district office desk accepting a sealed letter from a postal worker',
    ),
    (
        'saiful-bahri',
        'Saiful Bahri',
        'a middle-aged man in a district head uniform, standing at a river landing beside a wooden boat loaded with rubber sacks, a forest behind him',
    ),
    (
        'aries-syahbudin',
        'Aries Syahbudin',
        'a police traffic corps chief in a dark dress uniform with a peaked cap, standing beside a road checkpoint with a traffic cone, a police car behind him',
    ),
    (
        'arif-satria',
        'Arif Satria',
        'a middle-aged man in a lab coat over a batik shirt, holding a small seedling in a glass tube in a research laboratory with shelves of equipment',
    ),
    (
        'agustiar-sabran',
        'Agustiar Sabran',
        'a stocky middle-aged man in a governor uniform shirt and a traditional Dayak headband, standing beside a river longhouse, one hand raised in greeting',
    ),
    (
        'wahyu-hidayat',
        'Wahyu Hidayat',
        'a middle-aged man in a mayor uniform, standing in a historic city square with colonial buildings and a clock tower, inspecting a plan with an official',
    ),
    (
        'rini-widyantini',
        'Rini Widyantini',
        'a woman in her fifties in a formal jacket, seated at a ministry desk reviewing a digital service chart on a screen, a bureaucracy reform banner behind her',
    ),
    (
        'willy-aditya',
        'Willy Aditya',
        'a middle-aged man in a dark suit and a navy party scarf, seated at a parliament committee table with a human rights folder, speaking into a microphone',
    ),
    (
        'anies-baswedan',
        'Anies Baswedan',
        'a lean middle-aged man in a white shirt and dark trousers, standing at a lectern in a lecture hall addressing seated students, a simple chalk diagram behind him',
    ),
    (
        'viva-yoga-mauladi',
        'Viva Yoga Mauladi',
        'a middle-aged man in a transmigration ministry uniform, standing at a new settlement site pointing at a house frame being built, a field and a forest edge behind',
    ),
    (
        'taj-yasin-maimoen',
        'Taj Yasin Maimoen',
        'a younger middle-aged man in a black peci cap and white shirt, standing at the gate of an Islamic boarding school beside two students, a mosque in the background',
    ),
    (
        'budi-santoso',
        'Budi Santoso',
        'a middle-aged man in a dark suit, inspecting goods at a market warehouse with two traders, stacked crates of cooking oil and sugar around him',
    ),
    (
        'maman-abdurrahman',
        'Maman Abdurrahman',
        'a middle-aged man in a batik shirt, standing at a small business stall inspecting handmade crafts held by a woman artisan, rolls of cloth on the shelves',
    ),
    (
        'donny-ermawan',
        'Donny Ermawan',
        'a middle-aged man in a defence-ministry dark uniform, seated at a table with a model of a warship and a briefing folder, a naval cadet standing beside him',
    ),
]


def slug(text, n=60):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:n]


def post(path, payload, timeout=1800):
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
        "steps": STEPS,
        "cfg_scale": 2,
        "width": WIDTH,
        "height": HEIGHT,
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
            },
        },
    }


def generate(figure_id, name, scene):
    print(f"[{figure_id}] {name}")
    payload = build_payload(scene)
    out = os.path.join(OUT_DIR, f"{figure_id}-{slug(name)}.png")
    t0 = time.time()
    result = post("/sdapi/v1/txt2img", payload)
    img_b64 = result["images"][0]
    with open(out, "wb") as f:
        f.write(base64.b64decode(img_b64))
    print(f"  saved {out} ({time.time() - t0:.1f}s)")
    return out


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    target = args[0] if args else None
    until = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--until=")), None)
    limit = next((int(a.split("=", 1)[1]) for a in sys.argv if a.startswith("--count=")), None)
    made = 0
    for figure_id, name, scene in FIGURES:
        if target and figure_id != target:
            continue
        if glob.glob(os.path.join(OUT_DIR, f"{figure_id}-*.*")) or glob.glob(
                os.path.join(OUT_DIR, f"{figure_id}.*")):
            print(f"[{figure_id}] already done, skipping")
            continue
        # a portrait takes ~4 min; do not start one that cannot finish by the deadline
        if until and time.strftime("%H:%M", time.localtime(time.time() + 300)) >= until:
            print(f"[{figure_id}] deadline {until} reached, stopping")
            break
        if limit is not None and made >= limit:
            break
        generate(figure_id, name, scene)
        made += 1
    print("ALL DONE")
