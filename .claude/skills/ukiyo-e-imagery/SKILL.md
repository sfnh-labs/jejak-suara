---
name: ukiyo-e-imagery
description: Generate ukiyo-e woodblock illustrations for jejak-suara peristiwa (events) and tokoh (figures) using the local A1111 Stable Diffusion WebUI API. Use when asked to create, regenerate, or batch event/figure artwork, or when the WebUI generation pipeline needs to be started, resumed, or debugged.
---

# Ukiyo-e imagery pipeline

Generates the site's event and figure artwork through a local Automatic1111
WebUI API on an 8GB RTX 5050. One image at a time — the GPU saturates and the
machine cannot take parallel jobs.

## Scripts

| Script | Output | Size |
|---|---|---|
| `scripts/gen_event_images_webui.py` | `web/public/images/peristiwa/` | 1216x832 |
| `scripts/gen_figure_portrait_webui.py` | `web/public/images/tokoh/` | 768x1024 |

Event script takes `--count=N` (generate at most N, skipping ones already on
disk) or `--smoke` (single test render of event 728). Figure script takes an
optional figure id argument.

To add work, append a tuple to the `EVENTS` / `FIGURES` list in the relevant
script. Both scripts skip anything already present in the output directory.

## The recipe — do not change these

Both scripts already encode it. Checkpoint `DreamShaperXL_Turbo_v2_1.safetensors`
(SDXL Turbo), `steps=8`, `cfg_scale=2`, sampler `DPM++ SDE`, scheduler `Karras`,
ADetailer three-pass (face, hand, face). Prompt is `"Ukiyo-e Art, "` + scene +
`STYLE_SUFFIX`. These values are tuned together; changing one breaks the style
match against the accepted reference images.

## Prompt-writing rules (hard-won, do not relearn)

**Never wire in identity conditioning.** No reference photo, no img2img, no
ControlNet, no IP-Adapter. At `cfg_scale=2` any nonzero photo conditioning
overpowers the style prompt and drags output to photorealism. Tested
exhaustively — img2img v1–v6, IP-Adapter at weight 0.75/0.35/0.2/0.1, cfg up
to 6. All failed identically. Real people are rendered by *build resemblance
only*, which the user has explicitly accepted as sufficient.

**Never itemize facial features.** "bald head, thick grey mustache" produces
cartoon caricature even with those terms in the negative prompt — cfg=2 gives
the negative prompt too little pull. Write role + build + action/setting
instead:

> "Indonesian president, a heavyset elder statesman with a very round plump
> face, double chin, and a stocky barrel-shaped body, close-cropped grey hair,
> standing at a wooden podium raising one hand while addressing an assembly"

**Keep scenes to 2–4 figures.** Crowds mangle at 8 steps. The negative prompt
already fights `crowd, many people, multiple people, background characters`.

## Running it

WebUI lives at `D:\Tools\stable-diffusion`, must be launched with `--api
--medvram`, serves on port 7860.

Start it — invoke `webui.bat` by **full absolute path**, a bare `webui.bat`
after `cd` fails with "not recognized as an internal or external command":

```powershell
Start-Process -FilePath "D:\Tools\stable-diffusion\webui.bat" `
  -WorkingDirectory "D:\Tools\stable-diffusion" -WindowStyle Hidden
```

Boot takes several minutes and routinely appears to stall around the
`ControlNet v1.1.455` log line. It is not hung. Wait for the API:

```bash
until curl -s -m 3 http://127.0.0.1:7860/sdapi/v1/progress >/dev/null 2>&1; do sleep 10; done
```

**Launch generation detached, never via a backgrounded Bash task.** Harness
restarts kill Bash background tasks mid-render, and the WebUI does *not*
auto-save API images — a killed client loses the finished image server-side
with no recoverable copy. Detached `Start-Process` plus a log file survives:

```powershell
Start-Process -FilePath "D:\Tools\python310\python.exe" `
  -ArgumentList "scripts/gen_event_images_webui.py --count=1" `
  -WorkingDirectory "D:\Projects\jejak-suara" `
  -RedirectStandardOutput "<scratchpad>\gen_slot.log" `
  -RedirectStandardError  "<scratchpad>\gen_slot.err.log" `
  -WindowStyle Hidden
```

Then poll the log with Monitor, generous timeout (900000ms+):

```bash
until grep -q "saved\|Traceback\|Error" <log>; do sleep 15; done; cat <log>
```

## Gotchas

- **Do not `curl /sdapi/v1/progress` raw.** The response embeds a
  `current_image` base64 blob — it dumped 1.7MB into tool output once. Filter
  the key out, or read the log file instead.
- **Timings vary wildly**: 155s to 600s per image, same settings. Not a hang.
  Confirm with `nvidia-smi` (expect ~100% util, ~7.2/8.1GB VRAM) before
  assuming something broke.
- **Client timeout**: event script uses `post(..., timeout=3600)`. The figure
  script is still at `1800` and has timed out mid-render before — bump it if a
  portrait fails with `TimeoutError: timed out`.
- **Dedup matches any extension** (`glob` on `{id}-*.*`). Accepted images are a
  mix of `.png` and `.webp`; a `.png`-only check silently regenerates work
  that already exists.

## Scheduling overnight batches

Cron jobs are session-only and in-memory. They die when the Claude session
exits — the session must stay open for the whole window. One image per slot,
spaced generously; a 1AM–3AM window fit roughly 6 attempts including retries,
at ~30K tokens total for scheduling and monitoring.

## Not yet decided

The `events` / figures schema has no `image` column. Nothing wires these files
into the app yet. Do not invent that wiring without asking.
