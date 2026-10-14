"""Stance toward the figure, from the comments that name them.

The sentiment stage asks the model for one stance per comment "toward the
figure/event", and the record page printed the mean as the public's view of the
figure. Under a video of Erick Thohir praising the national team most of the
hundred comments praised the players, and they were counted as approval of him.

Asking the local model which of the two a comment is about did not work.
qwen2.5:7b put 59 of 100 comments on event 23270 in "about the figure",
including comments about the coach, the president and the supporters, and when
a comment named no one it assumed the person in the video. Comments that do
not name the figure turned out to be about them only a third of the time.

So whether a comment is about the figure is decided here in code: the comment
has to name them. A name token of five or more letters matches within one
edit ("Tohir", "Erik"), a four-letter token matches exactly, and the initials
match as a word ("ET"). Only those comments go to the model, which is then
asked one narrow question: the stance toward this person, not toward the event.
On the three records checked by hand (23270, 21816, 15808) nearly every
comment this admits was about the figure.

What it gives up: unnamed address ("Keren pak", "semangat pa boz") is not
counted, so the samples are small, often ten or twenty comments where the
event has a hundred. The page shows the figure's line only above a minimum
count and says what it counts.
"""
from __future__ import annotations

import re
import sqlite3
from collections import Counter

from . import sentiment
from .config import Figure, load_figures

_SYSTEM = """Each comment below was posted under a news video: {event}
Every comment names {name} ({role}).

For each comment, give its stance toward {name} personally — not toward the
event, the other people in it, institutions, or the outcome.
- positive: praises, thanks, defends or supports {name}
- negative: criticises, mocks, insinuates against, accuses or questions {name}
  (sarcasm counts; "X is great, unlike some people" style jabs count; demands
  that {name} be arrested, sacked or investigated count)
- neutral: mentions {name} without judging them, or judges only others

Answer one line per comment, in order, exactly like:
1. positive
2. neutral"""

_STANCES = ("positive", "neutral", "negative")

# Words that turn up in figure names and aliases but name no one: titles,
# institutions, places, and ordinary words that happen to be names ("putra" is
# also "son", "agung" also "great"). Read off the matches the stored comments
# produced, not guessed — see audit() below.
_NOT_A_NAME = {
    "presiden", "bangsa", "masyarakat", "partai", "pajak", "merdeka", "istana",
    "gerindra", "golkar", "danantara", "bappenas", "basarnas", "kemendag",
    "kemenag", "imipas", "kumham", "komjen", "polisi", "mahkamah", "agung",
    "konstitusi", "deputi", "bidang", "protokol", "kantor", "wilayah",
    "kelompok", "tani", "rukun", "tetangga", "harian", "bank", "mandiri",
    "haji", "akademik", "prof", "unsoed", "committee", "steering",
    "organizing", "munas", "konbes", "buruh", "ulama", "selatan", "tambun",
    "belarus", "lebong", "cukai", "york", "timor", "leste", "jaya", "field",
    "putra", "surya", "teguh", "iman", "tutup", "said", "john", "laos",
    "wong", "paris", "indra", "arya", "raka", "hadi", "lalu", "taspen",
    # Prabowo's aliases include his son's name, and "didit" is one edit from
    # "dikit" (a little).
    "didit",
}

# Two-letter words that are common in comments and also a figure's initials.
_COMMON_SHORT = {
    "di", "ke", "yg", "dg", "tp", "sm", "dr", "ga", "gk", "aj", "sy", "ri",
    "pa", "ya", "ni", "tu", "lu", "gw", "km", "kl", "jd", "bs", "dn", "sd",
    "aa", "ok", "ad", "an", "as", "at", "be", "by", "do", "go", "he", "if",
    "in", "is", "it", "me", "my", "no", "of", "on", "or", "so", "to", "up",
    "us", "we", "pt", "ps", "mk", "ma", "ka", "ta", "da", "la", "sa", "si",
    "nu",  # Nahdlatul Ulama, not Nasaruddin Umar
}


def _within_one_edit(a: str, b: str) -> bool:
    if abs(len(a) - len(b)) > 1:
        return False
    if a == b:
        return True
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    short, long_ = (a, b) if len(a) < len(b) else (b, a)
    return any(long_[:i] + long_[i + 1:] == short for i in range(len(long_)))


def _tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


class FigureNamer:
    """Does a comment name this figure?

    Alias tokens that belong to another tracked figure's own name are dropped:
    Prabowo's aliases include "Listyo Sigit Prabowo" and "Prabowo
    Subianto-Gibran Rakabuming", which would otherwise count every comment
    about Gibran or the police chief as naming Prabowo.
    """

    def __init__(self, fig: Figure, others: list[Figure]):
        self.figure = fig
        own = {t for t in _tokens(fig.name)}
        elsewhere = {t for o in others if o.id != fig.id for t in _tokens(o.name)}
        names = {t for n in [fig.name, *fig.aliases] for t in _tokens(n)}
        self.tokens = {
            t for t in names
            if len(t) >= 4 and t not in _NOT_A_NAME
            and (t in own or t not in elsewhere)
        }
        words = fig.name.lower().split()
        initials = "".join(w[0] for w in words) if len(words) >= 2 else ""
        self.initials = initials if initials not in _COMMON_SHORT else ""

    def match(self, text: str) -> str | None:
        """The word in `text` that names the figure, or None."""
        for w in _tokens(text):
            if self.initials and w == self.initials:
                return w
            if len(w) < 4:
                continue
            for t in self.tokens:
                if w == t or (len(t) >= 5 and _within_one_edit(w, t)):
                    return w
        return None


