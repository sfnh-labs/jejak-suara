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
import json, os, re, sys, time, base64, urllib.request

API = "http://127.0.0.1:7860"
STYLE_SUFFIX = (
    "sumi ink bold outlines, woodblock print, flat colors indigo blue madder red ochre, "
    "dramatic perspective, washi paper texture"
)
NEGATIVE = "photorealistic, 3d, modern, digital art, painting, crowd, many people, multiple people, background characters"
OUT_DIR = r"D:\Projects\jejak-suara\web\public\images\tokoh"
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
    (
        "prabowo-subianto",
        "Prabowo Subianto",
        "Indonesian president, a heavyset elder statesman with a very round plump face, "
        "double chin, and a stocky barrel-shaped body, close-cropped grey hair, standing "
        "at a wooden podium raising one hand while addressing an assembly, army officers "
        "seated behind him, a national emblem banner overhead",
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
    target = sys.argv[1] if len(sys.argv) > 1 else None
    for figure_id, name, scene in FIGURES:
        if target and figure_id != target:
            continue
        generate(figure_id, name, scene)
    print("ALL DONE")
