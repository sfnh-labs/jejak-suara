# Jejak Suara

A timeline-style information portal that builds **track records of public officials**
from news reporting — fact-checked across multiple sources, summarized per event,
and (later) annotated with public sentiment.

This repo is the **data pipeline** (built first, by design). The public timeline UI
comes after the pipeline produces trustworthy, reviewed events.

## Pipeline

```
RSS ──▶ ingest ──▶ fetch ──▶ cluster ──▶ summarize (grounded) ──▶ human review ──▶ timeline
        articles   bodies    events      drafts + citations        approve/reject   (published)
                                                                          │
                                                                sentiment (social) ─┘  [planned]
```

| Stage | Module | What it does |
|-------|--------|--------------|
| 1. Ingest | `jejak/ingest.py` | Pull RSS, attribute articles to tracked figures, dedupe. No AI. |
| 1.5 Fetch | `jejak/fetch.py` | Backfill full article text (trafilatura, stdlib fallback). Fail-soft, rate-limited. |
| 2. Cluster | `jejak/cluster.py` | Group many articles about one activity into a single **event**. |
| 3. Summarize | `jejak/summarize.py` | Claude **Opus 4.8** drafts a neutral summary, **grounded in the source articles via Citations** — every sentence ties to a source span. |
| 4. Review | `jejak/review.py` | Human approves/rejects before anything is publishable. |
| 5. Sentiment | `jejak/sentiment.py` | Public reaction per **approved** event: YouTube comments classified by **Haiku 4.5**, aggregated. Labelled "public reaction", never a verdict. |

## Why it's built this way (design principles)

These are not incidental — they shape the schema:

1. **Report, never assert.** The system stores *what outlets reported*, attributed,
   never a claim in its own voice. This is deliberate given **UU ITE** (Indonesia's
   defamation exposure for named officials). The summarizer's system prompt enforces
   neutral, attributed language.
2. **Grounding over generation.** The summarizer is handed the actual articles as
   Claude *document* blocks with citations enabled. Sentences without a citation are
   a review red flag — this is the guard against AI hallucinating facts into a
   public record of an official.
3. **Corroboration is first-class.** Each event records how many distinct outlets
   back it; single-source events are flagged (`⚠ SINGLE SOURCE`) in review.
4. **Human-in-the-loop.** `events.status` gates publishing: `new → summarized →
   approved`. Nothing auto-publishes.
5. **Right of reply.** A `corrections` table exists from day one as the legal safety
   valve.

## Setup

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...        # or: ant auth login

python -m jejak.cli init            # create jejak.db
# edit figures.toml — add the officials to track (with aliases)

python -m jejak.cli run             # ingest + cluster + summarize
python -m jejak.cli review          # see drafts awaiting approval
python -m jejak.cli approve 1
python -m jejak.cli timeline example-001
```

Configuration is TOML: `sources.toml` (news feeds) and `figures.toml` (tracked people).

### Web UI

```bash
flask --app jejak.web run        # http://127.0.0.1:5000
```

- `/` — figures, with approved + pending-review counts
- `/figure/<id>` — public timeline (approved events, citations, sentiment)
- `/review` — reviewer queue: read draft + flags, **approve/reject** (the
  human-in-the-loop gate)

Server-rendered Flask + Jinja (no JS build). DB path via `$JEJAK_DB` (default
`jejak.db`). **No auth** — localhost dev tool; put the reviewer routes behind
authentication before exposing anywhere.

## Model usage

- **Summarization:** `claude-opus-4-8` ($5 / $25 per 1M tok) — chosen for correctness on
  legally-sensitive output, not cost. Summaries are infrequent and high-stakes.
- **Sentiment classification:** `claude-haiku-4-5` ($1 / $5 per 1M tok) — high-volume
  per-comment classification, the cost-appropriate tier.

## Sentiment (public reaction)

`python -m jejak.cli sentiment` runs on **approved** events only (no quota spent on
rejected drafts). It searches YouTube for news videos about the event, pulls public
comments, classifies each comment's stance with Haiku, and stores an aggregate
score + label + sample size.

- Requires `YOUTUBE_API_KEY` (free 10k-units/day quota; one event ≈ ~100 units).
- Surfaced as **"public reaction (YouTube)"** with sample size — it is platform
  reaction, brigadable and skewed; **never** present it as a verdict or fact.
- Known limits: comment relevance is approximate; one-platform skew. A relevance
  pre-filter and multi-platform blending are future work.

## Roadmap

- **Sentiment depth:** add a relevance pre-filter (drop off-topic comments before
  scoring), show the full distribution, and optionally blend a second platform.
- **Better clustering:** swap `cluster._similar()` for embedding similarity.
- **Postgres:** the SQLite schema ports directly.
- **Timeline UI:** consumes `review.timeline()` (approved events only).

## Status

Pipeline stages 1–5 implemented (ingest, fetch, cluster, summarize, review,
sentiment) plus a Flask web UI (public timeline + reviewer queue). SQLite for
development.
