"""The names queue /kurasi/kandidat reads: discovered people worth a curator's look.

Refreshes `candidate_review` from the pipeline's own evidence (figure_candidates
and figure_mentions). Only the evidence columns are rewritten; a curator's
verdict and notes on a row are left as they are, and a row that has either
stays even once it drops below the bar.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

# Candidates corroborated by this many outlets are worth a human's time. Kept
# in step with mentions.PROMOTE_MIN_OUTLETS, the bar the automatic promoter
# uses before its own name-shape checks.
MIN_OUTLETS = 3

EVIDENCE_SQL = """
    SELECT c.slug,
           c.name,
           count(DISTINCT m.source) AS outlets,
           count(*)                 AS mentions
      FROM figure_candidates c
      JOIN figure_mentions m ON m.slug = c.slug
     WHERE c.slug NOT IN (SELECT id FROM figures)
       AND c.status = 'candidate'
     GROUP BY c.slug
    HAVING outlets >= ?
"""


def mention_context(name: str, *texts: str | None, window: int = 130) -> str | None:
    """The sentence fragment a candidate's name was found in.

    Trimmed to whole words so the reviewer reads a phrase rather than a slice,
    and taken from the first text that contains the name — summary before body,
    since the lead is usually the cleanest statement of who did what.
    """
    for text in texts:
        if not text:
            continue
        pos = text.lower().find(name.lower())
        if pos < 0:
            continue
        start = max(0, pos - window)
        end = min(len(text), pos + len(name) + window)
        snippet = text[start:end].replace("\n", " ").strip()
        # Drop the half-words the window cut at either end.
        if start > 0:
            snippet = snippet.partition(" ")[2]
        if end < len(text):
            snippet = snippet.rpartition(" ")[0]
        snippet = " ".join(snippet.split())
        if not snippet:
            continue
        return ("…" if start > 0 else "") + snippet + ("…" if end < len(text) else "")
    return None


def refresh(conn: sqlite3.Connection, min_outlets: int = MIN_OUTLETS) -> int:
    """Rebuild the evidence behind every queued name. Does not commit.

    Returns how many names are in the queue.
    """
    now = datetime.now(timezone.utc).isoformat()
    # First words the curator keeps rejecting ("Polisi …", "Istana …"),
    # learned by jejak/kurasi.py: names starting with them are not asked.
    row = conn.execute(
        "SELECT value FROM pipeline_state WHERE key = 'learned_name_prefixes'").fetchone()
    skip = set(json.loads(row[0])) if row else set()
    slugs = []
    for c in conn.execute(EVIDENCE_SQL, (min_outlets,)).fetchall():
        if c["name"].split()[0] in skip:
            continue
        role_row = conn.execute(
            """SELECT role FROM figure_mentions
                WHERE slug = ? AND role IS NOT NULL AND role != ''
                GROUP BY role ORDER BY count(*) DESC LIMIT 1""",
            (c["slug"],),
        ).fetchone()
        # The article, and the sentence inside it that produced the name. A
        # name is mined from the body, never the headline, so the title alone
        # explains nothing: only the sentence says whether the extractor found
        # a person or cut "Jaksa Agung" in half.
        headlines = [
            {"title": r["title"], "url": r["url"], "source": r["source"],
             "context": mention_context(c["name"], r["summary"], r["body"])}
            for r in conn.execute(
                """SELECT a.title, a.url, a.source, a.summary, a.body,
                          max(a.published_at) AS pub
                     FROM figure_mentions m JOIN articles a ON a.id = m.article_id
                    WHERE m.slug = ? AND a.title IS NOT NULL
                    GROUP BY a.title
                    ORDER BY pub DESC LIMIT 4""",
                (c["slug"],),
            )
        ]
        # The events those articles ended up in: what promoting the name is
        # really about, in the site's own words.
        records = [
            {"id": r["id"], "title": r["title"], "figure_id": r["figure_id"]}
            for r in conn.execute(
                """SELECT e.id, e.title, e.figure_id, max(a.published_at) AS pub
                     FROM figure_mentions m
                     JOIN articles a ON a.id = m.article_id
                     JOIN events e ON e.id = a.event_id
                    WHERE m.slug = ? AND e.title IS NOT NULL
                    GROUP BY e.id
                    ORDER BY pub DESC LIMIT 4""",
                (c["slug"],),
            )
        ]
        conn.execute(
            """INSERT INTO candidate_review
                   (slug, name, outlets, mentions, role, headlines, records, refreshed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (slug) DO UPDATE SET
                 name = excluded.name, outlets = excluded.outlets,
                 mentions = excluded.mentions, role = excluded.role,
                 headlines = excluded.headlines, records = excluded.records,
                 refreshed_at = excluded.refreshed_at""",
            (c["slug"], c["name"], c["outlets"], c["mentions"],
             role_row["role"] if role_row else None,
             json.dumps(headlines, ensure_ascii=False),
             json.dumps(records, ensure_ascii=False), now),
        )
        slugs.append(c["slug"])
    # A name that has since been promoted, folded or fallen below the bar is
    # no longer a question — unless someone already wrote something on it.
    conn.execute(
        f"""DELETE FROM candidate_review
             WHERE verdict IS NULL AND notes IS NULL
               AND slug NOT IN ({','.join('?' * len(slugs)) or "''"})""",
        slugs,
    )
    return len(slugs)
