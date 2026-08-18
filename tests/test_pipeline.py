"""Regression tests for the pipeline's storage and classification invariants."""
from __future__ import annotations

import sqlite3
import sys
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from jejak import (  # noqa: E402
    anonymize, backfill, cluster, db, ingest, mentions, sentiment, summarize,
    youtube,
)
from jejak.config import Figure  # noqa: E402


def _fresh(tmp_path: Path) -> sqlite3.Connection:
    path = tmp_path / "test.db"
    db.init_db(path)
    return db.connect(path)


def _indexes(conn: sqlite3.Connection) -> set[str]:
    return {
        r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        )
    }


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


class TestSchema:
    def test_init_creates_every_table(self, tmp_path):
        conn = _fresh(tmp_path)
        names = {
            r["name"] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert {
            "articles", "events", "event_summaries", "sentiment",
            "comments", "buzzer_signals", "corrections", "pipeline_state",
        } <= names

    def test_init_is_idempotent(self, tmp_path):
        path = tmp_path / "test.db"
        db.init_db(path)
        db.init_db(path)  # would raise if any DDL were non-idempotent
        conn = db.connect(path)
        assert "uq_sentiment_event_channel" in _indexes(conn)

    def test_migrate_upgrades_a_pre_existing_comments_table(self, tmp_path):
        """The unique index covers a column older databases gain via migrate().

        Creating it from SCHEMA alone would fail, because executescript runs
        before the ALTER TABLE that adds comment_id.
        """
        path = tmp_path / "old.db"
        conn = sqlite3.connect(path)
        # The comments table exactly as it shipped before comment_id existed.
        conn.executescript(
            """CREATE TABLE comments (
                   id           INTEGER PRIMARY KEY AUTOINCREMENT,
                   event_id     INTEGER NOT NULL,
                   video_id     TEXT,
                   author_id    TEXT,
                   author_name  TEXT,
                   text         TEXT NOT NULL,
                   like_count   INTEGER DEFAULT 0,
                   published_at TEXT,
                   stance       TEXT,
                   collected_at TEXT NOT NULL
               );"""
        )
        conn.commit()
        conn.close()

        db.init_db(path)

        conn = db.connect(path)
        assert "comment_id" in _columns(conn, "comments")
        assert "uq_comments_event_comment" in _indexes(conn)


class TestNullableFigureMigration:
    """Upgrading a pre-peristiwa database must not lose rows or break FKs."""

    def _legacy(self, path: Path) -> None:
        conn = sqlite3.connect(path)
        conn.executescript(
            """CREATE TABLE events (
                   id         INTEGER PRIMARY KEY AUTOINCREMENT,
                   figure_id  TEXT NOT NULL,
                   title      TEXT,
                   event_date TEXT,
                   status     TEXT NOT NULL DEFAULT 'new',
                   created_at TEXT NOT NULL
               );
               CREATE TABLE articles (
                   id         TEXT PRIMARY KEY,
                   figure_id  TEXT NOT NULL,
                   source     TEXT NOT NULL,
                   url        TEXT NOT NULL,
                   title      TEXT NOT NULL,
                   fetched_at TEXT NOT NULL,
                   event_id   INTEGER,
                   FOREIGN KEY (event_id) REFERENCES events(id)
               );
               INSERT INTO events (id, figure_id, title, status, created_at)
                    VALUES (1, 'prabowo', 'Rapat', 'approved', 'now');
               INSERT INTO articles (id, figure_id, source, url, title, fetched_at, event_id)
                    VALUES ('a1', 'prabowo', 'Kompas', 'http://x', 'Judul', 'now', 1);"""
        )
        conn.commit()
        conn.close()

    def test_rows_survive_and_column_becomes_nullable(self, tmp_path):
        path = tmp_path / "legacy.db"
        self._legacy(path)
        db.init_db(path)

        conn = db.connect(path)
        assert conn.execute("SELECT count(*) FROM events").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM articles").fetchone()[0] == 1
        for table in ("articles", "events"):
            notnull = [
                r["notnull"] for r in conn.execute(f"PRAGMA table_info({table})")
                if r["name"] == "figure_id"
            ]
            assert notnull == [0], f"{table}.figure_id should allow NULL"

    def test_foreign_keys_still_point_at_real_tables(self, tmp_path):
        """ALTER TABLE RENAME rewrites FKs in other tables to follow the rename.

        Renaming the original out of the way during a rebuild therefore leaves
        articles.event_id referencing a scratch table that is then dropped.
        """
        path = tmp_path / "legacy.db"
        self._legacy(path)
        db.init_db(path)

        conn = db.connect(path)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        stray = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND (name LIKE '_rebuild%' OR name LIKE '_migrate%')"
        ).fetchall()
        assert stray == []

    def test_peristiwa_rows_are_accepted_after_migration(self, tmp_path):
        path = tmp_path / "legacy.db"
        self._legacy(path)
        db.init_db(path)

        conn = db.connect(path)
        conn.execute(
            "INSERT INTO events (figure_id, kind, title, status, created_at) "
            "VALUES (NULL, 'peristiwa', 'Banjir bandang', 'candidate', 'now')"
        )
        conn.execute(
            "INSERT INTO articles (id, figure_id, source, url, title, fetched_at) "
            "VALUES ('a2', NULL, 'Tempo', 'http://y', 'Banjir', 'now')"
        )
        conn.commit()
        assert conn.execute(
            "SELECT count(*) FROM events WHERE kind = 'peristiwa'"
        ).fetchone()[0] == 1


