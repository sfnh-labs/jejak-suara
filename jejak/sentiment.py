"""Stage 5 — Public-reaction sentiment (lower-cost channel).

For an event, gather public comments from YouTube news videos and classify each
one's stance toward the figure/event. Classification uses a local Ollama model.

IMPORTANT framing: this measures *public reaction on one platform*, not truth and
not a verdict. It is brigadable and platform-skewed. Always surface it labelled
as "public reaction (YouTube)" with the sample size — never as judgement.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from . import anonymize, reddit, relevance, youtube

CHANNEL = "social"

OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

# Stance toward the event, not the people in it. It used to ask for the stance
# "toward the figure/event" at once, without saying what the event was, so
# under a minister praising the national team the players' fans counted as
# approval of the minister. Stance toward the figure is its own question
# (jejak/figure_stance.py), asked only of comments that name them.
_SYSTEM = """Each comment below was posted under a news video about this event:
{event}

For each comment, give its stance toward the EVENT itself — what was done,
decided, announced or happened, and how it was handled — not toward any
person in it.
- "positive": approves of, welcomes or supports it
- "negative": disapproves of, criticises, rejects or mocks it, or is angry
  about how it was handled
- "neutral": factual, a question, prayers or condolences, off-topic, or a
  judgement of a person only (praising or abusing someone is not a stance on
  the event)

Return labels in the SAME ORDER as the numbered comments."""

# With a figure in the event, one label was not enough: on the first records
# relabelled, 82% of the comments that judged the figure had that judgement
# copied into the event label. Asking for both labels side by side brought it
# to 25%; the person label is only there to take that judgement and is
# discarded (the figure's own stance comes from jejak/figure_stance.py, which
# asks only comments that name them).
_SYSTEM_WITH_FIGURE = """Each comment below was posted under a news video about this event:
{event}

Give TWO separate labels for each comment:
- event: its stance toward the event itself — what was done, decided,
  announced or happened, and how it was handled
- person: its stance toward {figure} personally

They are independent. Praising or insulting {figure} says nothing about the
event unless the comment also judges the event; "good president" is
person=positive, event=neutral. Disliking the policy is event=negative even if
the comment respects {figure}.
Labels: positive, neutral, negative.

Answer one line per comment, in order, exactly like:
1. event=neutral person=positive"""


def stance_prompt(event: str = "", figure: str = "") -> str:
    """The system prompt for the event stance of one event's comments."""
    if figure:
        return _SYSTEM_WITH_FIGURE.format(event=event or "(not given)", figure=figure)
    return _SYSTEM.format(event=event or "(not given)")


def event_context(conn: sqlite3.Connection, event_id: int) -> tuple[str, str]:
    """(what the event is, its figure's name or "") for stance_prompt."""
    row = conn.execute(
        "SELECT e.title, f.name FROM events e LEFT JOIN figures f ON f.id = e.figure_id "
        "WHERE e.id = ?", (event_id,)).fetchone()
    if not row:
        return "", ""
    title, name = row[0] or "", row[1] or ""
    return (f"{name}: {title}" if name else title), name


_SCORE = {"negative": -1.0, "neutral": 0.0, "positive": 1.0}

# How far either side of an event to look for videos about it. See
# _search_window.
SEARCH_BEFORE_DAYS = 1
SEARCH_AFTER_DAYS = 14


def _ollama_chat(messages: list[dict], temperature: float | None = None) -> dict:
    """Call the Ollama chat API and return the parsed response."""
    options: dict = {"num_predict": 2048}
    if temperature is not None:
        options["temperature"] = temperature
    url = f"{OLLAMA_BASE_URL}/api/chat"
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": options,
    }).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        raise RuntimeError(f"Ollama not reachable: {e.reason}") from e


_BATCH = int(os.environ.get("SENTIMENT_BATCH", "25"))


def classify_comments(comments: list[str], event: str = "",
                      figure: str = "") -> list[str | None]:
    """Return each comment's stance toward the event, aligned by position.

    An entry is None where the model's output could not be aligned to that
    comment; callers drop those rather than counting them as neutral.
    """
    system = stance_prompt(event, figure)
    labels: list[str | None] = []
    for i in range(0, len(comments), _BATCH):
        labels.extend(_classify_batch(comments[i:i + _BATCH], system))
    return labels


