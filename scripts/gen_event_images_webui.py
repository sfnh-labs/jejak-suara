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
    (668, "Australia jajaki kerja sama pariwisata pendidikan Kebumen",
     "Australian delegation visits regional government for tourism cooperation, a foreign "
     "diplomat and a local official shaking hands over a table with a coastal tourism map, "
     "distant hills and rice terraces through the window"),
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
