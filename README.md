# Jejak Suara

A timeline-style information portal that builds **track records of public officials**
from news reporting — corroborated across multiple sources, summarized per event,
and annotated with public reaction.

The repo holds two halves: the Python **data pipeline** (`jejak/`) that collects and
summarizes, and the Next.js **web app** (`web/`) that publishes. Neon Postgres sits
between them.

## Pipeline

```
RSS ──▶ ingest ──▶ fetch ──▶ translate ──▶ cluster ──▶ summarize ──▶ timeline
        articles   bodies    to Indonesian  events     drafts        (published)
                                                          │
                                              sentiment + buzzer ───┘
```

| Stage | Module | What it does |
|-------|--------|--------------|
| 1. Ingest | `jejak/ingest.py` | Pull RSS, attribute articles to tracked figures, dedupe by URL hash. No AI. |
| 1b. YouTube | `jejak/youtube_ingest.py` | Search news videos, pull transcripts as additional articles. |
| 1.5 Fetch | `jejak/fetch.py` | Backfill full article text (trafilatura, stdlib fallback). Fail-soft, rate-limited. |
| 1.7 Translate | `jejak/translate.py` | Translate non-Indonesian sources to Indonesian; original kept in `body_original`. |
| 2. Cluster | `jejak/cluster.py` | Group articles about one activity into a single **event** (embedding similarity + a shared-content-word guard). |
| 3. Summarize | `jejak/summarize.py` | Neutral, attributed summary grounded in the event's articles, with `[Sumber N]` citation markers. |
| 4. Sentiment | `jejak/sentiment.py` | Public reaction per event: YouTube and Reddit comments classified by stance, aggregated. |
| 5. Buzzer | `jejak/buzzer.py` | Coordinated-engagement signals over the collected comments. |

All model work runs against a **local Ollama** (`qwen2.5:7b` by default) — there is no
hosted LLM in this project. Clustering uses `sentence-transformers`
(`paraphrase-multilingual-MiniLM-L12-v2`) locally.

## Design principles

These shape the schema, not just the copy:

1. **Report, never assert.** The system stores *what outlets reported*, attributed —
   never a claim in its own voice. This is deliberate given **UU ITE** (Indonesia's
   defamation exposure for named officials). The summarizer's system prompt enforces
   neutral, attributed language.
2. **Grounding over generation.** The summarizer only sees the event's own articles
   and is instructed to cite each bullet with `[Sumber N]`. A summary with no citation
   markers is a red flag worth reading before it goes out.
3. **Corroboration is first-class.** Each event records how many distinct outlets back
   it; single-source events carry a `⚠ satu sumber` badge everywhere they appear.
4. **Public reaction is not a verdict.** Sentiment is labelled as platform reaction
   with its sample size. It is brigadable and one-platform skewed. Never present it as
   fact or judgement.
5. **Right of reply.** A `corrections` table exists as the legal safety valve.

### Publishing policy

Summaries **publish automatically** — `summarize` writes the event straight to
`approved`. There is no human approval step in the current pipeline.

That is a deliberate tradeoff and it is the project's main standing risk: a 7B local
model's text about a named public official reaches the site without a person reading
it first. What mitigates it is the grounding prompt, the corroboration count, and the
single-source badge — not review. If you want the gate back, have
`summarize.summarize_event` write `summarized` instead of `approved`; `jejak/review.py`
and the Flask reviewer queue already expect exactly that state and need no other change.

## Setup

```bash
pip install -r requirements.txt
ollama serve &                      # summarize / translate / sentiment need this

python -m jejak.cli init            # create jejak.db
# edit figures.toml — add the officials to track (with aliases)
python -m jejak.cli run             # ingest + fetch + translate + cluster + summarize + sentiment + buzzer
```

Configuration is TOML: `sources.toml` (news feeds) and `figures.toml` (tracked people).
Environment variables live in `.env.example`.

### Where each stage runs

GitHub's runners have no Ollama, so the work is split:

| | Collection (ingest, fetch, cluster) | Model stages (translate, summarize, sentiment, buzzer) |
|---|---|---|
| **Where** | GitHub Actions, every 6h | Your workstation, on demand |
| **Workflow** | `.github/workflows/pipeline.yml` | manual |

