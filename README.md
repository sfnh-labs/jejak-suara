# Jejak Suara

A timeline-style information portal that builds **track records of public officials**
from news reporting — corroborated across multiple sources, summarized per event,
and annotated with public reaction.

The repo holds two halves: the Python **data pipeline** (`jejak/`) that collects and
summarizes, and the Next.js **web app** (`web/`) that publishes. Neon Postgres sits
between them.

## Pipeline

```
RSS ──────▶ ingest ──▶ fetch ──▶ translate ──▶ cluster ──▶ summarize ──▶ timeline
archives ─▶ backfill   bodies    to Indonesian  events     drafts        (published)
                                                              │
                                                  sentiment + buzzer ───┘
```

| Stage | Module | What it does |
|-------|--------|--------------|
| 1. Ingest | `jejak/ingest.py` | Pull RSS, attribute articles to tracked figures, dedupe by URL hash. No AI. |
| 1b. Backfill | `jejak/backfill.py` | Walk outlets' date-indexed archives backwards to recover history RSS never carried. |
| 1c. YouTube | `jejak/youtube_ingest.py` | Search news videos, pull transcripts as additional articles. |
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
it first. What mitigates it is the grounding prompt, the corroboration count, the
single-source badge, and `/kurasi` — a kill switch after the fact, not a gate before
it. See [Curation](#curation-kurasi).

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

### Filling in history

RSS carries about a day of headlines, so ingestion alone can only ever record
what happens from the moment it is switched on. `backfill` walks the outlets'
date-indexed archive pages backwards instead — Detik, Kompas and CNN Indonesia,
the three that both honour a date parameter and paginate a full day. Articles
land in the same table, with the same URL-hash dedupe and the same attribution
rule, so everything downstream treats a year-old article like this morning's.

```bash
python -m jejak.cli backfill --days 30                 # walk a month further back
python -m jejak.cli backfill --days 1 --until 2019-10-20
python -m jejak.cli backfill --days 1 --general        # also keep peristiwa material
```

A cursor in `pipeline_state` records how far back the walk has reached, so
each scheduled run continues from the last one; the default floor is
2024-10-20 and the stage goes quiet once it is reached. That table syncs to
Neon along with everything else, because `jejak.db` is disposable — a
file-based cursor would reset to today on every run and the walk would never
move.

A day costs roughly a minute (about 40 archive pages at one request per
second) and yields on the order of 500 headlines, of which the ones naming a
tracked figure are kept — 15 to 25 a day. `--general` keeps the rest as
peristiwa material, which is a far larger volume for the few that ever reach
the three-outlet corroboration gate — and with only three archive outlets,
that gate is exactly met, never exceeded.

**The crawl rate and `fetch --limit` move together.** An article whose body was
never fetched is summarized from its headline alone — backfilled rows carry no
RSS lead to fall back on — and `fetch` runs before `cluster` in the same cycle,
so anything left in the queue is summarized bodyless that same run and nothing
re-summarizes it when the body lands later. Budget the fetch limit at roughly
25 × `--days`, plus the RSS intake. The scheduled task runs `--days 6` against
`--limit 200`, which puts a cycle at about 25 minutes.

YouTube quota is not a constraint here: `sentiment_pending` takes 20 events a
run whatever the backlog, so the crawl rate does not change it.

Backfill is why clustering keeps summarized events open for matching: coverage
no longer arrives in date order, and an article landing on an event already
written up sends it back through `summarize` so the summary and its
corroboration count reflect the fuller source set.

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

There is also a local Flask UI (`jejak/web.py`, `flask --app jejak.web run`) used as a
read-only operator view over SQLite. It has **no auth** and renders unpublished rows —
keep it on localhost. It has no curation controls; those live at `/kurasi` below.

### Curation (`/kurasi`)

Curation is a **kill switch over an already-live feed**, not a gate a record has to
pass before it appears. Everything the pipeline produces is published from the moment
it clusters; `/kurasi` is where a human takes something back down.

The verdict lives in `events.curated` (`NULL` = untouched and live, `'rejected'` =
pulled, `'kept'` = checked and left up), and the site filters on it via the `LIVE`
predicate in `web/src/lib/data.ts`.

That column is **Postgres-only and absent from `scripts/sync_to_neon.py`'s column
list**, which is the whole point. `events.status` is owned by the pipeline and
overwritten wholesale by every push, so a verdict stored there would be undone by
the next crawl. Push and pull both skip `curated`, and `--reset` saves it across the
truncate and reapplies it afterwards.

Rejecting takes effect on the public site immediately — the pages are
`force-dynamic` and read Neon directly, so no sync step is involved.

**Adding the column to an existing Neon database must happen before deploying a web
build that reads it**, or every page query fails on the missing column:

```bash
python scripts/sync_to_neon.py --schema    # DDL only, touches no rows
```

Access control is Cloudflare Access (see below). Without it configured, `/kurasi`
returns 503 in production and is open in `next dev` — so local curation needs no
Cloudflare account, and a deploy that forgets the config fails closed rather than
publishing an unauthenticated write endpoint.

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