def _classify_batch(batch: list[str], system: str) -> list[str | None]:
    """Classify one batch, halving it when the model miscounts its output."""
    if not batch:
        return []
    numbered = "\n".join(f"{i+1}. {c}" for i, c in enumerate(batch))
    prompt = f"Classify these {len(batch)} comments:\n\n{numbered}"
    try:
        return list(_classify_ollama(batch, prompt, system))
    except ValueError:
        if len(batch) == 1:
            return [None]
        mid = len(batch) // 2
        return _classify_batch(batch[:mid], system) + _classify_batch(batch[mid:], system)


def _classify_ollama(comments: list[str], prompt: str,
                     system: str | None = None) -> list[str]:
    """Classify via local Ollama model — parse labels from free-text output."""
    system = system or stance_prompt()
    paired = "person=" in system
    tail = ("" if paired else
            "\n\nReturn one label per line, numbered (1. negative, 2. neutral, etc).")
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt + tail},
    ]
    result = _ollama_chat(messages, temperature=0)
    text = result.get("message", {}).get("content", "")

    labels: list[str] = []
    valid = {"negative", "neutral", "positive"}
    for line in text.splitlines():
        line = line.strip().lower()
        if paired:
            # Only the event label is kept; see _SYSTEM_WITH_FIGURE.
            m = re.search(r"event\s*=\s*(\w+)", line)
            word = m.group(1) if m else ""
        else:
            m = re.match(r"\d+[.)]\s*\"?(\w+)", line)
            word = m.group(1) if m else line.split()[-1] if line else ""
        if word in valid:
            labels.append(word)

    if len(labels) != len(comments):
        # Padding a short response with "neutral" would report a full
        # sample_size built partly from labels the model never produced, and
        # bias the score toward zero. Refuse the batch instead.
        raise ValueError(
            f"model returned {len(labels)} labels for {len(comments)} comments"
        )
    return labels


_SAMPLE_PER_STANCE = 2     # how many example comments to keep per stance
_SAMPLE_MAX_LEN = 240      # truncate long comments for display


def _sample_comments(comments: list[str], labels: list[str]) -> list[dict]:
    """Pick a few example comments per stance, for display only."""
    picked: list[dict] = []
    for stance in ("negative", "neutral", "positive"):
        n = 0
        for text, label in zip(comments, labels):
            if label != stance:
                continue
            text = " ".join(text.split())
            if len(text) > _SAMPLE_MAX_LEN:
                text = text[:_SAMPLE_MAX_LEN].rstrip() + "…"
            picked.append({"text": text, "label": label})
            n += 1
            if n >= _SAMPLE_PER_STANCE:
                break
    return picked


def _aggregate(labels: list[str]) -> tuple[float, str, dict]:
    """Mean score in [-1,1], bucketed overall label, and a distribution."""
    dist = {"negative": 0, "neutral": 0, "positive": 0}
    for l in labels:
        dist[l] = dist.get(l, 0) + 1
    score = sum(_SCORE[l] for l in labels) / len(labels)
    label = "neutral"
    if score > 0.15:
        label = "positive"
    elif score < -0.15:
        label = "negative"
    return score, label, dist