class TestCommentUpserts:
    def test_recollection_updates_in_place(self, tmp_path):
        conn = _fresh(tmp_path)
        conn.execute(
            "INSERT INTO events (id, figure_id, status, created_at) "
            "VALUES (1, 'x', 'approved', 'now')"
        )
        comment = {
            "comment_id": "abc", "video_id": "v1", "author_id": "a",
            "author_name": "A", "text": "halo", "like_count": 1,
            "published_at": "2026-01-01",
        }
        sentiment._store_comments(conn, 1, [comment], ["neutral"])
        sentiment._store_comments(
            conn, 1, [{**comment, "like_count": 9}], ["positive"]
        )

        rows = conn.execute("SELECT * FROM comments").fetchall()
        assert len(rows) == 1, "same platform comment must not duplicate"
        assert rows[0]["like_count"] == 9
        assert rows[0]["stance"] == "positive"
        assert rows[0]["video_id"] == "v1"

    def test_distinct_comments_coexist(self, tmp_path):
        conn = _fresh(tmp_path)
        conn.execute(
            "INSERT INTO events (id, figure_id, status, created_at) "
            "VALUES (1, 'x', 'approved', 'now')"
        )
        base = {"video_id": "v", "author_id": "", "author_name": "",
                "like_count": 0, "published_at": ""}
        sentiment._store_comments(
            conn, 1,
            [{**base, "comment_id": "a", "text": "1"},
             {**base, "comment_id": "b", "text": "2"}],
            ["neutral", "positive"],
        )
        assert conn.execute("SELECT count(*) FROM comments").fetchone()[0] == 2


class TestClassification:
    def _reply(self, text: str):
        return lambda messages: {"message": {"content": text}}

    def test_misaligned_output_is_rejected(self, monkeypatch):
        monkeypatch.setattr(
            sentiment, "_ollama_chat", self._reply("1. positive")
        )
        with pytest.raises(ValueError):
            sentiment._classify_ollama(["a", "b", "c"], "prompt")

    def test_unalignable_comment_yields_none_not_neutral(self, monkeypatch):
        """A short response must not be padded into fabricated neutral labels."""
        monkeypatch.setattr(sentiment, "_ollama_chat", self._reply("nonsense"))
        assert sentiment.classify_comments(["a", "b"]) == [None, None]

    def test_aligned_output_passes_through(self, monkeypatch):
        monkeypatch.setattr(
            sentiment, "_ollama_chat",
            self._reply("1. positive\n2. negative"),
        )
        assert sentiment.classify_comments(["a", "b"]) == ["positive", "negative"]

    def test_aggregate_ignores_nothing_it_is_given(self):
        score, label, dist = sentiment._aggregate(
            ["positive", "positive", "negative", "neutral"]
        )
        assert dist == {"negative": 1, "neutral": 1, "positive": 2}
        assert score == pytest.approx(0.25)
        assert label == "positive"


class TestClustering:
    def test_event_types_have_no_stray_whitespace(self):
        for _, etype in cluster._EVENT_TYPE_KEYWORDS:
            assert etype == etype.strip(), f"{etype!r} has stray whitespace"

    def test_pemilu_is_inferred_cleanly(self):
        assert cluster._infer_event_type(["Persiapan pemilu 2029"]) == "Pemilu"

    def test_parse_always_returns_aware_utc(self):
        naive = cluster._parse("2026-01-01T00:00:00")
        aware = cluster._parse("2026-01-01T07:00:00+07:00")
        assert naive.tzinfo is not None and aware.tzinfo is not None
        # Subtracting these must not raise, which is the actual failure mode.
        assert (naive - aware).total_seconds() == 0

    def test_parse_falls_back_on_garbage(self):
        assert cluster._parse("not-a-date").tzinfo is not None


