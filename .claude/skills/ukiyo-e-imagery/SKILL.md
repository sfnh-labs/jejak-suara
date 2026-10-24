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
The output directory is relative to the script, so a run from a worktree
writes into that worktree. See "One batch, start to finish" below.

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

Start it with **`webui-launch-fixed.bat`**. It sets `--medvram --api ...` and
calls `webui.bat` by full path. Launching `webui.bat` directly skips the flags
(the log says `Launching Web UI with arguments:` with nothing after it), the
server comes up with no `/sdapi/v1/txt2img` route, and generation 404s.
`webui-user.bat` also fails: its bare `call webui.bat` is "not recognized".
Redirect output to a log so a stall can be diagnosed:

```powershell
Start-Process -FilePath "cmd.exe" -ArgumentList "/c","D:\Tools\stable-diffusion\webui-launch-fixed.bat" `
  -WorkingDirectory "D:\Tools\stable-diffusion" -WindowStyle Hidden `
  -RedirectStandardOutput "<scratchpad>\webui.log" -RedirectStandardError "<scratchpad>\webui.err.log"
```

Boot takes several minutes and routinely appears to stall around the
`ControlNet v1.1.455` log line. It is not hung. Wait for the API:

```bash
# plain `curl -s` succeeds on a 404 too; wait for the route itself (405 on GET)
until [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:7860/sdapi/v1/txt2img)" = 405 ]; do sleep 10; done
```

**Launch generation detached, never via a backgrounded Bash task.** Harness
restarts kill Bash background tasks mid-render, and the WebUI does *not*
auto-save API images — a killed client loses the finished image server-side
with no recoverable copy. Detached `Start-Process` plus a log file survives:

```powershell
Start-Process -FilePath "D:\Tools\python310\python.exe" `
  -ArgumentList "scripts/gen_event_images_webui.py --count=1" `
  -WorkingDirectory "D:\Projects\jejak-suara\.claude\worktrees\img-<slug>" `
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

## How the site finds the images

There is no `image` column. The site reads two static manifests, because
Cloudflare Workers has no `fs` at request time:

- `web/src/lib/peristiwa-images.ts`: `PERISTIWA_IMAGES`, event id to
  `<id>-<slug>.webp`.
- `web/src/lib/tokoh-images.ts`: `TOKOH_IMAGES`, figure slug to
  `{ portrait: "<slug>.webp", avatar: "<slug>-avatar.webp" }`.

A file on disk that is not in its manifest never shows.

## One batch, start to finish

The Windows machine only generates images. Its `jejak.db` is a stale copy:
never run pipeline stages or `sync_to_neon.py` here, and never take event ids
from it.

1. **Branch.** From the main checkout:
   `scripts/worktree.sh new img/<slug> --web` (`--web` installs sharp, needed
   in step 5), then EnterWorktree into `.claude/worktrees/img-<slug>`. Run every
   later step there. The scheduler runs on the Mac, so nothing else touches
   this checkout.
2. **Pick events from Neon**, the live source. Event ids are Neon ids. A small
   read-only query costs almost no transfer; never pull whole tables (free tier
   is 5 GB a month). `DATABASE_URL` comes from `.env`:
   ```sql
   SELECT id, title FROM events
   WHERE status IN ('new', 'summarized', 'approved')
   ORDER BY id DESC LIMIT 30;
   ```
   Drop ids already in `PERISTIWA_IMAGES`.
3. **Write scenes.** Append `(event_id, title, scene)` to `EVENTS` (figures:
   `FIGURES`), following the prompt rules above.
4. **Generate**, one detached run at a time (see "Running it").
5. **Convert.** Move each new PNG to `originals/` at the repo root
   (gitignored, keeps the full-size file) and write a `.webp` beside where it
   was. Run from `web/` so `sharp` resolves:
   ```bash
   cd web && node -e "
   const sharp = require('sharp'), fs = require('fs'), path = require('path');
   for (const f of process.argv.slice(1)) {
     const dst = path.join('..', 'originals', path.basename(f));
     fs.mkdirSync(path.dirname(dst), { recursive: true });
     fs.renameSync(f, dst);
     sharp(dst).webp().toFile(f.replace(/\.png$/, '.webp'));
   }" public/images/peristiwa/<id>-*.png
   ```
   Figures: rename to `<slug>.webp` and cut the avatar, a square face crop of
   the same image, with `sharp(src).extract({ left, top, width, height })`.
   The face sits in a different place in each render, so pick the box by eye.
   Avatars run about 6–12 KB.
6. **Register.** Add each file to its manifest. Check the result in the dev
   server before committing.
7. **Ship.** Commit the `.webp` files, the manifest and the `EVENTS` changes.
   Run `pytest -q` and `cd web && npx tsc --noEmit && npm run lint`. Then
   `gh pr create --fill`, `gh pr checks --watch`, `gh pr merge --merge`, and
   from the main checkout `scripts/worktree.sh finish img/<slug>`.
8. **After merge.** The Mac's main checkout picks up the images on its next
   pull. Production needs a manual `npm run deploy` from `web/`; there is no
   auto-deploy.
