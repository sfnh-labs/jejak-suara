"""Changes to the tracked roster that span several tables."""
from __future__ import annotations

import json
import sqlite3


def merge_figure(conn: sqlite3.Connection, dup: str, real: str) -> list[str]:
    """Fold a duplicate figure into the one it duplicates.

    Its records, articles and peristiwa memberships move to `real`; its name
    and aliases join `real`'s aliases, so coverage written the duplicate's way
    keeps landing on the right page; and the duplicate is retired rather than
    deleted, so discovery sees the id as taken and never mints it again.

    Idempotent. Does not commit. Returns a line per change made.
    """
    rows = {r["id"]: r for r in conn.execute(
        "SELECT id, name, aliases FROM figures WHERE id IN (?, ?)", (dup, real))}
    if dup == real or real not in rows:
        return []
    done: list[str] = []

    for table in ("events", "articles"):
        n = conn.execute(f"UPDATE {table} SET figure_id = ? WHERE figure_id = ?",
                         (real, dup)).rowcount
        if n:
            done.append(f"{table}: {n} rows {dup} -> {real}")
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