class TestLedgerHeading:
    """A record is headed by what the figure did, not by an outlet's headline.

    Every case here is output qwen2.5:7b actually produced — the model drops the
    JUDUL label, wraps the heading in bold or quotes, echoes the format skeleton
    back, or emits a heading too vague to publish.
    """

    def test_labelled_heading(self):
        title, body = summarize._split_title(
            "JUDUL: Menguji genteng sabut kelapa buatan BRIN\n---\n- x [Sumber 1]"
        )
        assert title == "Menguji genteng sabut kelapa buatan BRIN"
        assert body == "- x [Sumber 1]"

    def test_strips_bold_and_quotes(self):
        title, _ = summarize._split_title(
            '**JUDUL**: "Menolak kenaikan harga BBM."\n\n---\n\n- x [Sumber 1]'
        )
        assert title == "Menolak kenaikan harga BBM"

    def test_unlabelled_first_line_is_still_the_heading(self):
        title, body = summarize._split_title(
            "Meninjau genteng sabut kelapa\n\n- Meninjau genteng [Sumber 1]"
        )
        assert title == "Meninjau genteng sabut kelapa"
        assert body == "- Meninjau genteng [Sumber 1]"

    def test_bullets_only_yields_no_heading(self):
        assert summarize._split_title("- no heading here [Sumber 1]") == (
            None,
            "- no heading here [Sumber 1]",
        )

    def test_single_paragraph_is_not_mistaken_for_a_heading(self):
        para = (
            "Mengumumkan tiga langkah berjenjang untuk pemulihan gaji PPPK "
            "[Sumber 2]. Mengungkap efisiensi anggaran di NTT [Sumber 1]. "
            "Memberikan contoh dari Kabupaten Lahat [Sumber 2]."
        )
        title, body = summarize._split_title(para)
        assert title is None
        assert body == para

    def test_rejects_vague_heading(self):
        # "Menyatakan:" alone says nothing; the source headline is better.
        assert summarize._split_title("Menyatakan:\n- Saya kira [Sumber 1]")[0] is None

    def test_rejects_echoed_skeleton(self):
        # The model filling in nothing must not publish the template itself.
        assert summarize._split_title(
            "JUDUL: <kata kerja + objek, 4-10 kata>\n---\n- x [Sumber 1]"
        )[0] is None


class TestDynamicCategory:
    """event_type has no fixed list — the model tags from what's already in use
    or coins a new one. See _existing_categories / _extract_category."""

    def test_extracts_labelled_category(self):
        raw = "JUDUL: Meninjau lokasi\nKATEGORI: Kunjungan Kerja\n---\n- x [Sumber 1]"
        assert summarize._extract_category(raw) == "Kunjungan Kerja"

    def test_strips_noise_and_normalises_case(self):
        raw = 'JUDUL: x\nKATEGORI: "peresmian."\n---\n- x [Sumber 1]'
        assert summarize._extract_category(raw) == "Peresmian"

    def test_missing_category_yields_none(self):
        assert summarize._extract_category("JUDUL: x\n---\n- x [Sumber 1]") is None

    def test_rejects_echoed_skeleton(self):
        raw = "JUDUL: x\nKATEGORI: <jenis peristiwa, 1-3 kata>\n---\n- x [Sumber 1]"
        assert summarize._extract_category(raw) is None

    def test_rejects_vague_sentinel(self):
        for word in ("Lainnya", "Other", "Umum", "berita"):
            raw = f"JUDUL: x\nKATEGORI: {word}\n---\n- x [Sumber 1]"
            assert summarize._extract_category(raw) is None, word

    def test_rejects_compound_category(self):
        # The model hedging between two tags instead of picking one.
        raw = "JUDUL: x\nKATEGORI: Pernyataan, Kebijakan\n---\n- x [Sumber 1]"
        assert summarize._extract_category(raw) is None

    def test_existing_categories_excludes_other_and_ranks_by_frequency(self):
        conn = db.connect(":memory:")
        conn.executescript(db.SCHEMA)
        rows = [
            ("Kebijakan", "peristiwa"), ("Kebijakan", "peristiwa"),
            ("Kunjungan", "peristiwa"), ("other", "peristiwa"),
            (None, "record"),
        ]
        for i, (etype, kind) in enumerate(rows):
            conn.execute(
                "INSERT INTO events (kind, title, event_type, status, created_at) "
                "VALUES (?, 'x', ?, 'new', '2026-01-01')",
                (kind, etype),
            )
        assert summarize._existing_categories(conn) == ["Kebijakan", "Kunjungan"]

    def test_format_categories_prompts_for_a_first_one_when_empty(self):
        assert "belum ada kategori" in summarize._format_categories([]).lower()

    def test_format_categories_lists_existing(self):
        out = summarize._format_categories(["Kebijakan", "Kunjungan Kerja"])
        assert "Kebijakan" in out and "Kunjungan Kerja" in out


