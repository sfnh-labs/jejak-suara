"""One-off batch: generate ukiyo-e style illustrations for a handful of peristiwa,
for review before wiring imagery into the app for real.

Calls the same sd.cmd wrapper as D:\\Projects\\stable-diffusion\\gen.py, but controls
the output filename directly (event id + title slug) instead of relying on gen.py's
comma-parsed slug, and adds the Ukiyo-e Art LoRA.

Usage: python scripts/gen_event_images.py
"""
import subprocess, os, re, datetime

SD_CMD = r"D:\Projects\stable-diffusion\sd.cmd"
LORA_DIR = r"D:\Tools\stable-diffusion\models\Lora"
LORA_TAG = "<lora:Ukiyo-e Art:0.8>"
NEGATIVE = "photorealistic, 3d, modern, digital art, painting"
STYLE_SUFFIX = (
    "sumi ink bold outlines, woodblock print, flat colors indigo blue madder red ochre, "
    "dramatic perspective, washi paper texture"
)
OUT_DIR = r"D:\Projects\jejak-suara\web\public\images\peristiwa"

# (event_id, title, scene) — scene is the descriptive part of the prompt only;
# style prefix/suffix and LoRA tag are added automatically.
EVENTS = [
    (762, "KPK ajak publik pantau sidang Yaqut",
     "KPK court trial hearing, a formal Indonesian courtroom with a wooden judges bench, "
     "three judges in black robes seated behind a raised platform, a defendant standing at "
     "a podium, a public gallery of citizens watching intently, a red KPK emblem banner on the wall"),
    (761, "Rektor USU kebijakan strategis lima pilar",
     "university rector policy address, a rector in academic robes standing at a wooden lectern "
     "before a large scroll displaying five pillar diagrams, an audience of professors seated in "
     "rows inside a grand university hall, tall arched windows"),
    (760, "Kunjungan Jokowi perkuat PSI",
     "former president visits political party headquarters, a distinguished elder statesman "
     "greeted by young party cadres waving small flags, a large survey chart scroll hanging on "
     "the wall behind them, festive bunting"),
    (758, "Waketum MUI Marsudi Syuhud calon Ketum PBNU",
     "Islamic organization leadership candidacy announcement, a religious leader in white peci "
     "and sarong standing at a podium raising one hand, an assembly hall filled with turbaned "
     "delegates seated on woven mats, a large calligraphy banner overhead"),
    (728, "Pimpinan MPR temui Prabowo di Istana",
     "parliamentary leaders meet the president at the palace, a president in a formal batik "
     "jacket seated at the head of an ornate table, several parliament leaders in dark suits "
     "bowing slightly in greeting, tall palace pillars and a national emblem on the wall"),
    (719, "DPR safari ke partai nonparlemen bahas RUU Pemilu",
     "parliament delegation visits minor party office, a group of legislators in suits seated "
     "across a low table from party representatives, stacks of draft election law documents "
     "between them, small party flags on the wall"),
    (707, "Menhan: latihan bersama pasukan khusus RI-Thailand",
     "defense minister announces joint special forces training, a minister in military uniform "
     "gesturing toward a map of joint exercise routes, two rows of special forces soldiers from "
     "two nations standing at attention behind him, national flags crossed overhead"),
    (689, "Koalisi Buruh batal demo, cemas ada penyusup",
     "labor coalition cancels planned protest, worker leaders in headbands and vests gathered "
     "around a table looking wary, protest banners rolled up and set aside in the corner, a "
     "watchful figure lurking in shadow near the doorway"),
    (677, "Kejagung geledah 4 perusahaan Don Ritto",
     "prosecutors raid company office for a money laundering probe, investigators in dark "
     "jackets carrying document boxes out of a corporate office, a startled clerk at a desk "
     "covered in ledgers, a company signboard askew above the door"),
    (668, "Australia jajaki kerja sama pariwisata pendidikan Kebumen",
     "Australian delegation visits regional government for tourism cooperation, foreign "
     "diplomats and local officials shaking hands over a table with a coastal tourism map, a "
     "small Australian flag beside a regional emblem, distant hills and rice terraces through the window"),
]


def slug(text, n=60):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:n]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for event_id, title, scene in EVENTS:
        prompt = f"Ukiyo-e Art, {scene}, {STYLE_SUFFIX} {LORA_TAG}"
        out = os.path.join(OUT_DIR, f"{event_id}-{slug(title)}.png")
        cmd = [
            "cmd", "/c", SD_CMD,
            "-p", prompt, "-n", NEGATIVE,
            "-W", "1216", "-H", "832",
            "--lora-model-dir", LORA_DIR,
            "-o", out,
        ]
        print(f"[{event_id}] {title}")
        t0 = datetime.datetime.now()
        r = subprocess.run(cmd)
        dt = (datetime.datetime.now() - t0).total_seconds()
        if r.returncode != 0 or not os.path.exists(out):
            print(f"  FAILED (exit {r.returncode}, {dt:.1f}s)")
            continue
        print(f"  saved {out} ({dt:.1f}s)")


if __name__ == "__main__":
    main()