_QUERY_STOPWORDS = {
    "dan", "di", "ke", "dari", "yang", "untuk", "dengan", "pada", "bahas",
    "soal", "hingga", "akan", "bakal", "buka", "suara", "kabar", "kemarin",
    "ini", "itu", "inilah", "begini", "terkait", "tentang", "atas", "bagi",
    "para", "kepada", "oleh", "sudah", "telah", "masih", "juga", "lebih",
    "baru", "bisa", "harus", "tidak", "bukan", "ada", "hari", "tahun", "jadi",
    "usai", "saat", "agar", "demi", "simak", "video", "berita", "terbaru",
    "viral", "respons", "kata", "ujar", "sebut", "tegas", "minta", "ungkap",
    "terima", "beri", "ajak", "dorong", "pastikan", "klaim", "jelaskan",
    "tanggapi", "soroti", "singgung", "pemerintah", "negara", "indonesia",
    "nasional", "presiden", "menteri", "ketua", "gubernur", "wakil",
}
# The verbs a generated title or a headline opens with ("Menyatakan ...",
# "Menghadiri ..."). No video title says them, and YouTube wants nearly every
# word of a query matched, so one of them is enough to find nothing. A list,
# not a meN- pattern: that would take "Menteri" and "Digital" with them.
_QUERY_VERBS = {
    "menyatakan", "mengatakan", "menyampaikan", "menghadiri", "mengungkapkan",
    "mengungkap", "menerima", "membahas", "meminta", "menyebut", "menegaskan",
    "menyoroti", "menanggapi", "menjelaskan", "memberikan", "memberi",
    "membuka", "mengajak", "mendorong", "memastikan", "mengklaim",
    "menyinggung", "menyindir", "menekankan", "mengimbau", "menginstruksikan",
    "memerintahkan", "mengapresiasi", "mengkritik", "menolak", "mendukung",
    "meninjau", "mengunjungi", "meresmikan", "melantik", "melakukan",
    "menggelar", "mengumumkan", "berbicara", "berkomentar", "menuturkan",
    "menambahkan", "mengingatkan", "mempertanyakan", "menyerahkan",
}
_KEYWORDS = 2
_MENTION_KEYWORDS = 8


def _keywords(titles: list[str], skip: set[str]) -> list[str]:
    """The words the headlines share most, first-seen order breaking ties."""
    counts: dict[str, int] = {}
    first: dict[str, tuple[int, str]] = {}
    for title in titles:
        # Four letters or more, or a capitalised acronym: NTT, KPK and BPN are
        # often the words a story turns on.
        for word in dict.fromkeys(re.findall(r"\b[A-Z]{3}\b|[A-Za-z][A-Za-z-]{3,}", title or "")):
            low = word.lower()
            if low in skip or low in _QUERY_STOPWORDS or low in _QUERY_VERBS:
                continue
            counts[low] = counts.get(low, 0) + 1
            first.setdefault(low, (len(first), word))
    ranked = sorted(counts, key=lambda w: (-counts[w], first[w][0]))
    return [first[w][1] for w in ranked]


_NOT_OFFICES = {"RI", "DKI", "DI", "NKRI"}


def _office(role: str) -> str:
    """A short searchable word for the figure's office: the institution's
    acronym ("Wakil Ketua Komisi VI DPR RI" -> "DPR"), else the title the role
    opens with ("Wakil Gubernur DKI Jakarta" -> "Gubernur")."""
    for word in re.findall(r"\b[A-Z]{2,}\b", role or ""):
        if word not in _NOT_OFFICES and not re.fullmatch(r"[IVXLC]+", word):
            return word
    words = [w for w in (role or "").split() if w.lower() != "wakil"]
    return words[0] if words else ""


def figure_names(terms: list[str]) -> list[str]:
    """What a video must mention to be about a figure: the full name or an
    alias, or any of their words of four letters or more ("airlangga")."""
    return list(dict.fromkeys(terms + [w for t in terms for w in t.split() if len(w) >= 4]))


