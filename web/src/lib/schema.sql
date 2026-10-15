-- Tracked public figures. Mirrored from figures.toml by scripts/sync_to_neon.py
-- so the web app does not have to hardcode names/roles.
CREATE TABLE IF NOT EXISTS figures (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    role     TEXT,
    aliases  TEXT,              -- JSON array
    active   BOOLEAN NOT NULL DEFAULT TRUE,
    -- The CV, one entity with the figure: `positions` ({role, org, period})
    -- is the career list and its first entry is `role` ("Ketua" + "MPR RI").
    -- Pushed from SQLite (seeded from cv/<id>.json); edited in /kurasi.
    positions TEXT,
    bio       TEXT,
    facts     TEXT,              -- JSON [{label, value}]
    education TEXT,              -- JSON [{year?, detail}]
    sources   TEXT,              -- JSON [{label, url}]
    cv_checked_at TEXT
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
    -- The figure's own words, verbatim from quote_url (jejak/quotes.py).
    quote       TEXT,
    quote_url   TEXT,
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

-- Records proposed as part of a peristiwa, by jejak/link.py. Pipeline-owned and
-- pushed like any other table; the curator's ruling lives apart from it, in
-- record_link_verdicts, so a --reset that truncates this table cannot take a
-- decision with it.
CREATE TABLE IF NOT EXISTS record_links (
    record_id    INTEGER NOT NULL,
    peristiwa_id INTEGER NOT NULL,
    score        REAL,
    evidence     TEXT,          -- JSON array of the rare words both share
    created_at   TEXT NOT NULL,
    PRIMARY KEY (record_id, peristiwa_id)
);
CREATE INDEX IF NOT EXISTS idx_record_links_peristiwa ON record_links(peristiwa_id);

-- Curator-owned tables below. Postgres is their only home — no sync writes
-- them — and scripts/apply_curation.py copies each decision into the pipeline,
-- stamping applied_at so it is carried out once.

-- 'confirmed' links are shown on the public site; 'rejected' ones are never
-- proposed again. A confirmed row with no record_links counterpart is a link
-- the curator added by hand. NULL is a withdrawn ruling still to be undone in
-- the pipeline; apply_curation.py deletes the row once it has.
CREATE TABLE IF NOT EXISTS record_link_verdicts (
    record_id    INTEGER NOT NULL,
    peristiwa_id INTEGER NOT NULL,
    verdict      TEXT,           -- 'confirmed' | 'rejected' | NULL (withdrawn)
    decided_at   TEXT NOT NULL,
    applied_at   TEXT,
    PRIMARY KEY (record_id, peristiwa_id)
);

-- A curator's correction to a tracked figure's name, office or aliases. Shown
-- on the site at once (sync_figures lays a pending edit over what it pushes),
-- and applied to the pipeline's roster so attribution matches on the aliases.
CREATE TABLE IF NOT EXISTS figure_edits (
    figure_id  TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT,
    aliases    TEXT NOT NULL,    -- JSON array
    positions  TEXT,             -- JSON array of {role, org, period}
    -- The rest of the CV. NULL leaves a field as it was.
    bio        TEXT,
    facts      TEXT,
    education  TEXT,
    sources    TEXT,
    -- FALSE retires the figure: discovery mis-mined it ("Ahmad Muzani Tutup")
    -- or it duplicates someone tracked. It leaves the figure list and the
    -- pipeline stops attributing new coverage to it; records it already owns
    -- stay up until each is taken down.
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    edited_at  TEXT NOT NULL,
    applied_at TEXT
);

-- A curator's "these two are the same person". The web app moves the
-- duplicate's records to the target in Postgres at once; apply_curation.py
-- does the same in SQLite (jejak.roster.merge_figure), and until it has, every
-- push lays the merge back over the rows it sends. Postgres-only.
CREATE TABLE IF NOT EXISTS figure_merges (
    from_id    TEXT PRIMARY KEY,  -- the duplicate, retired by the merge
    into_id    TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    applied_at TEXT
);

-- A related figure struck from a peristiwa: the alias matched someone else.
-- struck = FALSE is a restore still to be carried into the pipeline; the row
-- is deleted once it has been.
CREATE TABLE IF NOT EXISTS event_figure_rejections (
    event_id   INTEGER NOT NULL,
    figure_id  TEXT NOT NULL,
    struck     BOOLEAN NOT NULL DEFAULT TRUE,
    decided_at TEXT NOT NULL,
    applied_at TEXT,
    PRIMARY KEY (event_id, figure_id)
);

-- Why the curator ruled on an event as they did: the training labels behind
-- the suggestions in /kurasi. One row per event with a verdict, written beside
-- events.curated and deleted when the verdict is cleared. The snapshot columns
-- keep a label readable after the pipeline re-clusters or drops the event.
-- apply_curation.py mirrors the whole table into SQLite's curation_labels
-- every run (not just unapplied rows: jejak.db is disposable, the labels are
-- not), so there is no applied_at. No foreign key: --reset truncates events
-- with CASCADE, and these must survive it.
CREATE TABLE IF NOT EXISTS curation_reasons (
    event_id   INTEGER PRIMARY KEY,
    verdict    TEXT NOT NULL,     -- 'rejected' | 'kept'
    reasons    TEXT NOT NULL,     -- JSON array of codes (REASONS in curation.ts)
    note       TEXT,
    kind       TEXT,
    figure_id  TEXT,
    title      TEXT,
    summary    TEXT,
    outlets    INTEGER,
    -- The reason /kurasi suggested when the decision was made, if any:
    -- how often the curator agreed is the suggester's real accuracy.
    suggested  TEXT,
    decided_at TEXT NOT NULL
);

-- Pipeline-owned: jejak/curation_suggest.py's guess at what the curator would
-- do with an event nobody has ruled on yet, pushed like any other table.
-- auto_hide = 1 takes the event off the site (data.ts LIVE) until a curator
-- rules on it; it is only ever set for a reason whose measured precision
-- cleared the bar, and only when the pipeline runs with auto-hide enabled.
CREATE TABLE IF NOT EXISTS curation_suggestions (
    event_id   INTEGER PRIMARY KEY,
    reason     TEXT,              -- NULL: nothing suggested (looks like a keep)
    confidence REAL,
    support    INTEGER,           -- similar labelled events that share the reason
    examples   TEXT,              -- JSON array of those events' ids
    auto_hide  INTEGER NOT NULL DEFAULT 0,
    model      TEXT,
    scored_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curation_suggestions_auto ON curation_suggestions(auto_hide);

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
    mentions_figure INTEGER,        -- 1 if the text names the event's figure
    figure_stance TEXT,             -- stance toward the figure, where it is named
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
    -- The page address (figures.id) the curator chose; NULL derives it
    -- from full_name. Never from the mined spelling: "Hafidz" became
    -- /tokoh/hafidz for a man the curator named Habib Umar.
    curated_slug TEXT,
    -- The offices as the curator entered them, JSON [{role, org, period}],
    -- first = main; curated_role is that first one's title.
    curated_positions TEXT,
    decided_at  TEXT,
    applied_at  TEXT,          -- set once the pipeline has acted on the verdict
    -- What the curator saw that the evidence does not say: "this is a rank",
    -- "same person as X", "only ever quoted, never the actor". Free text,
    -- read by whoever tunes the extractor next.
    notes       TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_verdict ON figure_candidates(verdict);
CREATE INDEX IF NOT EXISTS idx_candidates_outlets ON figure_candidates(outlets DESC);