class TestCandidateGate:
    """summarize_event must never publish a peristiwa still below the
    corroboration gate — it unconditionally sets status='approved', so it is
    the wrong function to call on a 'candidate'. A batch script once broadened
    its SQL filter and summarized 14 uncorroborated candidates before this
    guard existed."""

    def test_refuses_to_summarize_a_candidate(self, tmp_path):
        conn = _fresh(tmp_path)
        conn.execute(
            "INSERT INTO events (id, kind, title, status, created_at) "
            "VALUES (1, 'peristiwa', 'x', 'candidate', '2026-01-01')"
        )
        conn.execute(
            "INSERT INTO articles (id, source, url, title, fetched_at, event_id) "
            "VALUES ('a1', 'Tempo', 'https://x', 'x', '2026-01-01', 1)"
        )
        conn.commit()
        with pytest.raises(ValueError, match="candidate"):
            summarize.summarize_event(conn, 1)
        # Untouched: no summary written, status unchanged.
        assert conn.execute(
            "SELECT count(*) FROM event_summaries"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT status FROM events WHERE id = 1"
        ).fetchone()[0] == "candidate"


class TestAttribution:
    """A record must be the figure's own conduct, not every article naming them."""

    FIGS = [Figure(id="p", name="Prabowo Subianto", role="", aliases=["Prabowo"])]

    def test_matches_alias_case_insensitively(self):
        assert ingest._attribute("PRABOWO kunjungi Jakarta", self.FIGS).id == "p"

    def test_returns_none_when_no_figure_mentioned(self):
        assert ingest._attribute("Berita cuaca hari ini", self.FIGS) is None

    def test_figure_acting_is_their_record(self):
        assert ingest._attribute(
            "Prabowo perintahkan harga BBM subsidi tidak dinaikkan", self.FIGS
        ) is not None

    def test_quote_attributed_to_the_figure_is_their_record(self):
        assert ingest._attribute(
            "Prabowo: Bahaya Perang Nuklir Tak Bisa Diremehkan", self.FIGS
        ) is not None

    def test_someone_else_acting_is_not_their_record(self):
        """The chairman's challenge belongs to the chairman, not to Prabowo."""
        assert ingest._attribute(
            "Ketua DPN Tani Merdeka Tantang Para Pembenci Prabowo untuk Turun ke Desa",
            self.FIGS,
        ) is None

    def test_being_visited_is_not_their_record(self):
        assert ingest._attribute(
            "Pimpinan MPR Temui Prabowo di Istana Kepresidenan", self.FIGS
        ) is None

    def test_an_abbreviated_title_still_names_the_actor(self):
        """Headlines contract every title; the long form alone misses them."""
        assert ingest._attribute(
            "Jubir PCO Sebut Prabowo Tekankan Kolaborasi Dukung MBG", self.FIGS
        ) is None
        assert ingest._attribute(
            "Waketum PSI Andy Budiman Tegaskan Dukungan ke Prabowo", self.FIGS
        ) is None

    def test_mention_outside_the_headline_does_not_attribute(self):
        """A name in the summary is context, not authorship of the article."""
        assert ingest._attribute(
            "Komisi III DPR bantah surpres\nDalam rapat, nama Prabowo disebut.",
            self.FIGS,
        ) is None