def _namers(conn: sqlite3.Connection) -> dict[str, FigureNamer]:
    figures = load_figures(conn)
    return {f.id: FigureNamer(f, figures) for f in figures}


def classify(fig: Figure, event_title: str, texts: list[str]) -> list[str | None]:
    """Stance toward `fig` for comments already known to name them."""
    system = _SYSTEM.format(event=f"{fig.name}: {event_title}", name=fig.name,
                            role=fig.role or "a public figure")
    labels: list[str | None] = []
    for i in range(0, len(texts), sentiment._BATCH):
        labels.extend(_classify_batch(system, texts[i:i + sentiment._BATCH]))
    return labels


def _classify_batch(system: str, batch: list[str]) -> list[str | None]:
    """One batch, halved when the model miscounts — as sentiment does."""
    if not batch:
        return []
    numbered = "\n".join(f"{i+1}. {' '.join(c.split())}" for i, c in enumerate(batch))
    result = sentiment._ollama_chat(
        [{"role": "system", "content": system},
         {"role": "user", "content": f"Classify these {len(batch)} comments:\n\n{numbered}"}],
        temperature=0,
    )
    text = result.get("message", {}).get("content", "")
    labels = [m.group(1) for line in text.lower().splitlines()
              if (m := re.match(r"\s*\d+[.)]\s*\"?(positive|neutral|negative)", line))]
    if len(labels) == len(batch):
        return labels
    if len(batch) == 1:
        return [None]
    mid = len(batch) // 2
    return _classify_batch(system, batch[:mid]) + _classify_batch(system, batch[mid:])


def label_event(conn: sqlite3.Connection, event_id: int,
                namers: dict[str, FigureNamer] | None = None) -> dict:
    """Fill mentions_figure and figure_stance for an event's unchecked comments.

    Events with no figure (peristiwa) are skipped: there is no one to name.
    """
    ev = conn.execute("SELECT title, figure_id FROM events WHERE id = ?",
                      (event_id,)).fetchone()
    if not ev or not ev["figure_id"]:
        return {"event_id": event_id, "note": "no figure"}
    namers = namers or _namers(conn)
    namer = namers.get(ev["figure_id"])
    if namer is None:
        return {"event_id": event_id, "note": f"figure {ev['figure_id']} not tracked"}
    fig = namer.figure

    rows = conn.execute(
        """SELECT id, text FROM comments
            WHERE event_id = ? AND mentions_figure IS NULL ORDER BY id""",
        (event_id,),
    ).fetchall()
    named = [r for r in rows if namer.match(r["text"])]
    labels = classify(fig, ev["title"] or "", [r["text"] for r in named]) if named else []
    stance = {r["id"]: l for r, l in zip(named, labels)}

    for r in rows:
        is_named = r["id"] in stance
        # A named comment the model could not label stays unchecked, so the
        # next run retries it instead of recording it as not naming the figure.
        if is_named and stance[r["id"]] is None:
            continue
        conn.execute(
            "UPDATE comments SET mentions_figure = ?, figure_stance = ? WHERE id = ?",
            (1 if is_named else 0, stance.get(r["id"]), r["id"]),
        )
    conn.commit()
    dist = Counter(l for l in labels if l)
    return {"event_id": event_id, "figure_id": ev["figure_id"],
            "checked": len(rows), "named": len(named), **dist}


def label_pending(conn: sqlite3.Connection, limit: int | None = None) -> list[dict]:
    """Every figure record that has comments not yet checked for a name."""
    ids = [r["event_id"] for r in conn.execute(
        """SELECT c.event_id FROM comments c JOIN events e ON e.id = c.event_id
            WHERE c.mentions_figure IS NULL AND e.figure_id IS NOT NULL
            GROUP BY c.event_id ORDER BY max(e.event_date) DESC"""
    ).fetchall()]
    if limit:
        ids = ids[:limit]
    namers = _namers(conn)
    return [label_event(conn, eid, namers) for eid in ids]


def audit(conn: sqlite3.Connection, top: int = 15) -> None:
    """Print which words matched each figure, most frequent first.

    The check for _NOT_A_NAME: a word that matches across many unrelated
    records ("presiden", "putra") is not naming anyone.
    """
    namers = _namers(conn)
    hits: dict[str, Counter] = {}
    for r in conn.execute(
        """SELECT e.figure_id, c.text FROM comments c JOIN events e ON e.id = c.event_id
            WHERE e.figure_id IS NOT NULL"""):
        namer = namers.get(r["figure_id"])
        w = namer.match(r["text"]) if namer else None
        if w:
            hits.setdefault(r["figure_id"], Counter())[w] += 1
    for fid, c in sorted(hits.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"{fid:<28} {sum(c.values()):>4}  {c.most_common(top)}")
