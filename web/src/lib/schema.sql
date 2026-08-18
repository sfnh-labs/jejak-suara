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

CREATE TABLE IF NOT EXISTS buzzer_signals (
    id                  SERIAL PRIMARY KEY,
    event_id            INTEGER NOT NULL UNIQUE REFERENCES events(id),
    anomaly_score       REAL,
    anomaly_pct         REAL,
    suspicious_ids_json TEXT,
    signals_triggered   TEXT,
    analyzed_at         TEXT NOT NULL
);