class TestMentionExtraction:
    """Figures are discovered from coverage, so the name/role split must hold."""

    def _one(self, text: str):
        found = mentions.extract(text)
        assert len(found) == 1, f"expected one mention, got {found}"
        return found[0]

    def test_plain_title_and_name(self):
        m = self._one("Menkeu Sri Mulyani menyatakan akan patuhi putusan MK.")
        assert (m.name, m.role) == ("Sri Mulyani", "Menkeu")

    def test_organisation_acronym_is_not_part_of_the_name(self):
        m = self._one("Rektor UI Ari Kuncoro membuka seminar di Depok.")
        assert (m.name, m.role, m.org) == ("Ari Kuncoro", "Rektor", "UI")

    def test_place_qualifier_stays_with_the_role(self):
        m = self._one("Gubernur Jawa Tengah Ahmad Luthfi meninjau lokasi banjir.")
        assert (m.name, m.role) == ("Ahmad Luthfi", "Gubernur Jawa Tengah")

    def test_unlisted_jurisdiction_after_a_place_scoped_title(self):
        """There are too many regencies to enumerate, so the title implies one."""
        m = self._one("Kapolres Bangkalan Wibowo memimpin olah TKP.")
        assert (m.name, m.role) == ("Wibowo", "Kapolres Bangkalan")

    def test_named_institution_stays_out_of_the_name(self):
        m = self._one("Rektor Universitas Paramadina Anies Baswedan memberi kuliah.")
        assert m.name == "Anies Baswedan"

    def test_non_political_domain(self):
        m = self._one("Dosen Teknik Informatika Budi Santoso memublikasikan risetnya.")
        assert (m.name, m.role) == ("Budi Santoso", "Dosen Teknik Informatika")

    def test_name_does_not_run_past_a_full_stop(self):
        m = self._one("Presiden Prabowo Subianto. Pilihan lain muncul kemudian.")
        assert m.name == "Prabowo Subianto"

    def test_role_without_a_person_is_not_a_mention(self):
        assert mentions.extract("Menteri Keuangan Republik Indonesia hadir.") == []

    def test_text_without_any_title_is_skipped(self):
        assert mentions.extract("Hujan deras mengguyur kota sejak pagi.") == []


class TestNeonSync:
    def test_events_carry_their_id(self):
        """The bug that duplicated the events table on every scheduled run."""
        import sync_to_neon

        events = next(t for t in sync_to_neon.TABLES if t.name == "events")
        assert "id" in events.insert_cols
        assert events.target == ("id",)

    def test_natural_key_tables_omit_the_surrogate_id(self):
        import sync_to_neon

        for name in ("sentiment", "buzzer_signals"):
            table = next(t for t in sync_to_neon.TABLES if t.name == name)
            assert "id" not in table.insert_cols, name
            assert table.pk not in table.updatable, name

    def test_declared_columns_exist_in_sqlite(self, tmp_path):
        import sync_to_neon

        conn = _fresh(tmp_path)
        for table in sync_to_neon.TABLES:
            names = ", ".join(table.cols)
            conn.execute(f"SELECT {names} FROM {table.name}")  # raises if wrong