def _search_terms(conn: sqlite3.Connection, event_id: int) -> tuple[list[str], list[str]]:
    """(queries, mentions) for finding videos about the event.

    Queries go from specific to broad, for youtube.find_videos to try in turn:
    the figure's name with the two words its headlines share most, with one,
    then with its office (_office). The words come from the source headlines rather than
    the generated title, which paraphrases ("Menyatakan alasan penurunan
    anggaran...") in words no video title uses.

    `mentions` are the strings a video's title or description must contain one
    of to count as being about the event: the figure's names, and the
    headlines' _MENTION_KEYWORDS top words. The words carry it for a
    peristiwa, which has no figure, and for coverage that names the office
    rather than the person ("Upacara Proklamasi" with the President in it).
    """
    row = conn.execute(
        "SELECT e.title, e.figure_id FROM events e WHERE e.id = ?", (event_id,)
    ).fetchone()
    if not row:
        raise ValueError(f"event {event_id} not found")

    from .config import load_figures
    fig = next((f for f in load_figures(conn) if f.id == row["figure_id"]), None)
    name = fig.name if fig else ""
    terms = fig.match_terms() if fig else []
    names = figure_names(terms)

    titles = [r[0] for r in conn.execute(
        "SELECT title FROM articles WHERE event_id = ? AND title IS NOT NULL", (event_id,))]
    skip = {w for t in terms for w in t.split()}
    keywords = _keywords(titles or [row["title"] or ""], skip)

    # Generous on purpose: this only has to tell coverage of the event from a
    # drama clip, and three words left out real coverage worded differently
    # ("Bandara Soekarno-Hatta Ditutup" under "Beberapa terminal bandara").
    words = keywords[:_MENTION_KEYWORDS] + _keywords([row["title"] or ""], skip)
    mentions = list(dict.fromkeys(names + [k.lower() for k in words]))

    if not name:
        # No figure to anchor on: the headline words alone, broadest last.
        return ([" ".join(keywords[:n]) for n in (3, 2) if keywords[:n]]
                or [row["title"] or ""]), mentions
    office = _office(fig.role)
    queries = [" ".join([name, *keywords[:_KEYWORDS]]),
               " ".join([name, *keywords[:1]]),
               " ".join([name, office]) if office else name]
    return list(dict.fromkeys(q.strip() for q in queries if q.strip())), mentions


def event_mentions(conn: sqlite3.Connection, event_id: int) -> list[str]:
    """What a video must mention to be about the event (see _search_terms)."""
    return _search_terms(conn, event_id)[1]


def _query_for_event(conn: sqlite3.Connection, event_id: int) -> str:
    """The most specific of the event's search queries (Reddit's search)."""
    return _search_terms(conn, event_id)[0][0]


def _store_comments(conn: sqlite3.Connection, event_id: int,
                    comments: list[dict], labels: list[str]) -> None:
    """Store individual comments with their stance labels.

    Upserts on the platform's own comment id, so re-running sentiment refreshes
    like counts and stances in place instead of duplicating the event's
    comment history.

    The commenter's display name is redacted here and never written in full —
    see jejak/anonymize.py for why.
    """
    now = datetime.now(timezone.utc).isoformat()
    for cmt, label in zip(comments, labels):
        conn.execute(
            """INSERT INTO comments
               (event_id, comment_id, video_id, channel, author_id,
                author_name, text,
                like_count, published_at, stance, collected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(event_id, comment_id) DO UPDATE SET
                 like_count=excluded.like_count,
                 stance=excluded.stance,
                 channel=excluded.channel,
                 collected_at=excluded.collected_at""",
            (event_id,
             cmt.get("comment_id", ""),
             cmt.get("video_id", ""),
             cmt.get("channel", ""),
             # Neither raw value is written. The id becomes a digest, which
             # buzzer can still match on; the name keeps its ends and loses its
             # middle. See jejak/anonymize.py for what that does and does not
             # protect.
             anonymize.hash_author_id(cmt.get("author_id")),
             anonymize.mask_author(cmt.get("author_name")),
             cmt.get("text", ""),
             cmt.get("like_count", 0),
             cmt.get("published_at", ""),
             label,
             now),
        )


def _run_sentiment(conn: sqlite3.Connection, event_id: int,
                   query: str, comments: list[dict],
                   channel: str) -> dict:
    """Classify, aggregate, store sentiment + individual comments."""
    if not comments:
        return {"event_id": event_id, "query": query, "sample_size": 0,
                "channel": channel, "note": "no comments gathered"}

    raw_labels = classify_comments([c["text"] for c in comments],
                                   *event_context(conn, event_id))

    # Drop anything the model could not label rather than counting it as
    # neutral, which would inflate sample_size and pull the score toward zero.
    pairs = [(c, l) for c, l in zip(comments, raw_labels) if l is not None]
    unclassified = len(comments) - len(pairs)
    if not pairs:
        return {"event_id": event_id, "query": query, "channel": channel,
                "sample_size": 0, "note": "no comments could be classified"}

    kept = [c for c, _ in pairs]
    labels = [l for _, l in pairs]
    score, label, dist, n_samples = store_aggregate(
        conn, event_id, channel, [c["text"] for c in kept], labels)
    _store_comments(conn, event_id, kept, labels)

    conn.commit()
    result = {"event_id": event_id, "query": query, "channel": channel,
              "sample_size": len(labels), "score": round(score, 3),
              "label": label, "distribution": dist, "samples": n_samples}
    if unclassified:
        result["note"] = f"{unclassified} comment(s) could not be classified"
    return result


