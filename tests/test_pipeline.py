"""Regression tests for the pipeline's storage and classification invariants."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from jejak import cluster, db, ingest, mentions, sentiment, summarize  # noqa: E402
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
            "comments", "buzzer_signals", "corrections",
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