class TestBackfill:
    """The archive walk that fills in history behind the live RSS feed."""

    def _page(self, href: str, title: str) -> str:
        """The markup shape all three archives share: link, then thumbnail."""
        return (
            f'<article><a class="media__link" href="{href}">'
            f'<img src="x.jpg" alt="{title}" /></a></article>'
        )

    def test_listing_pairs_each_url_with_its_headline(self):
        arc = next(a for a in backfill.ARCHIVES if a.name == "Kompas")
        url = ("https://nasional.kompas.com/read/2025/03/01/23231201/"
               "prabowo-buka-rapat-terbatas")
        page = self._page(url, "Prabowo Buka Rapat Terbatas di Istana")
        assert backfill._listing(page, arc) == {
            url: "Prabowo Buka Rapat Terbatas di Istana"
        }

    def test_listing_skips_links_with_no_recoverable_headline(self):
        arc = next(a for a in backfill.ARCHIVES if a.name == "Kompas")
        url = ("https://nasional.kompas.com/read/2025/03/01/23231201/"
               "prabowo-buka-rapat-terbatas")
        assert backfill._listing(f'<a href="{url}"></a>', arc) == {}

    def test_detik_headline_comes_from_the_tracking_handler(self):
        arc = next(a for a in backfill.ARCHIVES if a.name == "Detik")
        url = "https://news.detik.com/berita/d-7802125/prabowo-bertemu-menteri"
        onclick = "_pt(this, \"newsfeed\", \"Prabowo Bertemu Menteri\", \"artikel 16\")"
        page = f"<a href=\"{url}\" onclick='{onclick}'>"
        assert backfill._listing(page, arc) == {url: "Prabowo Bertemu Menteri"}

    def test_publication_time_is_recovered_from_the_url(self):
        arc = next(a for a in backfill.ARCHIVES if a.name == "CNN Indonesia")
        url = ("https://www.cnnindonesia.com/ekonomi/20250301133535-92-1203857/"
               "badan-gizi-sebut-pemda")
        assert backfill._published(arc, url, date(2025, 3, 1)) == \
            "2025-03-01T13:35:35+07:00"

    def test_time_falls_back_to_local_midnight(self):
        """Detik's archive pins the date but not the hour."""
        arc = next(a for a in backfill.ARCHIVES if a.name == "Detik")
        url = "https://news.detik.com/berita/d-7802125/prabowo-bertemu-menteri"
        assert backfill._published(arc, url, date(2025, 3, 1)) == \
            "2025-03-01T00:00:00+07:00"

    def _walk(self, conn, monkeypatch, **kw):
        seen = []

        def fake_day(_conn, day, _figures=None, general=False):
            seen.append(day)
            return {"seen": 0, "matched": 0, "inserted": 0,
                    "skipped_existing": 0, "pages": 0}

        monkeypatch.setattr(backfill, "backfill_day", fake_day)
        return seen, backfill.backfill(conn, **kw)

    def test_the_cursor_resumes_where_the_last_run_stopped(self, tmp_path,
                                                           monkeypatch):
        conn = _fresh(tmp_path)
        backfill._set_state(conn, backfill.CURSOR_KEY, "2025-03-10")
        conn.commit()

        seen, stats = self._walk(conn, monkeypatch, days=3,
                                 floor=date(2024, 1, 1))
        assert seen == [date(2025, 3, 9), date(2025, 3, 8), date(2025, 3, 7)]
        assert stats["reached"] == "2025-03-07"
        assert backfill._get_state(conn, backfill.CURSOR_KEY) == "2025-03-07"

    def test_the_walk_stops_at_the_floor(self, tmp_path, monkeypatch):
        """Left in the scheduled pipeline, this stage has to go quiet."""
        conn = _fresh(tmp_path)
        backfill._set_state(conn, backfill.CURSOR_KEY, "2025-03-02")
        conn.commit()

        seen, stats = self._walk(conn, monkeypatch, days=5,
                                 floor=date(2025, 3, 1))
        assert seen == [date(2025, 3, 1)]
        assert stats.get("done") == 1

    def _one_page_archive(self, monkeypatch, page: str):
        arc = next(a for a in backfill.ARCHIVES if a.name == "Kompas")
        monkeypatch.setattr(backfill, "ARCHIVES", (arc,))
        monkeypatch.setattr(backfill, "_download",
                            lambda u: page if u.endswith("page=1") else None)
        monkeypatch.setattr(backfill.time, "sleep", lambda _s: None)

    def test_backfilled_articles_are_attributed_like_ingested_ones(
            self, tmp_path, monkeypatch):
        conn = _fresh(tmp_path)
        url = ("https://nasional.kompas.com/read/2025/03/01/23231201/"
               "prabowo-buka-rapat")
        self._one_page_archive(
            monkeypatch, self._page(url, "Prabowo Buka Rapat Terbatas di Istana"))

        figures = [Figure(id="prabowo", name="Prabowo Subianto",
                          role="Presiden", aliases=["Prabowo"])]
        stats = backfill.backfill_day(conn, date(2025, 3, 1), figures)

        assert stats["inserted"] == 1
        row = conn.execute("SELECT figure_id, source, published_at "
                           "FROM articles").fetchone()
        assert row["figure_id"] == "prabowo"
        assert row["source"] == "Kompas"
        assert row["published_at"].startswith("2025-03-01T23:23:12")

    def test_unattributed_headlines_are_dropped_unless_asked_for(
            self, tmp_path, monkeypatch):
        """Archives carry every section an outlet publishes, not just politics."""
        conn = _fresh(tmp_path)
        url = ("https://bola.kompas.com/read/2025/03/01/23231201/"
               "hasil-liga-1-persebaya")
        self._one_page_archive(
            monkeypatch, self._page(url, "Hasil Liga 1: Persebaya Taklukkan Persib"))
        figures = [Figure(id="prabowo", name="Prabowo Subianto",
                          role="Presiden", aliases=["Prabowo"])]

        assert backfill.backfill_day(conn, date(2025, 3, 1),
                                     figures)["inserted"] == 0
        assert backfill.backfill_day(conn, date(2025, 3, 1), figures,
                                     general=True)["inserted"] == 1
        assert conn.execute(
            "SELECT figure_id FROM articles").fetchone()["figure_id"] is None