def store_aggregate(conn: sqlite3.Connection, event_id: int, channel: str,
                    texts: list[str], labels: list[str],
                    collected_at: str | None = None) -> tuple[float, str, dict, int]:
    """Write the event's sentiment row for one channel from its labelled
    comments. Returns (score, label, distribution, samples kept).

    `collected_at` defaults to now; relabelling stored comments passes the old
    value, so the event is not taken for freshly collected and left unrefreshed.
    """
    score, label, dist = _aggregate(labels)
    samples = _sample_comments(texts, labels)
    conn.execute(
        """INSERT INTO sentiment
           (event_id, channel, score, label, sample_size, samples_json, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id, channel) DO UPDATE SET
             score=excluded.score,
             label=excluded.label,
             sample_size=excluded.sample_size,
             samples_json=excluded.samples_json,
             collected_at=excluded.collected_at""",
        (event_id, channel, score, label, len(labels),
         json.dumps(samples, ensure_ascii=False),
         collected_at or datetime.now(timezone.utc).isoformat()),
    )
    return score, label, dist, len(samples)


def _search_window(conn: sqlite3.Connection, event_id: int) -> tuple[str, str]:
    """RFC-3339 bounds on when a video about this event could have been posted.

    Coverage of an event does not precede it by more than a day — the margin is
    for timezone slop in the event date — and reaction to it has run its course
    well inside a fortnight. Anything outside is a video about some other time
    the same words were in the news.
    """
    row = conn.execute("SELECT event_date FROM events WHERE id = ?",
                       (event_id,)).fetchone()
    if not row or not row["event_date"]:
        return "", ""
    try:
        when = datetime.fromisoformat(row["event_date"].replace("Z", "+00:00"))
    except ValueError:
        return "", ""
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    when = when.astimezone(timezone.utc)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return ((when - timedelta(days=SEARCH_BEFORE_DAYS)).strftime(fmt),
            (when + timedelta(days=SEARCH_AFTER_DAYS)).strftime(fmt))


def sentiment_event(conn: sqlite3.Connection, event_id: int,
                    cap: int = 100) -> list[dict]:
    """Gather + classify public reaction for one event across channels.

    Runs YouTube (if YOUTUBE_API_KEY is set) and Reddit (always, best-effort).
    Each channel is stored as a separate row.
    Returns a list of result dicts (one per channel).

    Both channels pass through `relevance.filter_comments` before anything is
    classified or stored. A search returns what matches the words, not what is
    about the event, and a thread that is not about the event is not reaction
    to it — see jejak/relevance.py for what that check can and cannot catch.
    """
    queries, mentions = _search_terms(conn, event_id)
    query = queries[0]
    after, before = _search_window(conn, event_id)
    results: list[dict] = []

    def gated(comments: list[dict], channel: str) -> dict:
        kept, dropped = relevance.filter_comments(conn, event_id, comments)
        used = comments[0].get("query", query) if comments else " | ".join(queries)
        result = _run_sentiment(conn, event_id, used, kept, channel)
        if dropped:
            result["off_topic"] = dropped
        return result

    try:
        yt_comments = _youtube_comments(conn, event_id, queries, mentions,
                                        after, before, cap)
        results.append(gated(yt_comments, "youtube"))
    except Exception as e:
        results.append({"event_id": event_id, "query": query,
                        "channel": "youtube", "note": str(e)})

    try:
        reddit_comments = reddit.gather_comments(query, cap=cap)
        results.append(gated(reddit_comments, "reddit"))
    except Exception as e:
        results.append({"event_id": event_id, "query": query,
                        "channel": "reddit", "note": str(e)})

    # The stance above is toward "the figure/event" at once; this adds the
    # stance toward the figure alone, for the comments that name them. See
    # jejak/figure_stance.py.
    from . import figure_stance
    try:
        figure_stance.label_event(conn, event_id)
    except RuntimeError as e:
        results.append({"event_id": event_id, "channel": "figure",
                        "note": str(e)})

    return results


