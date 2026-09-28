"""Command-line orchestration for the pipeline.

    python -m jejak.cli init                 # create the database
    python -m jejak.cli ingest               # pull RSS -> articles
    python -m jejak.cli backfill             # walk outlet archives backwards
    python -m jejak.cli fetch                # backfill full article bodies
    python -m jejak.cli mentions             # discover figures from coverage
    python -m jejak.cli cluster              # articles -> events
    python -m jejak.cli summarize            # grounded drafts for new events
    python -m jejak.cli sentiment            # public-reaction scores for approved events
    python -m jejak.cli buzzer               # coordinated-engagement detection
    python -m jejak.cli timeline <figure_id> # approved, publishable events

Taking an event off the public site is not done here — that is `/kurasi` in the
deployed web app, which writes `events.curated` straight to Postgres.
    python -m jejak.cli youtube-ingest       # search YouTube + fetch transcripts
    python -m jejak.cli translate            # auto-translate non-ID articles
    python -m jejak.cli run                  # ingest + backfill + fetch + translate + mentions + cluster + summarize [+ sentiment + buzzer]
"""
from __future__ import annotations

import argparse
import os
import sys

import re

from datetime import date

from . import backfill as backfill_mod
from . import cluster as cluster_mod
from . import buzzer as buzzer_mod
from . import db, fetch, ingest, mentions, quotes, sentiment, summarize, timeline as timeline_mod
from . import translate
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


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(prog="jejak")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("ingest")
    p_fetch = sub.add_parser("fetch")
    p_fetch.add_argument("--limit", type=int, default=50,
                         help="how many article bodies to fetch (default 50). "
                              "Raise it when backfill is adding history faster "
                              "than the default drains the queue.")
    p_ment = sub.add_parser("mentions")
    p_ment.add_argument("--limit", type=int, default=500,
                        help="how many unscanned articles to mine (default 500)")
    p_ment.add_argument("--reattribute", action="store_true",
                        help="also re-run attribution over EVERY article, not "
                             "just the unclustered ones. Rebuilds affected "
                             "events and deletes the summaries of any that end "
                             "up empty — a repair tool, not part of a run.")
    p_ment.add_argument("--gains-only", action="store_true",
                        help="with --reattribute: hand history to newly "
                             "discovered figures, but leave an article whose "
                             "owner the current rule no longer claims where it "
                             "is. Adds records without taking published ones "
                             "apart.")
    sub.add_parser("cluster")
    sub.add_parser("summarize")
    sub.add_parser("quotes")
    sub.add_parser("sentiment")
    sub.add_parser("buzzer")
    sub.add_parser("translate")
    sub.add_parser("run")
    p_bf = sub.add_parser("backfill")
    p_bf.add_argument("--days", type=int, default=1,
                      help="how many further days of archive to walk (default 1)")
    p_bf.add_argument("--until", type=date.fromisoformat,
                      default=backfill_mod.DEFAULT_FLOOR,
                      help="oldest date to walk back to, YYYY-MM-DD")
    p_bf.add_argument("--general", action="store_true",
                      help="also keep articles that name no tracked figure "
                           "(peristiwa material; far more rows)")
    sub.add_parser("youtube-ingest")
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
        if args.cmd in ("backfill", "run"):
            print("backfill:", backfill_mod.backfill(
                conn,
                days=getattr(args, "days", 1),
                floor=getattr(args, "until", backfill_mod.DEFAULT_FLOOR),
                general=getattr(args, "general", False),
            ))
        if args.cmd == "youtube-ingest":
            print("youtube-ingest:", youtube_ingest.ingest_youtube(conn))
            print("ingest:", ingest.ingest(conn))
        if args.cmd in ("fetch", "run"):
            print("fetch:", fetch.fetch_bodies(conn, limit=getattr(args, "limit", 50)))
        if args.cmd in ("translate", "run"):
            print("translate:", translate.translate_articles(conn))
        if args.cmd == "run" and os.environ.get("YOUTUBE_API_KEY"):
            print("youtube-ingest:", youtube_ingest.ingest_youtube(conn))
        if args.cmd in ("mentions", "run"):
            # Discovery of new figures from the coverage itself. Runs before
            # clustering so a figure promoted this run can own articles that
            # are about to be clustered — attribution happened at ingest time,
            # under the older roster, so the unclustered ones are re-checked.
            stats = mentions.record_mentions(
                conn, limit=getattr(args, "limit", 500))
            print("mentions:", stats)
            if stats.get("promoted") or getattr(args, "reattribute", False):
                print("reattribute:", ingest.reattribute(
                    conn,
                    only_unclustered=not getattr(args, "reattribute", False),
                    gains_only=getattr(args, "gains_only", False),
                ))
        if args.cmd in ("cluster", "run"):
            print("cluster:", cluster_mod.cluster(conn))
        if args.cmd in ("quotes", "run"):
            print("quotes:", quotes.quote_pending(conn))
        if args.cmd in ("summarize", "run"):
            try:
                for res in summarize.summarize_pending(conn):
                    print("summarized:", res)
            except RuntimeError as e:
                print(f"skip summarize: {e}")
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
        if args.cmd == "timeline":
            for ev in timeline_mod.for_figure(conn, args.figure_id):
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