class TestLateArrivingCoverage:
    """Backfill means an article can land long after its event was summarized."""

    def test_a_new_article_reopens_a_summarized_event(self, tmp_path):
        conn = _fresh(tmp_path)
        conn.execute(
            "INSERT INTO events (id, figure_id, title, event_date, status, "
            "created_at) VALUES (1, 'prabowo', 'Rapat', '2025-03-01', "
            "'approved', '2025-03-01')"
        )
        conn.execute(
            "INSERT INTO event_summaries (event_id, summary_text, "
            "citations_json, corroboration_count, single_source_flag, model, "
            "generated_at) VALUES (1, 'ringkasan', '[]', 1, 1, 'qwen', "
            "'2025-03-01')"
        )
        cluster._reopen_if_summarized(conn, 1)

        assert conn.execute(
            "SELECT status FROM events WHERE id = 1"
        ).fetchone()["status"] == "new"
        assert conn.execute(
            "SELECT count(*) FROM event_summaries").fetchone()[0] == 0

    def test_a_candidate_is_left_alone(self, tmp_path):
        """It has no summary to invalidate, and the outlet gate owns its status."""
        conn = _fresh(tmp_path)
        conn.execute(
            "INSERT INTO events (id, kind, title, event_date, status, "
            "created_at) VALUES (1, 'peristiwa', 'Banjir', '2025-03-01', "
            "'candidate', '2025-03-01')"
        )
        cluster._reopen_if_summarized(conn, 1)
        assert conn.execute(
            "SELECT status FROM events WHERE id = 1"
        ).fetchone()["status"] == "candidate"

    def test_summarized_events_stay_open_for_matching(self):
        """The status filter clustering uses to decide what an article can join."""
        source = (ROOT / "jejak" / "cluster.py").read_text(encoding="utf-8")
        assert "'new','summarized','candidate','approved'" in source


class TestAnonymize:
    """Commenters are private individuals; their display name is never stored."""

    def test_the_same_account_masks_the_same_everywhere(self):
        """Buzzer's 'one account, many events' finding has to stay legible."""
        a = anonymize.mask_author("UC123", "Budi Santoso")
        b = anonymize.mask_author("UC123", "Budi Santoso")
        assert a == b

    def test_different_accounts_mask_differently(self):
        assert anonymize.mask_author("UC123") != anonymize.mask_author("UC999")

    def test_the_mask_does_not_carry_the_display_name(self):
        mask = anonymize.mask_author("UC123", "Budi Santoso")
        assert "Budi" not in mask and "Santoso" not in mask

    def test_the_id_decides_the_mask_not_the_name(self):
        """A commenter who renames themselves stays the same person."""
        assert (anonymize.mask_author("UC123", "Budi Santoso")
                == anonymize.mask_author("UC123", "Nama Baru"))

    def test_a_missing_id_still_does_not_leak_the_name(self):
        mask = anonymize.mask_author("", "Budi Santoso")
        assert mask.startswith(anonymize.PREFIX)
        assert "Budi" not in mask

    def test_nothing_to_go_on_is_anonymous(self):
        assert anonymize.mask_author("", "") == "Anonim"
        assert anonymize.mask_author(None, None) == "Anonim"

    def test_stored_comments_carry_the_mask_not_the_name(self, tmp_path):
        conn = _fresh(tmp_path)
        conn.execute(
            "INSERT INTO events (id, figure_id, title, event_date, status, "
            "created_at) VALUES (1, 'p', 'T', '2026-01-01', 'approved', "
            "'2026-01-01')"
        )
        comments = [{
            "comment_id": "c1", "video_id": "v1", "channel": "Kompas TV",
            "author_id": "UC123", "author_name": "Budi Santoso",
            "text": "setuju", "like_count": 3, "published_at": "2026-01-01",
        }]
        sentiment._store_comments(conn, 1, comments, ["positive"])

        row = conn.execute(
            "SELECT author_name, author_id, channel FROM comments"
        ).fetchone()
        assert row["author_name"] == anonymize.mask_author("UC123")
        assert "Budi" not in row["author_name"]
        # Kept, but hashed: buzzer needs a stable identity and only compares
        # it, while the raw value resolves straight back to the account.
        assert row["author_id"] == anonymize.hash_author_id("UC123")
        assert row["channel"] == "Kompas TV"


