"""Generate a stylized figure portrait grounded in a real reference photo.

Same accepted recipe as gen_event_images_webui.py (steps=8, cfg=2, DPM++ SDE
Karras, ADetailer face+hand). Likeness comes from a locally-extracted init
image fed to img2img — not ControlNet: a full second SDXL ControlNet model
(e.g. xinsir_canny_sdxl) alongside the base checkpoint blew past this 8GB
card's VRAM and stepped at ~470s/it instead of ~1s/it.

v4/v5 history: pure B&W edge lines gave good likeness but zero color
(coloring-book result). Blurred+posterized color regions gave color back but
the Gaussian blur's soft gradients read as photographic shading, so the model
reconstructed a photoreal face instead of painting flat regions (v5).
Reference target (user-supplied kabuki actor ukiyo-e print) has ZERO gradient
anywhere — hard flat color fills with bold black outlines only. Fix: replace
blur+posterize with hard palette quantization (no blur at all) so the init
image itself already looks like flat cel-shaded regions, nothing for the
model to "sharpen" back into a photo.

Requires WebUI running with --api.

Usage: python scripts/gen_figure_portrait_webui.py
"""
import json, os, re, sys, time, base64, io, urllib.request
from PIL import Image, ImageFilter, ImageOps, ImageChops

API = "http://127.0.0.1:7860"
STYLE_SUFFIX = (
    "sumi ink bold black outlines, woodblock print, flat cel shading, hard flat color regions, "
    "no gradient, no soft shading, richly colored flat colors indigo blue madder red ochre, "
    "fully painted with no blank uncolored areas, exaggerated kabuki actor print expression, "
    "vivid saturated flat colors, decorative patterned background, washi paper texture"
)
NEGATIVE = (
    "photorealistic, 3d, modern, digital art, "
    "stiff pose, formal state portrait, medal, ribbon pin, flag backdrop, "
    "hyperrealistic skin, skin pores, skin texture, glossy skin, photo, realistic shading, "
    "gradient, soft shading, smooth shading, airbrushed, blur, depth of field, bokeh, "
    "coloring book, line art, uncolored, black and white, monochrome, blank white background"
)
OUT_DIR = r"D:\Projects\jejak-suara\web\public\images\tokoh"
REF_DIR = r"D:\Projects\jejak-suara\scripts\refs"
WIDTH, HEIGHT = 768, 1024
DENOISING_STRENGTH = 0.8
STEPS = 16

ADETAILER_UNIT = {
    "ad_confidence": 0.3,
    "ad_dilate_erode": 4,
    "ad_mask_blur": 4,
    "ad_denoising_strength": 0.3,
    "ad_inpaint_only_masked": True,
    "ad_inpaint_only_masked_padding": 32,
}

FIGURES = [
    (
        "prabowo-subianto",
        "Prabowo Subianto",
        r"D:\Projects\jejak-suara\scripts\refs\prabowo_ref.jpg",
        "Indonesian president mid-conversation, warm genuine smile, one hand raised in an "
        "open friendly gesture, wearing a batik shirt instead of a formal suit, standing in "
        "a palace garden with blossoming trees, relaxed candid moment",
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


def edge_sketch_b64(ref_path):
    """Hard flat color regions + edge lines, zero gradient anywhere.

    Quantizing to a small palette (no blur step) collapses the photo into
    solid flat shapes with hard boundaries — no soft gradient for the model
    to read as photographic shading, unlike the earlier Gaussian-blur
    approach. The overlaid edge lines carry the likeness/structure.
    """
    color = Image.open(ref_path).convert("RGB")
    color = ImageOps.fit(color, (WIDTH, HEIGHT), method=Image.LANCZOS)

    gray = color.convert("L")
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edges = ImageOps.invert(edges)
    edges = edges.point(lambda p: 255 if p > 210 else 0)

    flat_color = color.filter(ImageFilter.MedianFilter(9))
    flat_color = flat_color.quantize(colors=8, method=Image.MEDIANCUT).convert("RGB")

    canvas = ImageChops.multiply(flat_color, edges.convert("RGB"))
    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    out_path = os.path.join(REF_DIR, os.path.basename(ref_path).rsplit(".", 1)[0] + "_edges.png")
    canvas.save(out_path)
    return base64.b64encode(buf.getvalue()).decode(), out_path


def build_payload(scene, init_b64):
    return {
        "init_images": [init_b64],
        "denoising_strength": DENOISING_STRENGTH,
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
                ]
            },
        },
    }


def generate(figure_id, name, ref_path, scene):
    init_b64, sketch_path = edge_sketch_b64(ref_path)
    print(f"[{figure_id}] {name} (sketch: {sketch_path})")
    payload = build_payload(scene, init_b64)
    out = os.path.join(OUT_DIR, f"{figure_id}-{slug(name)}.png")
    t0 = time.time()
    result = post("/sdapi/v1/img2img", payload)
    img_b64 = result["images"][0]
    with open(out, "wb") as f:
        f.write(base64.b64decode(img_b64))
    print(f"  saved {out} ({time.time() - t0:.1f}s)")
    return out


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    target = sys.argv[1] if len(sys.argv) > 1 else None
    for figure_id, name, ref_path, scene in FIGURES:
        if target and figure_id != target:
            continue
        generate(figure_id, name, ref_path, scene)
    print("ALL DONE")
