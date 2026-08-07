"""Batch: generate ukiyo-e event illustrations via A1111 WebUI's API, matching the
accepted reference's exact recipe (steps=8, cfg=2, DPM++ SDE Karras, ADetailer
face+hand+face passes) instead of the bare sd-cli.exe path that produced mangled
faces/hands.

Requires WebUI running with --api (see D:\\Tools\\stable-diffusion\\webui-user.bat).

Usage: python scripts/gen_event_images_webui.py [--smoke]
"""
import json, os, re, sys, time, base64, urllib.request

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
        "steps": 8,
        "cfg_scale": 2,
        "width": 1216,
        "height": 832,
        "sampler_name": "DPM++ SDE",
        "scheduler": "Karras",
        "seed": -1,
        "batch_size": 1,
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
        done = 0
        for eid, title, scene in EVENTS:
            if limit is not None and done >= limit:
                break
            out = os.path.join(OUT_DIR, f"{eid}-{slug(title)}.png")
            if os.path.exists(out):
                print(f"[{eid}] {title} -- already done, skipping")
                continue
            generate(eid, title, scene)
            done += 1
        print("ALL DONE")