class TestCommentChannel:
    """Which audience a comment came from is part of reading the reaction."""

    def test_search_results_carry_the_channel(self, monkeypatch):
        monkeypatch.setattr(youtube, "_get", lambda endpoint, params: {
            "items": [
                {"id": {"videoId": "v1"},
                 "snippet": {"channelTitle": "Kompas TV"}},
                {"id": {"kind": "channel"}, "snippet": {}},
            ]
        })
        assert youtube.search_videos("prabowo") == [
            {"id": "v1", "channel": "Kompas TV"}
        ]

    def test_the_channel_reaches_each_comment(self, monkeypatch):
        monkeypatch.setattr(youtube, "search_videos",
                            lambda *a, **k: [{"id": "v1", "channel": "Metro TV"}])
        monkeypatch.setattr(youtube, "_get", lambda endpoint, params: {
            "items": [{
                "snippet": {"topLevelComment": {
                    "id": "c1",
                    "snippet": {"textDisplay": "halo", "likeCount": 1},
                }}
            }]
        })
        [comment] = youtube.gather_comments("prabowo")
        assert comment["channel"] == "Metro TV"


class TestAuthorIdHashing:
    """The raw id resolves to the person at youtube.com/channel/<id>."""

    RAW = "UCTYkjXS2uvfqpyZqpzjxjqg"

    def test_the_channel_id_does_not_survive(self):
        assert self.RAW not in anonymize.hash_author_id(self.RAW)

    def test_hashing_is_stable(self):
        """Buzzer matches accounts across events by equality alone."""
        assert (anonymize.hash_author_id(self.RAW)
                == anonymize.hash_author_id(self.RAW))

    def test_distinct_accounts_stay_distinct(self):
        assert anonymize.hash_author_id("UC1") != anonymize.hash_author_id("UC2")

    def test_hashing_twice_changes_nothing(self):
        """A second pipeline run must not re-hash and break the identity."""
        once = anonymize.hash_author_id(self.RAW)
        assert anonymize.hash_author_id(once) == once

    def test_empty_stays_empty(self):
        assert anonymize.hash_author_id("") == ""
        assert anonymize.hash_author_id(None) == ""

    def test_is_hashed_rejects_a_raw_channel_id(self):
        assert not anonymize.is_hashed(self.RAW)
        assert anonymize.is_hashed(anonymize.hash_author_id(self.RAW))

    def test_stored_rows_carry_neither_identity(self, tmp_path):
        conn = _fresh(tmp_path)
        conn.execute(
            "INSERT INTO events (id, figure_id, title, event_date, status, "
            "created_at) VALUES (1, 'p', 'T', '2026-01-01', 'approved', "
            "'2026-01-01')"
        )
        sentiment._store_comments(conn, 1, [{
            "comment_id": "c1", "video_id": "v1", "channel": "Kompas TV",
            "author_id": self.RAW, "author_name": "Budi Santoso",
            "text": "setuju", "like_count": 1, "published_at": "2026-01-01",
        }], ["positive"])

        row = conn.execute(
            "SELECT author_id, author_name FROM comments").fetchone()
        assert row["author_id"] == anonymize.hash_author_id(self.RAW)
        assert self.RAW not in row["author_id"]
        assert "Budi" not in row["author_name"]

    def test_the_mask_survives_the_id_being_hashed(self):
        """The raw id is gone after the first write, so the mask cannot need it.

        Masking a prefix of the digest is what makes the two agree: rows
        written before ids were hashed keep the pseudonym they already had.
        """
        assert (anonymize.mask_author(self.RAW)
                == anonymize.mask_author(anonymize.hash_author_id(self.RAW)))

    def test_a_pseudonym_is_wide_enough_to_stay_unique(self):
        """Four hex digits collided for 54 pairs across a real 2592 accounts."""
        masks = {anonymize.mask_author(f"UC{i}") for i in range(3000)}
        assert len(masks) > 2995

    def test_buzzer_still_groups_an_account_across_events(self, tmp_path):
        """Hashing must be invisible to the signal it feeds."""
        conn = _fresh(tmp_path)
        for eid in (1, 2, 3):
            conn.execute(
                "INSERT INTO events (id, figure_id, title, event_date, status, "
                "created_at) VALUES (?, 'p', 'T', '2026-01-01', 'approved', "
                "'2026-01-01')", (eid,)
            )
            sentiment._store_comments(conn, eid, [{
                "comment_id": f"c{eid}", "video_id": "v", "channel": "TV",
                "author_id": self.RAW, "author_name": "Budi",
                "text": "sama", "like_count": 0, "published_at": "2026-01-01",
            }], ["positive"])

        ids = {r["author_id"] for r in
               conn.execute("SELECT author_id FROM comments")}
        assert len(ids) == 1, "one account must remain one identity"
