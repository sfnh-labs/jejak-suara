"""Stage 4 — Human review gate.

Nothing reaches the public timeline automatically. A human reads the grounded
draft + its citations and approves or rejects. This is the safeguard against
both AI hallucination and defamation exposure.
"""
from __future__ import annotations

import json
import sqlite3


def queue(conn: sqlite3.Connection) -> list[dict]:
    """Events awaiting review (status='summarized'), with their draft + flags."""
    rows = conn.execute(
        """SELECT e.id, e.figure_id, e.event_date, e.title,
                  s.summary_text, s.corroboration_count, s.single_source_flag,
                  s.citations_json
           FROM events e JOIN event_summaries s ON s.event_id = e.id
           WHERE e.status = 'summarized'
           ORDER BY e.event_date DESC"""
    ).fetchall()
    out = []
    for r in rows:
        articles = conn.execute(
            "SELECT source, url, title, published_at FROM articles "
            "WHERE event_id = ? ORDER BY published_at",
            (r["id"],),
        ).fetchall()
        out.append({
            "event_id": r["id"],
            "figure_id": r["figure_id"],
            "event_date": r["event_date"],
            "event_title": r["title"],
            "summary": r["summary_text"],
            "corroboration": r["corroboration_count"],
            "single_source": bool(r["single_source_flag"]),
            "n_citations": len(json.loads(r["citations_json"])),
            "articles": [dict(a) for a in articles],
        })
    return out


def set_status(conn: sqlite3.Connection, event_id: int, status: str) -> None:
    if status not in {"approved", "rejected", "summarized", "new"}:
        raise ValueError(f"invalid status: {status}")
    conn.execute("UPDATE events SET status = ? WHERE id = ?", (status, event_id))
    conn.commit()


def approve(conn: sqlite3.Connection, event_id: int) -> None:
    set_status(conn, event_id, "approved")


def reject(conn: sqlite3.Connection, event_id: int) -> None:
    set_status(conn, event_id, "rejected")


def timeline(conn: sqlite3.Connection, figure_id: str) -> list[dict]:
    """Approved (publishable) events for one figure, newest first.

    This is what a public timeline view would render.
    """
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
