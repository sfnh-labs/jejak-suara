"""Command-line orchestration for the pipeline.

    python -m jejak.cli init                 # create the database
    python -m jejak.cli ingest               # pull RSS -> articles
    python -m jejak.cli fetch                # backfill full article bodies
    python -m jejak.cli cluster              # articles -> events
    python -m jejak.cli summarize            # grounded drafts for new events
    python -m jejak.cli review               # list events awaiting approval
    python -m jejak.cli sentiment            # public-reaction scores for approved events
    python -m jejak.cli buzzer               # coordinated-engagement detection
    python -m jejak.cli approve <event_id>
    python -m jejak.cli reject  <event_id>
    python -m jejak.cli timeline <figure_id> # approved, publishable events
    python -m jejak.cli youtube-ingest       # search YouTube + fetch transcripts
    python -m jejak.cli translate            # auto-translate non-ID articles
    python -m jejak.cli run                  # ingest + fetch + translate + cluster + summarize [+ sentiment + buzzer]
"""
from __future__ import annotations

import argparse
import os
import sys

import re

from . import cluster as cluster_mod
from . import buzzer as buzzer_mod
from . import db, fetch, ingest, review, sentiment, summarize, translate
from . import youtube_ingest

_BULAN = [
    "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
]


def _fmt_date(raw: str | None) -> str:
    if not raw:
        return ""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if not m:
        return raw
    y, mo, d = m.group(1), int(m.group(2)), int(m.group(3))
    label = f"{d} {_BULAN[mo]} {y}"
    if "T" in raw:
        t = raw.split("T")[1].split("+")[0].split("Z")[0]
        if t.endswith(":00"):
            t = t[:-3]
        label += f" {t[:5]}"
    return label


def _print_review_row(r: dict) -> None:
    flag = "  ⚠ SINGLE SOURCE" if r["single_source"] else ""
    print(f"[{r['event_id']}] {_fmt_date(r['event_date'])}  "
          f"corroboration={r['corroboration']} citations={r['n_citations']}{flag}")
    print(f"    {r['summary'][:200]}{'…' if len(r['summary']) > 200 else ''}")


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(prog="jejak")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("ingest")
    sub.add_parser("fetch")
    sub.add_parser("cluster")
    sub.add_parser("summarize")
    sub.add_parser("review")
    sub.add_parser("sentiment")
    sub.add_parser("buzzer")
    sub.add_parser("translate")
    sub.add_parser("run")
    sub.add_parser("youtube-ingest")
    p_app = sub.add_parser("approve"); p_app.add_argument("event_id", type=int)
    p_rej = sub.add_parser("reject");  p_rej.add_argument("event_id", type=int)
    p_tl = sub.add_parser("timeline"); p_tl.add_argument("figure_id")

    args = parser.parse_args(argv)

    if args.cmd == "init":
        db.init_db()
        print(f"initialised {db.DEFAULT_DB}")
        return 0

    conn = db.connect()
    conn.executescript(db.SCHEMA)
    db.migrate(conn)
    try:
        if args.cmd in ("ingest", "run"):
            print("ingest:", ingest.ingest(conn))
        if args.cmd == "youtube-ingest":
            print("youtube-ingest:", youtube_ingest.ingest_youtube(conn))
            print("ingest:", ingest.ingest(conn))
        if args.cmd in ("fetch", "run"):
            print("fetch:", fetch.fetch_bodies(conn))
        if args.cmd in ("translate", "run"):
            print("translate:", translate.translate_articles(conn))
        if args.cmd == "run" and os.environ.get("YOUTUBE_API_KEY"):
            print("youtube-ingest:", youtube_ingest.ingest_youtube(conn))
        if args.cmd in ("cluster", "run"):
            print("cluster:", cluster_mod.cluster(conn))
        if args.cmd in ("summarize", "run"):
            for res in summarize.summarize_pending(conn):
                print("summarized:", res)
        if args.cmd == "review":
            rows = review.queue(conn)
            if not rows:
                print("review queue empty.")
            for r in rows:
                _print_review_row(r)
        if args.cmd in ("sentiment", "run"):
            results = sentiment.sentiment_pending(conn)
            if not results:
                print("no approved events need sentiment.")
            for res in results:
                note = res.get("note")
                score = res.get("score")
                score_str = f"{score:+.2f}" if score is not None else "?"
                n = res.get("sample_size", 0)
                flag = f"  ⚠ {note}" if note else ""
                print(f"sentiment [{res.get('channel','?')}]: "
                      f"{res.get('label','?')} "
                      f"(score={score_str}, "
                      f"n={n}){flag}")
        if args.cmd in ("buzzer", "run"):
            results = buzzer_mod.analyze_all(conn)
            if not results:
                print("no events need buzzer analysis.")
            for r in results:
                sigs = r["signals_triggered"]
                sig_str = ",".join(sigs) if sigs else "none"
                print(f"buzzer [{r['event_id']}]: "
                      f"score={r['anomaly_score']:.3f} "
                      f"anomaly={r['anomaly_pct']:.1f}% "
                      f"signals=[{sig_str}]")
        if args.cmd == "approve":
            review.approve(conn, args.event_id)
            print(f"event {args.event_id} approved")
        if args.cmd == "reject":
            review.reject(conn, args.event_id)
            print(f"event {args.event_id} rejected")
        if args.cmd == "timeline":
            for ev in review.timeline(conn, args.figure_id):
                print(f"\n● {_fmt_date(ev['date'])}  (corroborated by {ev['corroboration']} outlet/s)")
                print(f"  {ev['summary']}")
                if ev["sentiment"]:
                    s = ev["sentiment"]
                    print(f"  ↳ {s['channel']}: {s['label']} "
                          f"(score {s['score']:+.2f}, n={s['sample_size']})")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