def _stored_videos(conn: sqlite3.Connection, event_id: int) -> tuple[list[dict] | None, str, int, str]:
    """(videos, query, attempts, searched_at) from sentiment_search.

    An event with no row whose comments are already stored gets their videos,
    so the events collected before this table existed are not searched again.
    videos is None for an event never searched.
    """
    row = conn.execute("SELECT videos_json, query, attempts, searched_at FROM sentiment_search "
                       "WHERE event_id = ?", (event_id,)).fetchone()
    if row:
        return json.loads(row[0]), row[1] or "", row[2], row[3]
    seen = conn.execute(
        "SELECT video_id, max(channel) FROM comments WHERE event_id = ? AND video_id != '' "
        "AND video_id NOT LIKE 't3_%' GROUP BY video_id ORDER BY count(*) DESC",
        (event_id,)).fetchall()
    if seen:
        return [{"id": v, "channel": ch or ""} for v, ch in seen], "", 0, ""
    return None, "", 0, ""


def _youtube_comments(conn: sqlite3.Connection, event_id: int, queries: list[str],
                      mentions: list[str], after: str, before: str, cap: int) -> list[dict]:
    """The event's YouTube comments: from its stored videos, or a new search.

    A search runs for an event never searched, and once more for one whose
    search found nothing, RETRY_AFTER_DAYS later (coverage can lag the news).
    Every search is recorded, empty or not.
    """
    videos, query, attempts, _ = _stored_videos(conn, event_id)
    if videos is None or (not videos and _retry_due(conn, event_id)):
        found, query = youtube.find_videos(queries, mentions, published_after=after,
                                           published_before=before)
        videos = [{"id": v["id"], "channel": v.get("channel", "")} for v in found]
        conn.execute(
            """INSERT INTO sentiment_search (event_id, videos_json, query, attempts, searched_at)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(event_id) DO UPDATE SET videos_json = excluded.videos_json,
                   query = excluded.query, attempts = attempts + 1,
                   searched_at = excluded.searched_at""",
            (event_id, json.dumps(videos, ensure_ascii=False), query or None,
             datetime.now(timezone.utc).isoformat()))
        conn.commit()
    return youtube.comments_from(videos, query, cap=cap)


RETRY_AFTER_DAYS = 3
MAX_SEARCHES_PER_EVENT = 2


def _retry_due(conn: sqlite3.Connection, event_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM sentiment_search WHERE event_id = ? AND videos_json = '[]' "
        "AND attempts < ? AND searched_at <= datetime('now', ?)",
        (event_id, MAX_SEARCHES_PER_EVENT, f"-{RETRY_AFTER_DAYS} days")).fetchone() is not None


_FRESH_DAYS = int(os.environ.get("SENTIMENT_FRESH_DAYS", "3"))
# Deliberately longer than the 6-hour pipeline cron: at 6 hours every recent
# event was re-collected on literally every run, spending YouTube quota to
# re-classify comments that had barely changed.
_STALE_HOURS = int(os.environ.get("SENTIMENT_STALE_HOURS", "24"))

# YouTube quota units one run may spend. Three runs a day at 3,000 leave a
# tenth of the free 10,000 for anything run by hand. An event needing a search
# costs up to ~300 units (three searches, see youtube.find_videos); one read
# from stored videos about 5.
_UNITS_PER_RUN = int(os.environ.get("SENTIMENT_UNITS_PER_RUN", "3000"))
_SEARCH_WORST_CASE = 3 * 100 + 10
# Events per run regardless of quota: each is a local-model pass over up to a
# hundred comments, about a minute.
_MAX_EVENTS = int(os.environ.get("SENTIMENT_MAX_EVENTS", "40"))


