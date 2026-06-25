CREATE TABLE IF NOT EXISTS events (
    id          SERIAL PRIMARY KEY,
    figure_id   TEXT NOT NULL,
    title       TEXT,
    event_date  TEXT,
    event_type  TEXT DEFAULT 'other',
    status      TEXT NOT NULL DEFAULT 'new',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_figure ON events(figure_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS articles (
    id           TEXT PRIMARY KEY,
    figure_id    TEXT NOT NULL,
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
