"""Learn from /kurasi verdicts: report on them, suggest, and (when proven) auto-hide.

Every verdict a curator gives in /kurasi carries reasons (curation.ts
REASONS); scripts/apply_curation.py mirrors them into `curation_labels`. This
module turns them into three things, each gated on the one before:

  report    what the labels say: which reasons, for which figures, on what
            kind of coverage. Read by a person (or Claude) to propose filter
            rules for the extractor — nothing here changes the pipeline.
  suggest   for each event nobody has ruled on, the reason a curator would
            most likely take it down for, by similarity to labelled events
            (nearest neighbours over the clustering embeddings). Shown in
            /kurasi as "Saran"; the curator still decides.
  auto-hide a suggestion confident enough, for a reason whose suggestions
            have proven precise on the labels themselves (leave-one-out),
            takes the event off the public site until a curator rules on
            it. Off unless JEJAK_AUTO_HIDE=1, and inert until the numbers
            clear AUTO_MIN_PRECISION over AUTO_MIN_PREDICTIONS.

Neighbours, not a trained classifier: with tens of labels a classifier is
noise, while "like these 12 you took down" is both usable from the first
handful and checkable by the curator, who can open the 12.

    python -m jejak.cli curation-report
    python -m jejak.cli suggest [--auto-hide]
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

# In step with REASONS in web/src/lib/curation.ts.
REASONS = {
    "wrong_person": "Salah orang",
    "not_their_action": "Bukan tindakan tokoh",
    "trivial": "Remeh / seremonial",
    "not_newsworthy": "Tak relevan untuk rekam jejak",
    "duplicate": "Duplikat",
    "mixed": "Campuran beberapa kejadian",
    "hoax": "Hoaks / sudah dibantah",
    "garbled": "Judul/ringkasan rusak",
    "other": "Lainnya",
}
# Similar coverage says nothing about these: a duplicate is a duplicate of one
# particular event, a mixed event is a clustering slip in that one cluster
# (labelled for the clustering, not for this model), and "other" is whatever
# the note says.
UNSUGGESTABLE = {"duplicate", "mixed", "other"}

MODEL = "knn-v1"
PUBLIC = "status IN ('new', 'summarized', 'approved')"

MIN_LABELS = 20          # labelled events of a kind before suggesting for it
K = 15                   # neighbours consulted
MIN_SIM = 0.55           # below this a labelled event is not "like" this one
SAME_FIGURE_BOOST = 1.25 # a record of the same figure counts for more
PRIOR = 1.0              # pseudo-weight of one "keep", so 3 of 3 is not 100%
SUGGEST_AT = 0.5         # confidence needed to show a suggestion
MIN_SUPPORT = 3          # neighbours that share the reason
AUTO_HIDE_AT = 0.85      # confidence needed to auto-hide
AUTO_MIN_PREDICTIONS = 25
AUTO_MIN_PRECISION = 0.95


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Label:
    event_id: int
    verdict: str
    reasons: list[str]
    note: str | None
    kind: str | None
    figure_id: str | None
    title: str | None
    summary: str | None
    outlets: int | None
    suggested: str | None


@dataclass
class Suggestion:
    reason: str
    confidence: float
    support: int
    examples: list[int] = field(default_factory=list)


def load_labels(conn: sqlite3.Connection) -> list[Label]:
    rows = conn.execute(
        "SELECT event_id, verdict, reasons, note, kind, figure_id, title, summary, "
        "outlets, suggested FROM curation_labels ORDER BY decided_at"
    ).fetchall()
    out = []
    for r in rows:
        try:
            reasons = [x for x in json.loads(r["reasons"] or "[]") if x in REASONS]
        except ValueError:
            reasons = []
        out.append(Label(
            r["event_id"], r["verdict"], reasons, r["note"], r["kind"], r["figure_id"],
            r["title"], r["summary"], r["outlets"], r["suggested"],
        ))
    return out


# ---------------------------------------------------------------------------
# Vectors


def event_vectors(conn: sqlite3.Connection, event_ids: set[int] | None = None) -> dict[int, "np.ndarray"]:
    """Mean of each event's cached article embeddings, L2-normalised.

    Only the cache: clustering already embedded every article it placed, and
    loading the model here for the rest would make this stage as slow as that
    one. An event with no cached vector is simply not scored.
    """
    import numpy as np

    sums: dict[int, np.ndarray] = {}
    for event_id, vec in conn.execute(
        "SELECT a.event_id, ae.vec FROM articles a "
        "JOIN article_embeddings ae ON ae.article_id = a.id "
        "WHERE a.event_id IS NOT NULL"
    ):
        if event_ids is not None and event_id not in event_ids:
            continue
        v = np.frombuffer(vec, dtype=np.float32)
        if event_id in sums:
            sums[event_id] = sums[event_id] + v
        else:
            sums[event_id] = v.copy()
    out = {}
    for event_id, s in sums.items():
        n = float(np.linalg.norm(s))
        if n > 0:
            out[event_id] = s / n
    return out


def _label_vectors(conn: sqlite3.Connection, labels: list[Label], embed_missing: bool) -> dict[int, "np.ndarray"]:
    """Vectors for the labelled events, from the snapshot text where the event is gone."""
    vecs = event_vectors(conn, {l.event_id for l in labels})
    if embed_missing:
        missing = [l for l in labels if l.event_id not in vecs and (l.title or l.summary)]
        if missing:
            from .embed import embed

            for l in missing:
                vecs[l.event_id] = embed("\n".join(x for x in (l.title, l.summary) if x))
    return vecs


# ---------------------------------------------------------------------------
# Neighbours


class Index:
    """The labelled events of one kind, as a matrix to take dot products against."""

    def __init__(self, labels: list[Label], vecs: dict[int, "np.ndarray"]):
        import numpy as np

        self.labels = [l for l in labels if l.event_id in vecs]
        self.matrix = (
            np.stack([vecs[l.event_id] for l in self.labels])
            if self.labels else np.zeros((0, 1), dtype=np.float32)
        )

    def __len__(self) -> int:
        return len(self.labels)

    def suggest(self, vec: "np.ndarray", figure_id: str | None, exclude: int | None = None) -> Suggestion | None:
        import numpy as np

        if not self.labels:
            return None
        sims = self.matrix @ vec
        order = np.argsort(-sims)
        weights: list[tuple[float, Label]] = []
        for i in order:
            if len(weights) >= K or sims[i] < MIN_SIM:
                break
            lab = self.labels[i]
            if lab.event_id == exclude:
                continue
            w = float(sims[i]) * (SAME_FIGURE_BOOST if figure_id and lab.figure_id == figure_id else 1.0)
            weights.append((w, lab))
        if not weights:
            return None
        total = sum(w for w, _ in weights) + PRIOR
        rejected = sum(w for w, l in weights if l.verdict == "rejected")
        if rejected / total < 0.5:
            return None
        by_reason: dict[str, list[tuple[float, Label]]] = defaultdict(list)
        for w, l in weights:
            if l.verdict == "rejected":
                for r in l.reasons:
                    if r not in UNSUGGESTABLE:
                        by_reason[r].append((w, l))
        if not by_reason:
            return None
        reason, hits = max(by_reason.items(), key=lambda kv: sum(w for w, _ in kv[1]))
        confidence = sum(w for w, _ in hits) / total
        if confidence < SUGGEST_AT or len(hits) < MIN_SUPPORT:
            return None
        return Suggestion(reason, round(confidence, 3), len(hits), [l.event_id for _, l in hits])


# ---------------------------------------------------------------------------
# Evaluation


@dataclass
class ReasonStats:
    suggested: int = 0          # leave-one-out suggestions of this reason
    were_rejected: int = 0      # ... where the curator did take it down
    same_reason: int = 0        # ... for this reason
    auto: int = 0               # ... at or above AUTO_HIDE_AT
    auto_rejected: int = 0

    @property
    def precision(self) -> float | None:
        return self.were_rejected / self.suggested if self.suggested else None

    @property
    def auto_precision(self) -> float | None:
        return self.auto_rejected / self.auto if self.auto else None

    @property
    def auto_eligible(self) -> bool:
        p = self.auto_precision
        return self.auto >= AUTO_MIN_PREDICTIONS and p is not None and p >= AUTO_MIN_PRECISION


def evaluate(indexes: dict[str, Index], vecs: dict[int, "np.ndarray"]) -> dict[str, ReasonStats]:
    """Leave-one-out: suggest for each labelled event from all the others.

    This is the only evidence auto-hide is allowed to act on. Precision counts
    a suggestion as right when the curator took the event down at all — the
    harm auto-hide can do is hiding something that should be up, whatever the
    reason given.
    """
    stats: dict[str, ReasonStats] = defaultdict(ReasonStats)
    for kind, index in indexes.items():
        if len(index) < MIN_LABELS:
            continue
        for lab in index.labels:
            s = index.suggest(vecs[lab.event_id], lab.figure_id, exclude=lab.event_id)
            if s is None:
                continue
            st = stats[s.reason]
            st.suggested += 1
            hit = lab.verdict == "rejected"
            st.were_rejected += hit
            st.same_reason += hit and s.reason in lab.reasons
            if s.confidence >= AUTO_HIDE_AT:
                st.auto += 1
                st.auto_rejected += hit
    return dict(stats)


# ---------------------------------------------------------------------------
# The stage


def _indexes(labels: list[Label], vecs) -> dict[str, Index]:
    by_kind: dict[str, list[Label]] = defaultdict(list)
    for l in labels:
        by_kind[l.kind or "record"].append(l)
    return {kind: Index(ls, vecs) for kind, ls in by_kind.items()}


def run(conn: sqlite3.Connection, auto_hide: bool | None = None) -> dict[str, int]:
    """Score every public event nobody has ruled on; write curation_suggestions.

    Rows are upserted, and an event that no longer earns a suggestion has its
    row blanked rather than deleted: push only upserts, so a deleted row would
    leave the stale suggestion (and any auto-hide) standing in Neon.
    """
    if auto_hide is None:
        auto_hide = os.environ.get("JEJAK_AUTO_HIDE") == "1"
    labels = load_labels(conn)
    vecs = _label_vectors(conn, labels, embed_missing=True)
    indexes = _indexes(labels, vecs)
    stats = evaluate(indexes, vecs)
    eligible = {r for r, st in stats.items() if st.auto_eligible} if auto_hide else set()

    labelled = {l.event_id for l in labels}
    events = conn.execute(
        f"SELECT id, kind, figure_id FROM events WHERE {PUBLIC}"
    ).fetchall()
    todo = {r["id"]: r for r in events if r["id"] not in labelled}
    event_vecs = event_vectors(conn, set(todo))
    existing = {r[0] for r in conn.execute("SELECT event_id FROM curation_suggestions")}

    now = _now()
    counts = Counter()
    for event_id, ev in todo.items():
        index = indexes.get(ev["kind"])
        s = None
        if index is not None and len(index) >= MIN_LABELS and event_id in event_vecs:
            s = index.suggest(event_vecs[event_id], ev["figure_id"])
        if s is None:
            if event_id in existing:
                conn.execute(
                    "UPDATE curation_suggestions SET reason = NULL, confidence = NULL, "
                    "support = 0, examples = '[]', auto_hide = 0, model = ?, scored_at = ? "
                    "WHERE event_id = ? AND (reason IS NOT NULL OR auto_hide = 1)",
                    (MODEL, now, event_id),
                )
            continue
        hide = int(s.reason in eligible and s.confidence >= AUTO_HIDE_AT)
        conn.execute(
            """INSERT INTO curation_suggestions
                   (event_id, reason, confidence, support, examples, auto_hide, model, scored_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (event_id) DO UPDATE SET
                   reason = excluded.reason, confidence = excluded.confidence,
                   support = excluded.support, examples = excluded.examples,
                   auto_hide = excluded.auto_hide, model = excluded.model,
                   scored_at = excluded.scored_at""",
            (event_id, s.reason, s.confidence, s.support, json.dumps(s.examples[:10]),
             hide, MODEL, now),
        )
        counts["suggested"] += 1
        counts["auto_hidden"] += hide

    # The model's standing, for /kurasi to say why it is or is not suggesting.
    state = {
        "model": MODEL,
        "labels": {k: len(v) for k, v in indexes.items()},
        "min_labels": MIN_LABELS,
        "auto_hide_enabled": bool(auto_hide),
        "reasons": {
            r: {"suggested": st.suggested, "precision": st.precision,
                "auto": st.auto, "auto_precision": st.auto_precision,
                "auto_eligible": st.auto_eligible}
            for r, st in stats.items()
        },
        "scored_at": now,
    }
    conn.execute(
        "INSERT INTO pipeline_state (key, value, updated_at) VALUES ('curation_model', ?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (json.dumps(state), now),
    )
    conn.commit()
    counts["labels"] = len(labels)
    counts["scored"] = len(todo)
    return dict(counts)


# ---------------------------------------------------------------------------
# Report

_WORD = re.compile(r"[a-zA-ZÀ-ɏ]{4,}")
_STOP = set("""yang dengan untuk dari dalam akan pada tidak juga atau sudah karena kata
bahwa oleh saat setelah masih para lebih belum hingga agar bisa harus jadi
menjadi terkait soal usai jelang antara sebut minta tegaskan ungkap""".split())


def _words(text: str | None) -> set[str]:
    return {w.lower() for w in _WORD.findall(text or "")} - _STOP


def report(conn: sqlite3.Connection) -> str:
    labels = load_labels(conn)
    if not labels:
        return ("No curation labels yet. Verdicts given in /kurasi reach this copy\n"
                "through scripts/apply_curation.py.")
    lines: list[str] = []
    out = lines.append

    kept = [l for l in labels if l.verdict == "kept"]
    rej = [l for l in labels if l.verdict == "rejected"]
    out(f"{len(labels)} labelled events: {len(rej)} taken down, {len(kept)} kept")
    for kind in sorted({l.kind or "record" for l in labels}):
        n = sum(1 for l in labels if (l.kind or "record") == kind)
        out(f"  {kind}: {n} (suggestions start at {MIN_LABELS})")

    # Event-level features from the working copy, where the event still exists.
    ids = [l.event_id for l in labels]
    types = dict(conn.execute(
        f"SELECT id, event_type FROM events WHERE id IN ({','.join('?' * len(ids))})", ids
    ).fetchall()) if ids else {}

    kept_words = Counter(w for l in kept for w in _words(l.title))
    out("\n== by reason")
    by_reason: dict[str, list[Label]] = defaultdict(list)
    for l in rej:
        for r in l.reasons or ["(none)"]:
            by_reason[r].append(l)
    for reason, ls in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        single = sum(1 for l in ls if (l.outlets or 0) <= 1)
        out(f"\n{REASONS.get(reason, reason)} [{reason}]: {len(ls)}"
            f" ({len(ls) / len(rej):.0%} of takedowns), single-source {single}/{len(ls)}")
        figs = Counter(l.figure_id or "(peristiwa)" for l in ls).most_common(5)
        out("  figures: " + ", ".join(f"{f} {n}" for f, n in figs))
        ets = Counter(types.get(l.event_id) or "?" for l in ls).most_common(5)
        out("  event types: " + ", ".join(f"{t} {n}" for t, n in ets))
        # Title words common here and rare among kept events: rule material.
        words = Counter(w for l in ls for w in _words(l.title))
        marked = [
            (w, n) for w, n in words.most_common(60)
            if n >= 2 and n / len(ls) > 2 * (kept_words[w] + 1) / (len(kept) + 1)
        ][:10]
        if marked:
            out("  title words: " + ", ".join(f"{w} {n}" for w, n in marked))
        for l in ls[-3:]:
            out(f"  e.g. #{l.event_id} {(l.title or '')[:90]}")

    notes = [l for l in labels if l.note]
    if notes:
        out("\n== notes (latest 15)")
        for l in notes[-15:]:
            out(f"  #{l.event_id} [{l.verdict}: {', '.join(l.reasons) or '-'}] {l.note}")

    if kept:
        single_kept = sum(1 for l in kept if (l.outlets or 0) <= 1)
        single_rej = sum(1 for l in rej if (l.outlets or 0) <= 1)
        out("\n== single-source share")
        out(f"  taken down {single_rej}/{len(rej) or 1}, kept {single_kept}/{len(kept)}")

    shown = [l for l in labels if l.suggested]
    if shown:
        agreed = sum(1 for l in shown if l.verdict == "rejected" and l.suggested in l.reasons)
        down = sum(1 for l in shown if l.verdict == "rejected")
        out("\n== suggestions the curator saw")
        out(f"  {len(shown)} decided with a suggestion showing: {down} taken down, "
            f"{agreed} for the suggested reason, {len(shown) - down} kept anyway")

    vecs = _label_vectors(conn, labels, embed_missing=True)
    stats = evaluate(_indexes(labels, vecs), vecs)
    out("\n== leave-one-out (what auto-hide would be judged on)")
    if not stats:
        out(f"  not enough labels to evaluate (needs {MIN_LABELS} of a kind with cached vectors)")
    for r, st in sorted(stats.items(), key=lambda kv: -kv[1].suggested):
        p = f"{st.precision:.0%}" if st.precision is not None else "-"
        ap = f"{st.auto_precision:.0%}" if st.auto_precision is not None else "-"
        out(f"  {r}: suggested {st.suggested}, precision {p}, same reason {st.same_reason}; "
            f"at >={AUTO_HIDE_AT:.0%}: {st.auto} ({ap})"
            + ("  -> auto-hide eligible" if st.auto_eligible else ""))
    out(f"\nAuto-hide needs {AUTO_MIN_PREDICTIONS}+ predictions at >= {AUTO_HIDE_AT:.0%} "
        f"with {AUTO_MIN_PRECISION:.0%}+ precision, and JEJAK_AUTO_HIDE=1.")
    return "\n".join(lines)
