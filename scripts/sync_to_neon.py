"""Sync SQLite data to Neon Postgres.

Run after pipeline completes:
    python scripts/sync_to_neon.py

Requires DATABASE_URL env var set.
"""
import sqlite3
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQLITE_PATH = ROOT / "jejak.db"

SCHEMA = (ROOT / "web" / "src" / "lib" / "schema.sql").read_text()


def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("❌ DATABASE_URL not set")
        sys.exit(1)

    try:
        import psycopg2
    except ImportError:
        print("Installing psycopg2-binary...")
        import subprocess
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "psycopg2-binary"],
            check=True,
        )
        import psycopg2

    conn = psycopg2.connect(db_url)
    conn.autocommit = True

    # Apply schema
    for stmt in SCHEMA.split(";"):
        stmt = stmt.strip()
        if stmt:
            with conn.cursor() as cur:
                cur.execute(stmt)

    # Read SQLite data
    sqlite = sqlite3.connect(str(SQLITE_PATH))
    sqlite.row_factory = sqlite3.Row

    tables = [
        ("events", "id", ["figure_id", "title", "event_date", "status", "created_at"]),
        ("event_summaries", "event_id", ["event_id", "summary_text", "citations_json", "corroboration_count", "single_source_flag", "model", "generated_at"]),
        ("sentiment", "id", ["event_id", "channel", "score", "label", "sample_size", "samples_json", "collected_at"]),
        ("corrections", "id", ["event_id", "submitted_by", "body", "status", "created_at"]),
        ("articles", "id", ["id", "figure_id", "source", "url", "title", "summary", "body", "fetch_status", "published_at", "fetched_at", "event_id"]),
    ]

    for table, key, cols in tables:
        rows = sqlite.execute(f"SELECT * FROM {table}").fetchall()
        if not rows:
            print(f"  {table}: 0 rows")
            continue

        placeholders = ", ".join(["%s"] * len(cols))
        names = ", ".join(cols)

        with conn.cursor() as cur:
            for row in rows:
                values = [row[c] for c in cols]
                try:
                    cur.execute(
                        f"INSERT INTO {table} ({names}) VALUES ({placeholders}) "
                        f"ON CONFLICT ({key}) DO NOTHING",
                        values,
                    )
                except Exception as e:
                    print(f"  {table}: error on {key}={row[key]}: {e}")

        print(f"  {table}: {len(rows)} rows")

    sqlite.close()
    conn.close()
    print("✅ Sync complete")


if __name__ == "__main__":
    main()
