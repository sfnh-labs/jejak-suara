"""Verify DATABASE_URL is set and reachable, without ever printing it.

    python scripts/check_database_url.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlparse


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"'))


def main() -> int:
    _load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set (checked .env and the environment).")
        return 1
    if "user:pass@ep-xxx" in url:
        print("DATABASE_URL is still the placeholder from .env.example.")
        return 1

    parsed = urlparse(url)
    print(f"host:     {parsed.hostname}")
    print(f"database: {parsed.path.lstrip('/')}")
    print(f"sslmode:  {'require' in (parsed.query or '')}")

    try:
        import psycopg2
        conn = psycopg2.connect(url, connect_timeout=10)
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM events")
        n = cur.fetchone()[0]
        conn.close()
        print(f"connected OK — {n} rows in events")
    except Exception as e:
        print(f"connection FAILED: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
