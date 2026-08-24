-- Tracked public figures. Mirrored from figures.toml by scripts/sync_to_neon.py
-- so the web app does not have to hardcode names/roles.
CREATE TABLE IF NOT EXISTS figures (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    role     TEXT,
    aliases  TEXT,              -- JSON array
    active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- 'record' = one tracked figure's activity (figure_id set).
-- 'peristiwa' = an event belonging to no figure (figure_id NULL); any figures
-- appearing in its coverage are related, via event_figures.
CREATE TABLE IF NOT EXISTS events (
    id          SERIAL PRIMARY KEY,
    figure_id   TEXT,
    kind        TEXT NOT NULL DEFAULT 'record',
    title       TEXT,
    event_date  TEXT,
    -- Newest article in the cluster. event_date says when the event happened
    -- and never moves; coverage keeps arriving for days afterwards, so the
    -- feed sorts by this instead and an event still being written about stays
    -- near the top.
    last_seen   TEXT,
    event_type  TEXT DEFAULT 'other',
    scope       TEXT,
    impact      TEXT,
    status      TEXT NOT NULL DEFAULT 'new',
    -- Curator verdict, Postgres-only and deliberately absent from the pipeline.
    -- `status` is owned by the pipeline and overwritten wholesale by
    -- sync_to_neon's push, so a verdict stored there would be undone by the
    -- next crawl. This column is never in that script's column list, so push
    -- and pull both leave it untouched and the curator's decision survives.
    -- NULL = untouched, 'rejected' = pulled from the site, 'kept' = checked.
    curated     TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_figure ON events(figure_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
-- idx_events_curated is created by sync_to_neon's MIGRATIONS, after the ALTER
-- that adds `curated` to databases predating it — same reason as idx_events_kind.
-- idx_events_kind is created by sync_to_neon's MIGRATIONS, after the ALTER that
-- adds `kind` to databases predating it.

CREATE TABLE IF NOT EXISTS event_figures (
    event_id   INTEGER NOT NULL REFERENCES events(id),
    figure_id  TEXT NOT NULL,
    PRIMARY KEY (event_id, figure_id)
);
CREATE INDEX IF NOT EXISTS idx_event_figures_figure ON event_figures(figure_id);

CREATE TABLE IF NOT EXISTS articles (
    id           TEXT PRIMARY KEY,
    figure_id    TEXT,               -- NULL = general news, peristiwa material
    source       TEXT NOT NULL,
    url          TEXT NOT NULL,
    title        TEXT NOT NULL,
    summary      TEXT,
    body         TEXT,
    body_original TEXT,
    body_lang    TEXT DEFAULT 'id',
    fetch_status TEXT,
    published_at TEXT,
    fetched_at   TEXT NOT NULL,
    event_id     INTEGER REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_articles_figure ON articles(figure_id);
CREATE INDEX IF NOT EXISTS idx_articles_event  ON articles(event_id);

CREATE TABLE IF NOT EXISTS event_summaries (
    event_id            INTEGER PRIMARY KEY REFERENCES events(id),
    summary_text        TEXT NOT NULL,
    citations_json      TEXT NOT NULL,
    corroboration_count INTEGER NOT NULL,
    single_source_flag  INTEGER NOT NULL,
    model               TEXT NOT NULL,
    generated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sentiment (
    id           SERIAL PRIMARY KEY,
    event_id     INTEGER NOT NULL REFERENCES events(id),
    channel      TEXT NOT NULL,
    score        REAL,
    label        TEXT,
    sample_size  INTEGER,
    samples_json TEXT,
    collected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id           SERIAL PRIMARY KEY,
    event_id     INTEGER NOT NULL REFERENCES events(id),
    comment_id   TEXT,              -- platform's own id; stable across collections
    video_id     TEXT,
    channel      TEXT,              -- YouTube channel / subreddit it was posted under
    author_id    TEXT,
    author_name  TEXT,
    text         TEXT NOT NULL,
    like_count   INTEGER DEFAULT 0,
    published_at TEXT,
    stance       TEXT,
    collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_event  ON comments(event_id);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);

CREATE TABLE IF NOT EXISTS corrections (
    id           SERIAL PRIMARY KEY,
    event_id     INTEGER NOT NULL REFERENCES events(id),
    submitted_by TEXT,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    created_at   TEXT NOT NULL
);

-- Pipeline bookkeeping that survives the disposable SQLite working copy: the
-- archive backfill cursor lives here, so a rebuilt jejak.db resumes the walk
-- instead of restarting it.
CREATE TABLE IF NOT EXISTS pipeline_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buzzer_signals (
    id                  SERIAL PRIMARY KEY,
    event_id            INTEGER NOT NULL UNIQUE REFERENCES events(id),
    anomaly_score       REAL,
    anomaly_pct         REAL,
    suspicious_ids_json TEXT,
    signals_triggered   TEXT,
    analyzed_at         TEXT NOT NULL
);

-- The queue behind /kurasi/kandidat.
--
-- Discovery promotes a candidate named by enough distinct outlets, but it
-- refuses a one-word name outright: sentence case capitalises the first word
-- of every sentence, so "Dasar" and "Lalu" reach three outlets as readily as
-- "Dasco" does and no pattern separates them. Those land here with their
-- evidence for a person to rule on.
--
-- Evidence columns are overwritten by every sync from SQLite. The verdict
-- columns are not written by sync at all — same arrangement as events.curated:
-- Postgres is their only home, because the curator's decision has no SQLite
-- counterpart to be rebuilt from.
CREATE TABLE IF NOT EXISTS figure_candidates (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    outlets     INTEGER NOT NULL DEFAULT 0,
    mentions    INTEGER NOT NULL DEFAULT 0,
    role        TEXT,
    headlines   TEXT,          -- JSON array of {title, url, source}
    -- The events those articles clustered into: the record as the site words
    -- it, which is the thing a reviewer is really deciding to create.
    records     TEXT,          -- JSON array of {id, title, figure_id}
    synced_at   TEXT,
    verdict     TEXT,          -- 'promote' | 'reject' | NULL (undecided)
    full_name   TEXT,          -- display name the curator wants on the site
    aliases     TEXT,          -- pipe-separated extra spellings
    -- The office as the curator settled it. `role` above is what the coverage
    -- said most often, which is frequently a fragment ("Menko", "Kepala");
    -- this is what the site will print under the name.
    curated_role TEXT,
    decided_at  TEXT,
    applied_at  TEXT,          -- set once the pipeline has acted on the verdict
    -- What the curator saw that the evidence does not say: "this is a rank",
    -- "same person as X", "only ever quoted, never the actor". Free text,
    -- read by whoever tunes the extractor next.
    notes       TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_verdict ON figure_candidates(verdict);
CREATE INDEX IF NOT EXISTS idx_candidates_outlets ON figure_candidates(outlets DESC);
