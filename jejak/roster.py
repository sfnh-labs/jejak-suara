"""Changes to the tracked roster that span several tables."""
from __future__ import annotations

import json
import sqlite3


def merge_figure(conn: sqlite3.Connection, dup: str, real: str) -> list[str]:
    """Fold a duplicate figure into the one it duplicates.

    Its records, articles, quotes, peristiwa memberships, places as a
    record's participant and speaker lessons move to `real`; its name and
    aliases join `real`'s aliases, so coverage written the duplicate's way
    keeps landing on the right page; and the duplicate is retired rather than
    deleted, so discovery sees the id as taken and never mints it again.

    Idempotent. Does not commit. Returns a line per change made.
    """
    rows = {r["id"]: r for r in conn.execute(
        "SELECT id, name, aliases FROM figures WHERE id IN (?, ?)", (dup, real))}
    if dup == real or real not in rows:
        return []
    done: list[str] = []

    for table in ("events", "articles", "event_quotes", "speaker_lessons"):
        n = conn.execute(f"UPDATE {table} SET figure_id = ? WHERE figure_id = ?",
                         (real, dup)).rowcount
        if n:
            done.append(f"{table}: {n} rows {dup} -> {real}")
    done += _merge_participants(conn, dup, real)
    done += _merge_lesson_scopes(conn, dup, real)
    for table in ("event_figures", "event_figure_rejections"):
        conn.execute(
            f"""INSERT OR IGNORE INTO {table} (event_id, figure_id)
                SELECT event_id, ? FROM {table} WHERE figure_id = ?""",
            (real, dup),
        )
        n = conn.execute(f"DELETE FROM {table} WHERE figure_id = ?", (dup,)).rowcount
        if n:
            done.append(f"{table}: {n} rows {dup} -> {real}")

    if dup in rows:
        aliases = json.loads(rows[real]["aliases"] or "[]")
        have = {a.lower() for a in aliases} | {rows[real]["name"].lower()}
        incoming = [rows[dup]["name"], *json.loads(rows[dup]["aliases"] or "[]")]
        new = []
        for a in incoming:
            if a and a.lower() not in have:
                have.add(a.lower())
                new.append(a)
        if new:
            conn.execute("UPDATE figures SET aliases = ? WHERE id = ?",
                         (json.dumps(aliases + new, ensure_ascii=False), real))
            done.append(f"{real}: added aliases {new}")
        if conn.execute("UPDATE figures SET active = 0 WHERE id = ? AND active = 1",
                        (dup,)).rowcount:
            done.append(f"{dup}: retired")
    return done


def _merge_participants(conn: sqlite3.Connection, dup: str, real: str) -> list[str]:
    """record_figures and actor_reviews: the duplicate's places become `real`'s.

    Where both were in a record, one row stays: a curator's or an answered
    point's over the stage's own (which participants.py rebuilds anyway).
    A review left suggesting a record's owner as its own other actor goes,
    if undecided.
    """
    done = []
    moved = conn.execute("UPDATE OR IGNORE record_figures SET figure_id = ? WHERE figure_id = ?",
                         (real, dup)).rowcount
    kept = conn.execute(
        """UPDATE record_figures AS r
              SET role = d.role, source = d.source, quotes = d.quotes, assigned_by = d.assigned_by
             FROM record_figures AS d
            WHERE d.figure_id = ? AND d.event_id = r.event_id AND r.figure_id = ?
              AND d.assigned_by != 'auto' AND r.assigned_by = 'auto'""",
        (dup, real)).rowcount
    left = conn.execute("DELETE FROM record_figures WHERE figure_id = ?", (dup,)).rowcount
    if moved or left:
        done.append(f"record_figures: {moved} rows {dup} -> {real}"
                    + (f", {left} already there" + (f" ({kept} curator's kept)" if kept else "")
                       if left else ""))

    n = conn.execute("UPDATE actor_reviews SET owner_id = ? WHERE owner_id = ?", (real, dup)).rowcount
    n += conn.execute("UPDATE actor_reviews SET suggested_id = ? WHERE suggested_id = ?",
                      (real, dup)).rowcount
    gone = conn.execute("DELETE FROM actor_reviews WHERE owner_id = suggested_id "
                        "AND decision IS NULL").rowcount
    if n:
        done.append(f"actor_reviews: {n} ids {dup} -> {real}"
                    + (f", {gone} now about one person dropped" if gone else ""))
    return done


def _merge_lesson_scopes(conn: sqlite3.Connection, dup: str, real: str) -> list[str]:
    """Speaker lessons scoped to the duplicate's catatan now hold in `real`'s;
    where `real` has its own for that speaker, its own stays."""
    moved = conn.execute("UPDATE OR IGNORE speaker_lessons SET scope = ? WHERE scope = ?",
                         (real, dup)).rowcount
    conn.execute("DELETE FROM speaker_lessons WHERE scope = ?", (dup,))
    return [f"speaker_lessons: {moved} scoped {dup} -> {real}"] if moved else []
