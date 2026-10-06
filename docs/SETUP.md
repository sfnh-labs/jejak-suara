# Setting up a new machine

How to move Jejak Suara development to a fresh Windows machine: the pipeline,
the scheduled task that runs it, the web app, and the imagery generator.

The paths below match the current machine (`D:\Projects\jejak-suara`,
`D:\Tools\...`). Keep them if you can: the imagery scripts and skill hard-code
them (see [Paths that are hard-coded](#paths-that-are-hard-coded)).

## 1. What git does not carry

Clone the repo, then copy these from the old machine by hand. None of them are
in git.

| Item | Where | Why it matters |
|---|---|---|
| `jejak.db` | repo root, ~210 MB | The pipeline's working copy. The scheduled run no longer pulls from Neon, so this file **is** the state. Copy it, don't rebuild it (see below). |
| `.env` | repo root | `DATABASE_URL` for Neon. Template: `.env.example`. |
| `YOUTUBE_API_KEY` | Windows **User** environment variable | Sentiment stage. 39 chars, starts `AIza`. Not in `.env` on the old machine. |
| `web/.dev.vars` | `web/` | Only if you run the Worker locally (`npm run preview`). |
| `.design/` | repo root | Claude Design exports. Gitignored on purpose. |
| Untracked images | `web/public/images/peristiwa/*.png` | Generated art not yet committed. Commit or copy them. |
| SD WebUI + models | `D:\Tools\stable-diffusion` | ~7 GB checkpoint + LoRA. See section 5. |

**Don't rebuild `jejak.db` from Neon unless you have to.** A full
`sync_to_neon.py --pull` transfers the whole database. Neon's free tier allows
5 GB of transfer a month, and full pulls are what used it up before. Copy the
file across instead.

## 2. Pipeline

1. Install **Python 3.12+** from python.org (the current machine runs 3.14).
   Make sure the `python` on `PATH` is the one pip installs into. The Windows
   Store `python.exe` shim is not, and that mismatch is what made console scripts
   "installed but not found" last time (`memory/env-setup.md`).
2. Install the dependencies:
   ```powershell
   cd D:\Projects\jejak-suara
   pip install -r requirements.txt
   ```
   The embedding model (`paraphrase-multilingual-MiniLM-L12-v2`) downloads from
   Hugging Face on the first `cluster` run.
3. Install **Ollama** with the default installer. `publish_local.ps1` expects it
   at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` and starts it if it isn't
   running. Then pull the model:
   ```powershell
   ollama pull qwen2.5:7b
   ```
   `llama3.1:8b` is also on the old machine, but nothing uses it by default.
   Override the model with `OLLAMA_MODEL` and the server with `OLLAMA_BASE_URL`.
4. Put `.env` and `jejak.db` in the repo root. Set the YouTube key:
   ```powershell
   [Environment]::SetEnvironmentVariable("YOUTUBE_API_KEY", "AIza...", "User")
   ```
   Alternatively, add `YOUTUBE_API_KEY=...` to `.env`; `publish_local.ps1` loads
   every line of it. Optional: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and
   `REDDIT_USER_AGENT` for Reddit comments.
5. Check that it works:
   ```powershell
   $env:PYTHONIOENCODING = "utf-8"
   pytest -q                          # 106 tests
   python scripts\check_database_url.py
   ```

## 3. Scheduler

The whole pipeline runs from one Windows Scheduled Task,
`JejakSuara-PublishLocal`. It runs daily at **05:00, 11:00 and 18:00** and calls
`scripts\publish_local.ps1`. Each run goes through
ingest → backfill (6 days) → fetch (200) → mentions → cluster → quotes →
translate → summarize → sentiment → buzzer, then pushes changed rows to Neon.

### Register it

From a normal (non-admin) PowerShell, logged in as the user who owns the repo:

```powershell
powershell -File scripts\register_publish_task.ps1
```

The script is idempotent: `-Force` replaces an existing task. It prints the next
run time. Before trusting the schedule, run one cycle by hand:

```powershell
powershell -File scripts\publish_local.ps1
```

A cycle takes about 25 minutes. Watch `scripts\publish_local.log`.

### How the task behaves

- **Missed runs:** `-StartWhenAvailable` runs a missed cycle once the machine is
  back on. A powered-off night delays collection; it doesn't skip it.
- **Overlap:** `-MultipleInstances IgnoreNew` drops a trigger while a run is
  still going. The script also holds `scripts\.publish_local.lock`; a lock older
  than 4 hours counts as left over from a crash and is ignored.
- **Time limit:** 3 hours, then Task Scheduler kills the run.
- **Logged-on only:** the task is registered without a principal, so it runs
  only while you're logged in, with your user environment. That's how it picks
  up `YOUTUBE_API_KEY` and your `PATH`. To run while logged out, re-register it
  with `-User` / `-Password` or `-Principal`, and put every key in `.env`,
  because a logged-out run doesn't load your user environment.
- **Failures don't stop the run.** Each stage commits its own work and the run
  moves on to the next stage. The final push always runs.

### Turn it off on the old machine

Two machines pushing to the same Neon database would fight over row identity.
Once the new machine works, disable the task on the old one:

```powershell
Unregister-ScheduledTask -TaskName JejakSuara-PublishLocal -Confirm:$false
```

### Check it

```powershell
Get-ScheduledTask JejakSuara-PublishLocal | Get-ScheduledTaskInfo   # LastRunTime, LastTaskResult, NextRunTime
Get-Content scripts\publish_local.log -Tail 40 -Encoding utf8
```

Read the log with PowerShell. It contains non-UTF-8 bytes that make Git Bash
tools choke.

### Tune the collection rate

`--days` (backfill) and `--limit` (fetch) move together. Budget the fetch limit
at roughly 25 × `--days`, plus the RSS intake; otherwise articles get summarized
from headlines alone (see README, *Filling in history*). With 3 runs a day at
`--days 6`, backfill covers about 18 days of history per day.

## 4. Web app

```powershell
cd web
npm install             # Node 24 on the current machine
npm run dev             # http://localhost:3000, needs DATABASE_URL
```

To work without touching Neon, start the local PGlite server and push
`jejak.db` into it. The README, under *Running locally without Neon*, has the
steps. Deploys go through Cloudflare Workers (`npm run deploy`). The secrets
live in Cloudflare, not on the machine, so nothing needs copying for those.
Log in again with `npx wrangler login`.

## 5. Imagery generator (ukiyo-e)

Event (peristiwa) and figure (tokoh) art comes from a local Automatic1111
Stable Diffusion WebUI, driven over its HTTP API. The scripts are not on `main`
yet. They live on branch **`docs/ukiyo-e-imagery-skill`**:

- `scripts/gen_event_images_webui.py`: events, 1216×832, written to `web/public/images/peristiwa/`
- `scripts/gen_figure_portrait_webui.py`: figures, 768×1024, written to `web/public/images/tokoh/`
- `.claude/skills/ukiyo-e-imagery/SKILL.md`: the full operating guide for Claude Code. It's a project skill, so it loads automatically on any machine where this branch is checked out.

### Hardware

An NVIDIA GPU with **8 GB of VRAM** is the floor. The old machine has an RTX
5050 8 GB and uses about 7.2 GB per render. Each image takes 2.5–10 minutes.
Render one image at a time.

### Install the WebUI

1. Install **Python 3.10** at `D:\Tools\python310`. The WebUI does not run on
   3.12+, and it's a separate install from the pipeline's Python.
2. Clone the WebUI:
   ```powershell
   git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui D:\Tools\stable-diffusion
   ```
3. Edit `D:\Tools\stable-diffusion\webui-user.bat` to match the old machine:
   ```bat
   set PYTHON=D:\Tools\python310\python.exe
   set PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.8,max_split_size_mb:512
   set COMMANDLINE_ARGS=--medvram --skip-torch-cuda-test --api --opt-sdp-no-mem-attention
   ```
   `--api` is required, because the scripts talk to `http://127.0.0.1:7860`.
   `--medvram` is what makes SDXL fit in 8 GB.
4. Install the **ADetailer** extension into `extensions\adetailer`:
   ```powershell
   git clone https://github.com/Bing-su/adetailer D:\Tools\stable-diffusion\extensions\adetailer
   ```
   Its `face_yolov8n.pt` and `hand_yolov8n.pt` models download on first use.
   ControlNet and AnimateDiff are installed on the old machine but unused. Skip
   them; identity conditioning is ruled out (see below).
5. Copy the models from the old machine, or download them again:

   | File | Folder | Used |
   |---|---|---|
   | `DreamShaperXL_Turbo_v2_1.safetensors` (6.6 GB) | `models\Stable-diffusion\` | **Yes**, the only checkpoint the recipe uses |
   | `Ukiyo-e Art.safetensors` (218 MB) | `models\Lora\` | Present, but the prompts don't load it (no `<lora:...>` tag). Copy it anyway to keep the setup identical. |

   The other checkpoints and LoRAs on the old machine (pixel art, Illustrious,
   SD 1.5, and so on) belong to other projects.
6. Start the WebUI by its **full path**. A bare `webui.bat` after `cd` fails:
   ```powershell
   Start-Process -FilePath "D:\Tools\stable-diffusion\webui.bat" `
     -WorkingDirectory "D:\Tools\stable-diffusion" -WindowStyle Hidden
   ```
   The first boot installs torch and takes a long time. Later boots take a few
   minutes and often seem to stall at the `ControlNet v1.1.455` line; that's
   normal.
7. Smoke test, which renders event 728 once:
   ```powershell
   git checkout docs/ukiyo-e-imagery-skill
   D:\Tools\python310\python.exe scripts\gen_event_images_webui.py --smoke
   ```

### Generation spec

Both scripts already encode these settings. They were tuned as a set, so
changing any one of them breaks the match with the accepted images.

| Setting | Value |
|---|---|
| Checkpoint | `DreamShaperXL_Turbo_v2_1.safetensors` (SDXL Turbo) |
| Steps / CFG | 8 / 2 |
| Sampler / scheduler | `DPM++ SDE` / `Karras` |
| Size | events 1216×832, figures 768×1024 |
| ADetailer | 3 passes: face → hand → face (`*_yolov8n.pt`), confidence 0.3, denoise 0.4, inpaint only masked, padding 32 |
| Prompt | `"Ukiyo-e Art, " + scene + ", sumi ink bold outlines, woodblock print, flat colors indigo blue madder red ochre, dramatic perspective, washi paper texture"` |
| Negative | `photorealistic, 3d, modern, digital art, painting, crowd, many people, multiple people, background characters` |

**Writing a scene:**

- Describe people by **role, build and action**, never by itemized facial
  features. For example: "Indonesian president, a heavyset elder statesman with
  a very round plump face … standing at a wooden podium raising one hand".
  Listing features such as "bald head, thick mustache" turns into caricature.
- **2–4 figures** at most. Crowds come out mangled at 8 steps.
- **No reference photos.** That rules out img2img, ControlNet and IP-Adapter.
  At CFG 2, any photo conditioning drags the result toward photorealism. All of
  these were tested and all failed. Build and role resemblance is the accepted
  standard.

**Adding images:** append `(event_id, title, scene)` to `EVENTS` (or
`(figure_id, name, scene)` to `FIGURES`) and run the script.
`--count=N` caps how many it generates in one run. Images already on disk, as
`.png` or `.webp`, are skipped.

**Running batches:** launch the script detached, with `Start-Process` and log
redirection, not from a shell that might die. The WebUI does not save API
images itself, so a killed client loses the finished render. SKILL.md has the
exact commands and the remaining gotchas, such as the figure script's 1800 s
timeout.

### Paths that are hard-coded

If the new machine uses different drives, update these:

- `OUT_DIR` in both `gen_*_webui.py` scripts (`D:\Projects\jejak-suara\web\public\images\...`)
- WebUI and Python 3.10 paths in `.claude/skills/ukiyo-e-imagery/SKILL.md`
- `PYTHON=` in `webui-user.bat`

## 6. Claude Code context

- Project memory checked into the repo (`memory/*.md`) comes along with the clone.
- Per-user memory under `~\.claude-personal\projects\D--Projects-jejak-suara\memory\`
  does not. It holds the imagery-style and entity-model notes. Copy that folder
  if you want them on the new machine. The folder name encodes the repo path, so
  it only matches if the repo sits at the same path.
- `.claude/settings.local.json` is gitignored. Start from
  `.claude/settings.local.json.example`.
