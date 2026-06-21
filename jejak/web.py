"""Web UI — public timeline + reviewer queue.

Two faces of the same small Flask app:
  * Public timeline  (GET /, /figure/<id>) — APPROVED events only, with grounded
    citations and the public-reaction line.
  * Reviewer queue   (GET /review, POST approve/reject) — the human-in-the-loop
    gate where drafts become publishable.

Server-rendered (Jinja), read-mostly. The DB path comes from $JEJAK_DB so tests
can point at a temp database.

SECURITY: the reviewer routes mutate state and have NO auth — this is a localhost
dev tool. Put it behind authentication before exposing it anywhere.
"""
from __future__ import annotations

import os
import re

from flask import Flask, g, redirect, render_template, request, url_for
from markupsafe import Markup, escape

from . import db, review
from .config import Figure, load_figures
from .embed import cosine_similarity, embed


_BULAN = [
    "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
]


def _fmt_date(raw: str | None) -> str:
    """Convert ISO date/timestamp to Indonesian format.

    Handles both date-only (2026-06-20) and full timestamps (2026-06-20T06:01:18Z).
    """
    if not raw:
        return ""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if not m:
        return raw
    y, mo, d = m.group(1), int(m.group(2)), int(m.group(3))
    label = f"{d} {_BULAN[mo]} {y}"
    # Append time if present
    if "T" in raw:
        t = raw.split("T")[1].split("+")[0].split("Z")[0]
        # Strip seconds if :00
        if t.endswith(":00"):
            t = t[:-3]
        label += f" {t[:5]}"
    return label


def _link_figures(text: str, figures: list[Figure]) -> Markup:
    """Replace figure names/aliases in `text` with links to their timeline pages.

    Sorts by length descending so longer names match before substrings.
    """
    terms = []
    for f in figures:
        for t in [f.name, *f.aliases]:
            if t.strip():
                terms.append((t, f.id))
    terms.sort(key=lambda x: len(x[0]), reverse=True)

    escaped = escape(text)
    for name, fid in terms:
        pattern = re.compile(re.escape(name), re.IGNORECASE)
        escaped = Markup(pattern.sub(
            rf'<a href="/figure/{fid}" class="fig-link">{name}</a>',
            str(escaped),
        ))
    return Markup(str(escaped).replace("\n", "<br>"))


def _db_path() -> str:
    return os.environ.get("JEJAK_DB", str(db.DEFAULT_DB))


def get_conn():
    if "conn" not in g:
        g.conn = db.connect(_db_path())
        db.migrate(g.conn)
    return g.conn


def create_app() -> Flask:
    app = Flask(__name__)
    app.jinja_env.filters["fdate"] = _fmt_date
    app.jinja_env.filters["link_figures"] = _link_figures

    @app.teardown_appcontext
    def _close(_exc):
        conn = g.pop("conn", None)
        if conn is not None:
            conn.close()

    def _figure_map() -> dict[str, str]:
        return {f.id: f.name for f in load_figures()}

    @app.route("/")
    def index():
        conn = get_conn()
        figs = load_figures()
        rows = []
        for f in figs:
            approved = conn.execute(
                "SELECT count(*) FROM events WHERE figure_id=? AND status='approved'",
                (f.id,),
            ).fetchone()[0]
            flagged = conn.execute(
                "SELECT count(*) FROM events WHERE figure_id=? AND status='summarized'",
                (f.id,),
            ).fetchone()[0]
            rows.append({"figure": f, "approved": approved, "flagged": flagged})
        review_count = conn.execute(
            "SELECT count(*) FROM events WHERE status='summarized'"
        ).fetchone()[0]
        return render_template("index.html", rows=rows, review_count=review_count)

    @app.route("/figure/<figure_id>")
    def figure(figure_id):
        conn = get_conn()
        figs = [f for f in load_figures() if f.active and f.id != figure_id]
        fig_map = _figure_map()
        name = fig_map.get(figure_id, figure_id)

        events = review.timeline(conn, figure_id)

        # Build prev/next links between events with similar embeddings
        event_ids = [ev["event_id"] for ev in events]
        event_dates = {ev["event_id"]: ev["date"] for ev in events}
        follow_links: dict[int, dict] = {}
        for i in range(len(event_ids)):
            for j in range(i + 1, len(event_ids)):
                ea, eb = event_ids[i], event_ids[j]
                txt_a = events[i].get("summary", "")
                txt_b = events[j].get("summary", "")
                if not txt_a or not txt_b:
                    continue
                sim = 0.0
                try:
                    v_a = embed(txt_a)
                    v_b = embed(txt_b)
                    sim = cosine_similarity(v_a, v_b)
                except Exception:
                    continue
                if sim >= 0.45:
                    earlier = ea if event_dates[ea] <= event_dates[eb] else eb
                    later = eb if earlier == ea else ea
                    for eid, direction in [(earlier, "next"), (later, "prev")]:
                        cur = follow_links.setdefault(eid, {})
                        other = later if direction == "next" else earlier
                        if direction not in cur or sim > cur[direction]["sim"]:
                            cur[direction] = {"event_id": other, "sim": round(sim, 2)}

        # Events from other figures that mention this figure
        related = conn.execute(
            """SELECT e.id, e.figure_id, e.event_date,
                      s.summary_text, s.corroboration_count
               FROM events e
               JOIN event_summaries s ON s.event_id = e.id
               WHERE e.figure_id != ? AND e.status = 'approved'
                 AND s.summary_text LIKE ?
               ORDER BY e.event_date DESC LIMIT 5""",
            (figure_id, f"%{name}%"),
        ).fetchall()

        related_events = []
        for r in related:
            related_events.append({
                "event_id": r["id"],
                "figure_id": r["figure_id"],
                "figure_name": fig_map.get(r["figure_id"], r["figure_id"]),
                "date": r["event_date"],
                "summary": r["summary_text"],
                "corroboration": r["corroboration_count"],
            })

        return render_template("timeline.html", figure_id=figure_id,
                               figure_name=name, events=events,
                               all_figures=figs,
                               related_events=related_events,
                               follow_links=follow_links)

    @app.route("/review")
    def review_queue():
        conn = get_conn()
        return render_template("review.html", rows=review.queue(conn),
                               figures=_figure_map())

    @app.route("/figure/<int:event_id>/laporkan", methods=["POST"])
    def laporkan(event_id):
        conn = get_conn()
        review.set_status(conn, event_id, "summarized")
        return redirect(url_for("review_queue"))

    @app.route("/review/<int:event_id>/<action>", methods=["POST"])
    def review_action(event_id, action):
        conn = get_conn()
        if action == "approve":
            review.approve(conn, event_id)
        elif action == "reject":
            review.reject(conn, event_id)
        return redirect(url_for("review_queue"))

    return app


# `flask --app jejak.web run`  or  `python -m jejak.web`
app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