def _pending_ids(conn: sqlite3.Connection) -> list[tuple[str, int]]:
    """(why, event id) for every approved event due, in the order to take them.

    refresh   fresh events whose comments are older than _STALE_HOURS
    new       fresh events never collected
    retry     events whose one search found nothing, due another try
    backfill  older events never collected: records first, then the ones the
              most articles covered, newest first among equals
    """
    fresh = (f"-{_FRESH_DAYS} days",)
    never = """NOT EXISTS (SELECT 1 FROM sentiment s WHERE s.event_id = e.id)
               AND NOT EXISTS (SELECT 1 FROM sentiment_search q WHERE q.event_id = e.id)"""
    out: list[tuple[str, int]] = []
    for why, sql, params in (
        # Last collected, or last searched for an event whose videos have had
        # no comment kept yet; a search that found nothing is retry's.
        ("refresh", """SELECT e.id FROM events e
              LEFT JOIN sentiment_search q ON q.event_id = e.id
              WHERE e.status = 'approved'
                AND e.event_date >= datetime('now', ?, 'start of day')
                AND (q.event_id IS NULL OR q.videos_json != '[]')
                AND coalesce((SELECT max(s.collected_at) FROM sentiment s WHERE s.event_id = e.id),
                             q.searched_at) <= datetime('now', ?)
              ORDER BY e.event_date DESC""", fresh + (f"-{_STALE_HOURS} hours",)),
        ("new", f"""SELECT e.id FROM events e WHERE e.status = 'approved'
                AND e.event_date >= datetime('now', ?, 'start of day') AND {never}
              ORDER BY e.event_date DESC""", fresh),
        ("retry", """SELECT e.id FROM events e JOIN sentiment_search q ON q.event_id = e.id
              WHERE e.status = 'approved' AND q.videos_json = '[]' AND q.attempts < ?
                AND q.searched_at <= datetime('now', ?)
              ORDER BY e.event_date DESC""",
         (MAX_SEARCHES_PER_EVENT, f"-{RETRY_AFTER_DAYS} days")),
        ("backfill", """SELECT e.id FROM events e WHERE e.status = 'approved'
                AND e.event_date < datetime('now', ?, 'start of day')
                AND NOT EXISTS (SELECT 1 FROM sentiment s WHERE s.event_id = e.id)
                AND NOT EXISTS (SELECT 1 FROM sentiment_search q WHERE q.event_id = e.id)
              ORDER BY e.kind = 'record' DESC,
                       (SELECT count(*) FROM articles a WHERE a.event_id = e.id) DESC,
                       e.event_date DESC""", fresh),
    ):
        out.extend((why, r[0]) for r in conn.execute(sql, params))
    return out


def sentiment_pending(conn: sqlite3.Connection, limit: int | None = None,
                      units: int | None = None) -> list[dict]:
    """Run sentiment for the events due (see _pending_ids), within the run's
    YouTube quota (`units`, default _UNITS_PER_RUN) and event cap (`limit`).

    An event that needs a search is skipped once the worst case would overrun
    the budget; reads from stored videos, at a few units, carry on. So the
    budget left after the day's own events goes to the backfill.
    """
    limit = _MAX_EVENTS if limit is None else limit
    budget = youtube.units_used + (_UNITS_PER_RUN if units is None else units)
    results: list[dict] = []
    done = 0
    counts: dict[str, int] = {}
    for why, eid in _pending_ids(conn):
        if done >= limit:
            break
        videos, *_ = _stored_videos(conn, eid)
        needs_search = videos is None or (not videos and _retry_due(conn, eid))
        if needs_search and youtube.units_used + _SEARCH_WORST_CASE > budget:
            continue
        # No delete pass: sentiment and comments upsert on their natural keys,
        # so re-collection refreshes rows and adds newly-posted comments while
        # keeping the ones that have scrolled out of the platform's response.
        for res in sentiment_event(conn, eid):
            res["why"] = why
            results.append(res)
        done += 1
        counts[why] = counts.get(why, 0) + 1
    print(f"sentiment: {done} events {counts}, "
          f"{youtube.units_used} YouTube units this run (budget {budget})")
    return results
