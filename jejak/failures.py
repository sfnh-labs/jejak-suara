"""Events a model stage keeps failing on, so it stops retrying them.

A failure that is the model's fault (an answer slower than the timeout, a
reply that is not JSON) used to leave the event exactly as it was, so every
run retried it and failed the same way: three events cost summarize up to
nine minutes of timeouts a run for over a week. Each stage now counts its
failures per event here and gives up after MAX_FAILURES. The rows stay in
stage_failures (local only), and deleting one lets the stage try again.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

MAX_FAILURES = 3


def record(conn: sqlite3.Connection, stage: str, event_id: int, error: str) -> int:
    """Count one more failure of `stage` on the event and commit. Returns the count."""
    now = datetime.now(timezone.utc).isoformat()
    with conn:
        conn.execute(
            """INSERT INTO stage_failures (stage, event_id, failures, last_error, updated_at)
               VALUES (?, ?, 1, ?, ?)
               ON CONFLICT (stage, event_id) DO UPDATE SET
                   failures = failures + 1, last_error = excluded.last_error,
                   updated_at = excluded.updated_at""",
            (stage, event_id, error, now))
    return conn.execute(
        "SELECT failures FROM stage_failures WHERE stage = ? AND event_id = ?",
        (stage, event_id)).fetchone()[0]


def given_up(conn: sqlite3.Connection, stage: str) -> set[int]:
    """The events `stage` has failed on MAX_FAILURES times or more."""
    return {r[0] for r in conn.execute(
        "SELECT event_id FROM stage_failures WHERE stage = ? AND failures >= ?",
        (stage, MAX_FAILURES))}
