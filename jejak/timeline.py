"""Read-side timeline for the local Flask operator UI.

Curation lives in the deployed web app (`web/src/app/kurasi`), which writes
`events.curated` straight to Postgres. This module is what is left of the old
SQLite-side review gate: a single query, no writes.
"""
from __future__ import annotations

import json
import sqlite3


def for_figure(conn: sqlite3.Connection, figure_id: str) -> list[dict]:
    """Approved events for one figure, newest first."""
    rows = conn.execute(
        """SELECT e.id, e.title AS event_title, e.event_date, s.summary_text,
                  s.corroboration_count, s.citations_json,
                  sent.label  AS sentiment_label,
                  sent.score  AS sentiment_score,
                  sent.sample_size AS sentiment_n,
                  sent.samples_json AS sentiment_samples
           FROM events e
           JOIN event_summaries s ON s.event_id = e.id
           LEFT JOIN sentiment sent ON sent.id = (
               SELECT id FROM sentiment x WHERE x.event_id = e.id
               ORDER BY collected_at DESC LIMIT 1)
           WHERE e.figure_id = ? AND e.status = 'approved'
           ORDER BY e.event_date DESC""",
        (figure_id,),
    ).fetchall()
    out = []
    for r in rows:
        item = {
            "event_id": r["id"],
            "title": r["event_title"],
            "date": r["event_date"],
            "summary": r["summary_text"],
            "corroboration": r["corroboration_count"],
            "citations": json.loads(r["citations_json"]),
            "sentiment": None,
        }
        if r["sentiment_label"] is not None:
            # Labelled as platform reaction, with sample size — never a verdict.
            item["sentiment"] = {
                "label": r["sentiment_label"],
                "score": r["sentiment_score"],
                "sample_size": r["sentiment_n"],
                "channel": "public reaction (YouTube)",
                # Unverified example comments, for display only.
                "samples": json.loads(r["sentiment_samples"] or "[]"),
            }
        out.append(item)
    return out