To publish new events, run the model stages locally and push:

```bash
python scripts/sync_to_neon.py --pull      # get what CI has collected
python -m jejak.cli translate
python -m jejak.cli summarize
python -m jejak.cli sentiment
python -m jejak.cli buzzer
python scripts/sync_to_neon.py --push      # publish
```

## Storage and sync

SQLite (`jejak.db`) is the pipeline's working copy; **Neon Postgres is the durable
store** that the web app reads. `scripts/sync_to_neon.py` moves rows both ways and
preserves row identity in both directions:

```bash
python scripts/sync_to_neon.py           # pull, then push
python scripts/sync_to_neon.py --pull    # hydrate SQLite from Neon
python scripts/sync_to_neon.py --push    # publish SQLite to Neon
python scripts/sync_to_neon.py --reset   # TRUNCATE Neon, rebuild from SQLite
```

Pulling first matters: CI throws its working copy away each run, so without hydration
article dedupe and clustering would restart from an empty database every time.

`--reset` is destructive and exists to repair a Neon database corrupted by the older
sync, which omitted `events.id` and therefore appended a duplicate copy of every event
on each run.

The Postgres schema lives in `web/src/lib/schema.sql`.

## Web

`web/` is a Next.js 15 app reading Neon directly. Every data route is
`force-dynamic`, so pages always reflect the latest sync and the build never needs
database access.

```bash
cd web && npm install && npm run dev      # http://localhost:3000
```

| Route | Page |
|---|---|
| `/` | Beranda — figure bubbles with sentiment trend, plus the newest records |
| `/tokoh/[id]` | Figure page: Rekam Jejak timeline, `?tab=cv` for the CV panel |
| `/tokoh/[id]/[eventId]` | One record: summary, sources, public reaction, prev/next |
| `/linimasa` | Every record across all figures |
| `/tentang` | Background, principles, roadmap |

Needs `DATABASE_URL`. Set `CLOSED_LAUNCH=true` plus `BASIC_AUTH_CREDENTIALS="user:pass"`
to put the whole site behind HTTP Basic auth (`web/src/middleware.ts`).

#### Running locally without Neon

`web/scripts/local-db.mjs` starts a real Postgres (PGlite over the wire protocol)
with nothing to install, so you can develop against your own `jejak.db` data:

```bash
cd web && npm run local-db          # terminal 1 — serves on 127.0.0.1:5433

export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/postgres"
python ../scripts/sync_to_neon.py --push    # terminal 2 — load SQLite data
npm run build && npm start                   # serve the site
```

`src/lib/db.ts` picks the driver from the host: `pg` for localhost, Neon's HTTP
driver otherwise. The dev server accepts one client at a time, so use
`npm start` rather than `npm run dev` — Next's dev mode forks render workers and
they compete for the connection.

CV content is static reference material — add entries to `web/src/lib/cv.ts`, keyed by
the figure id from `figures.toml`. A figure without an entry simply shows no CV tab.

There is also a local Flask UI (`jejak/web.py`, `flask --app jejak.web run`) used as an
operator tool against SQLite. It has **no auth** — keep it on localhost.

### Deploying to Cloudflare

The app runs on **Cloudflare Workers** via the OpenNext adapter (`wrangler.jsonc`,
`open-next.config.ts`). Cloudflare Pages is in maintenance mode for new Next.js
projects, so Workers is the supported target.

```bash
cd web
npm run preview     # build + run the real Worker locally
npm run deploy      # build + publish
```

Set secrets on the Worker before the first deploy:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put BASIC_AUTH_CREDENTIALS   # only if CLOSED_LAUNCH=true
```

For local Worker runs, put the same values in `web/.dev.vars` (gitignored).

## Testing

```bash
pytest -q
```

`.github/workflows/check.yml` runs the Python tests plus `tsc --noEmit` and lint for
the web app on every push.

## Roadmap

- **Sentiment depth:** relevance pre-filter for off-topic comments, full distribution
  display, second platform blended in.
- **Attribution:** `ingest._attribute` is first-match substring matching, so a short
  alias can capture articles about a different person with the same name.
- **Buzzer:** the extremity signal currently flags minority opinion as much as
  coordination; it needs rework before it carries much weight.
