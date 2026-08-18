"""Stage 3 — Summarize an event, grounded in its sources.

This is the legally load-bearing stage. We do NOT let the model write in its own
voice from memory. Instead we hand it the actual articles as citable documents,
so every sentence it produces is tied back to a specific source.

Uses a local Ollama model with inline citation markers [Sumber N].

Settings:
  - OLLAMA_MODEL    (default: qwen2.5:7b)
  - OLLAMA_BASE_URL (default: http://localhost:11434)
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone

OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

_GROUNDING = """Hard rules:
- Report what outlets reported; do not assert anything as established fact in
  your own voice. Use ONLY information present in the documents. Never add
  context, motive, or conclusions from outside knowledge. If sources disagree,
  say so plainly.
- Neutral register. No characterisation, no adjectives of judgement, no
  speculation about intent or guilt.
- Write in Indonesian (Bahasa Indonesia), matching the sources.
- Every bullet ends with its citation marker [Sumber N]. 3-6 bullets. No
  introductory paragraph, no closing sentence — just the bullets."""

# There is no fixed list of event types in code — see _existing_categories().
# A closed list forced every figure into a politics-shaped vocabulary (Pidato,
# Pelantikan, Pemilu, ...), so a lecturer's or an executive's record had almost
# nothing to match and fell into "other". The model instead sees the tags
# already in use and is asked to reuse one when it genuinely fits, or coin a
# short new one when it doesn't — the taxonomy grows from what the archive
# actually contains, for any kind of public figure.
_KATEGORI_RULES = """- KATEGORI names the general TYPE of act or event, in 1-3 words, Title
  Case, no punctuation — e.g. "Pernyataan", "Kunjungan Kerja", "Peresmian",
  "Kebakaran". It is not a summary of what happened, only what kind of thing
  it is.
- If one of the "Kategori yang sudah dipakai" listed below genuinely fits,
  copy it back exactly, spelling included. Only coin a new one when none of
  them fit — do not invent a near-duplicate of one that already does
  ("Kunjungan Resmi" when "Kunjungan Kerja" is offered and fits)."""

# Peristiwa: an event belonging to nobody. Outlet framing is correct here — the
# archive is reporting that something was widely reported.
SYSTEM_PERISTIWA = f"""You are an editorial assistant for a public accountability archive.
You write neutral, factual, NON-DEFAMATORY summaries of a single news event,
grounded ONLY in the provided source documents.

{_GROUNDING}
- Prefer "Menurut [outlet], ..." / "[Outlet] melaporkan ...".
{_KATEGORI_RULES}

Output format, exactly:
JUDUL: <a plain factual clause naming what happened, 4-12 words>
KATEGORI: <type of event, 1-3 words>
---
- <bullet> [Sumber 1]
"""

# Record: one person's own trace. The archive exists to record what a figure
# said and did, so the figure is the grammatical subject throughout and the
# entry is written as a ledger line, not as a story about them.
SYSTEM_RECORD = f"""You are an editorial assistant for a public accountability archive
that keeps a per-person track record — a ledger of what one public figure
themselves said and did. You are writing ONE entry in {{name}}'s ledger,
grounded ONLY in the provided source documents.

{_GROUNDING}
- {{name}} is the subject of every bullet. Write what {{name}} said, did,
  decided, attended, or claimed. Facts about other people, background context,
  and an outlet's own framing do not belong in this ledger — omit them.
- When {{name}} is quoted, keep the substance of the quote; that utterance is
  the whole point of the entry.
- If the documents contain nothing {{name}} personally said or did, write a
  single bullet saying so and nothing else.

The JUDUL is a ledger heading, NOT a news headline:
- Start with a verb describing {{name}}'s own act: "Menolak ...", "Menyatakan ...",
  "Menandatangani ...", "Menghadiri ...", "Menguji ...".
- Do NOT write {{name}}'s name in it — the ledger already belongs to them.
- Do NOT copy the source headline. Ignore capitalisation, emoji, exclamation
  marks, and teaser phrasing in the sources; those are the outlet's voice.
- 4-10 words, sentence case, no quotation marks, no question marks, no
  trailing punctuation.
{_KATEGORI_RULES}
- KATEGORI describes {{name}}'s act itself (e.g. "Pernyataan", "Kunjungan
  Kerja"), never {{name}}'s job title or field.

Output format, exactly:
JUDUL: <verb phrase>
KATEGORI: <type of act, 1-3 words>
---
- <bullet> [Sumber 1]
"""


def _ollama_chat(messages: list[dict]) -> dict:
    """Call the Ollama chat API and return the parsed response body."""
    url = f"{OLLAMA_BASE_URL}/api/chat"
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": 1024},
    }).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Ollama API error: {e.code} {e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Ollama not reachable at {OLLAMA_BASE_URL}. "
            f"Is ollama serve running? ({e.reason})"
        ) from e


def _format_articles(articles: list[sqlite3.Row]) -> str:
    """Format articles as numbered text blocks for Ollama."""
    blocks = []
    for i, a in enumerate(articles, 1):
        body = a["title"]
        full = a["body"] if "body" in a.keys() else None
        if full:
            body += "\n\n" + full
        elif a["summary"]:
            body += "\n\n" + a["summary"]
        source = f"{a['source']} — {a['published_at'] or 'tanggal tidak diketahui'}"
        blocks.append(f"[Sumber {i}]: {source}\n\n{body}")
    return "\n\n---\n\n".join(blocks)


_PROMPT_PERISTIWA = (
    "Tuliskan JUDUL, KATEGORI, lalu ringkasan netral peristiwa di atas dalam "
    "format poin-poin. Setiap poin satu fakta kunci, diakhiri [Sumber 1], "
    "[Sumber 2], dan seterusnya. Jika hanya satu sumber yang melaporkannya, "
    "nyatakan bahwa peristiwa ini belum terkonfirmasi oleh media lain. "
    "Jangan gunakan paragraf pembuka atau penutup.\n\n"
    "{categories}"
    "Ikuti kerangka ini persis, termasuk kata JUDUL, KATEGORI, dan garis ---. "
    "Ganti bagian di dalam < > dengan isi dari dokumen:\n"
    "JUDUL: <apa yang terjadi, 4-12 kata>\n"
    "KATEGORI: <jenis peristiwa, 1-3 kata>\n"
    "---\n"
    "- <fakta kunci> [Sumber 1]\n"
    "- <fakta kunci> [Sumber 2]"
)

_PROMPT_RECORD = (
    "Tuliskan satu entri rekam jejak untuk {name} berdasarkan dokumen di atas. "
    "JUDUL harus diawali kata kerja yang menggambarkan perbuatan atau ucapan "
    "{name} sendiri, tanpa menyebut namanya, dan tidak menyalin judul berita. "
    "Setiap poin menjadikan {name} sebagai subjek dan diakhiri [Sumber 1], "
    "[Sumber 2], dan seterusnya. Abaikan bagian dokumen yang bukan tentang "
    "perbuatan atau ucapan {name}. "
    "Jangan gunakan paragraf pembuka atau penutup. "
    "Setiap poin ditulis pada baris sendiri dan diawali tanda '- '.\n\n"
    "{categories}"
    "Ikuti kerangka ini persis, termasuk kata JUDUL, KATEGORI, dan garis ---. "
    "Bagian di dalam < > adalah tempat isian, bukan contoh jawaban — "
    "isi seluruhnya dari dokumen di atas:\n"
    "JUDUL: <kata kerja + objek, 4-10 kata>\n"
    "KATEGORI: <jenis perbuatan {name}, 1-3 kata>\n"
    "---\n"
    "- <perbuatan atau ucapan {name}> [Sumber 1]\n"
    "- <perbuatan atau ucapan {name}> [Sumber 2]"
)

_NO_CATEGORIES_YET = "Belum ada kategori yang dipakai — silakan buat kategori pertama.\n\n"

# The model is asked for "JUDUL: ... \n---\n bullets" rather than JSON: qwen2.5
# returns malformed JSON often enough that a strict parser drops good output,
# whereas a missing JUDUL line here degrades to the source headline.
_JUDUL_RE = re.compile(r"^\s*(?:\*\*)?JUDUL(?:\*\*)?\s*:\s*(.+?)\s*$", re.M)
_KATEGORI_RE = re.compile(r"^\s*(?:\*\*)?KATEGORI(?:\*\*)?\s*:\s*(.+?)\s*$", re.M)
_SEPARATOR_RE = re.compile(r"^\s*-{3,}\s*$", re.M)
# Leading list markers and bold wrappers the model adds to the title itself.
_TITLE_NOISE_RE = re.compile(r'^[\s"“”\'*\-–—]+|[\s"“”\'*.:;]+$')
# Sentinel words the model sometimes uses for "no real category" — treated the
# same as no category at all, so a keyword-inferred fallback isn't replaced by
# an equally uninformative dynamic one.
_VAGUE_CATEGORIES = {"lain-lain", "lainnya", "other", "umum", "berita", "peristiwa"}


def _extract_category(text: str) -> str | None:
    """Pull the KATEGORI line out of a raw model response, if present.

    Independent of `_split_title`: the KATEGORI line sits between JUDUL and the
    `---` separator, which `_split_title` already discards as part of the
    pre-separator header block, so this can search the untouched raw text
    without the two extractions interfering with each other.
    """
    m = _KATEGORI_RE.search(text)
    if not m:
        return None
    cat = _TITLE_NOISE_RE.sub("", m.group(1))
    if not cat or "<" in cat or ">" in cat or len(cat) > 40:
        return None
    # A single tag, not a list of candidates the model couldn't choose between
    # ("Pernyataan, Kebijakan"). One category per event is the point — a
    # compound answer here means picking neither and falling back instead.
    if re.search(r",| / | dan | atau ", cat):
        return None
    if cat.lower() in _VAGUE_CATEGORIES:
        return None
    return cat[0].upper() + cat[1:] if cat[0].islower() else cat


def _existing_categories(conn: sqlite3.Connection, limit: int = 40) -> list[str]:
    """The event types already in use, most common first.

    This is the entire taxonomy — there is no fixed list in code. Handing it to
    the model as a menu it can reuse keeps near-duplicate tags ("Kunjungan" vs
    "Kunjungan Kerja") from accumulating one per event; a brand new kind of act
    still gets a brand new tag when nothing on the list fits.
    """
    rows = conn.execute(
        """SELECT event_type, count(*) n FROM events
            WHERE event_type IS NOT NULL AND event_type != ''
              AND lower(event_type) != 'other'
            GROUP BY event_type ORDER BY n DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [r["event_type"] for r in rows]


def _format_categories(categories: list[str]) -> str:
    if not categories:
        return _NO_CATEGORIES_YET
    return "Kategori yang sudah dipakai: " + ", ".join(categories) + ".\n\n"


def _split_title(text: str) -> tuple[str | None, str]:
    """Separate the generated heading from the bullet body.

    Returns (title, body). A missing or empty heading yields (None, text) so the
    caller can fall back to the source headline rather than publish a blank.

    The label is optional because the model frequently drops it and simply
    writes the heading as the first line — which is still the heading, so
    discarding it would throw away good output over formatting. Anything that
    looks like a bullet, or is too long to be a heading, is left in the body.
    """
    m = _JUDUL_RE.search(text)
    if m:
        title = _TITLE_NOISE_RE.sub("", m.group(1))
        body = text[m.end():]
    else:
        head, sep, rest = text.strip().partition("\n")
        head = head.strip()
        if not head or head.startswith(("-", "*", "•")) or len(head) > 120:
            return None, text.strip()
        title = _TITLE_NOISE_RE.sub("", head)
        body = rest

    divider = _SEPARATOR_RE.search(body)
    if divider:
        body = body[divider.end():]
    # A one- or two-word heading ("Menyatakan:") says nothing; the source
    # headline, teaser voice and all, is at least informative. Reject it and let
    # the caller fall back. Angle brackets mean the model echoed the format
    # skeleton instead of filling it in.
    if len(title.split()) < 3 or "<" in title or ">" in title:
        return None, text.strip()
    return (title or None), body.strip()


def summarize_ollama(
    articles: list[sqlite3.Row],
    figure_name: str | None = None,
    existing_categories: list[str] | None = None,
) -> tuple[str | None, str | None, str, list[dict]]:
    """Summarize via a local Ollama model with inline citation markers.

    `figure_name` switches the entry from event framing to ledger framing: a
    record is one person's own trace, so it is written with them as the subject
    and headed by what they did, not by what an outlet called it.

    `existing_categories` is the open-vocabulary tag menu — see
    `_existing_categories` — offered so the model reuses a fitting tag instead
    of minting a near-duplicate of one that already exists.

    Returns (generated_title, generated_category, summary_text, citations).
    """
    formatted = _format_articles(articles)
    categories = _format_categories(existing_categories or [])
    if figure_name:
        system = SYSTEM_RECORD.format(name=figure_name)
        prompt = _PROMPT_RECORD.format(name=figure_name, categories=categories)
    else:
        system = SYSTEM_PERISTIWA
        prompt = _PROMPT_PERISTIWA.format(categories=categories)
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": f"{formatted}\n\n{prompt}"},
    ]
    result = _ollama_chat(messages)
    raw = result.get("message", {}).get("content", "").strip()
    title, text = _split_title(raw)
    category = _extract_category(raw)

    citations: list[dict] = []
    for m in re.finditer(r'\[Sumber (\d+)\]', text):
        idx = int(m.group(1)) - 1
        if 0 <= idx < len(articles):
            a = articles[idx]
            citations.append({
                "cited_text": m.group(0),
                "document_index": idx,
                "document_title": (
                    f"{a['source']} — {a['published_at'] or 'tanggal tidak diketahui'}"
                ),
            })

    return title, category, text, citations


def summarize_event(conn: sqlite3.Connection, event_id: int) -> dict:
    """Generate a grounded draft entry for one event and store it.

    Sets the event status to 'approved' (the summary has been written).
    Returns a small result dict for logging.
    """
    articles = conn.execute(
        "SELECT source, url, title, summary, body, published_at FROM articles "
        "WHERE event_id = ? ORDER BY published_at",
        (event_id,),
    ).fetchall()
    if not articles:
        raise ValueError(f"event {event_id} has no articles")

    ev = conn.execute(
        """SELECT e.kind, e.status, COALESCE(f.name, e.figure_id) AS figure_name
             FROM events e LEFT JOIN figures f ON f.id = e.figure_id
            WHERE e.id = ?""",
        (event_id,),
    ).fetchone()
    if ev and ev["status"] == "candidate":
        # A peristiwa candidate has not cleared PERISTIWA_MIN_OUTLETS yet — see
        # cluster.promote_peristiwa. This function always ends with
        # status='approved', so calling it here would publish an
        # uncorroborated event. Enforced here, not just in call sites: a
        # broadened SQL filter in a batch script is exactly how this once
        # slipped through.
        raise ValueError(
            f"event {event_id} is still a candidate (not yet corroborated) — "
            "refusing to summarize/approve it"
        )
    figure_name = ev["figure_name"] if ev and ev["kind"] == "record" else None

    outlets = {a["source"] for a in articles}
    corroboration = len(outlets)
    single_source = 1 if corroboration < 2 else 0

    existing_categories = _existing_categories(conn)
    title, category, summary_text, citations = summarize_ollama(
        articles, figure_name, existing_categories
    )
    model_used = f"ollama/{OLLAMA_MODEL}"

    conn.execute(
        """INSERT INTO event_summaries
           (event_id, summary_text, citations_json, corroboration_count,
            single_source_flag, model, generated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             summary_text=excluded.summary_text,
             citations_json=excluded.citations_json,
             corroboration_count=excluded.corroboration_count,
             single_source_flag=excluded.single_source_flag,
             model=excluded.model,
             generated_at=excluded.generated_at""",
        (event_id, summary_text, json.dumps(citations, ensure_ascii=False),
         corroboration, single_source, model_used,
         datetime.now(timezone.utc).isoformat()),
    )
    # The working title is the first source's headline (teaser phrasing,
    # all-caps, emoji when the source is a video channel) and event_type is a
    # keyword guess made before any of the articles' content was read closely.
    # Replacing both here — grounded in the actual documents, in the model's
    # open vocabulary rather than a fixed list — is what makes a record read as
    # the figure's own entry and lets the type taxonomy grow with the archive
    # instead of being fixed in code. Either can come back empty (guarded
    # above), in which case the earlier value is left as-is rather than
    # cleared.
    sets, params = ["status = 'approved'"], []
    if title:
        sets.append("title = ?")
        params.append(title)
    if category:
        sets.append("event_type = ?")
        params.append(category)
    params.append(event_id)
    conn.execute(f"UPDATE events SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()

    return {
        "event_id": event_id,
        "outlets": sorted(outlets),
        "corroboration": corroboration,
        "single_source": bool(single_source),
        "citations": len(citations),
        "chars": len(summary_text),
        "title": title,
        "category": category,
        "model": model_used,
    }


def summarize_pending(conn: sqlite3.Connection,
                      limit: int | None = None) -> list[dict]:
    """Summarize every event still in 'new' status, oldest first.

    Drains the queue by default rather than taking a fixed slice. A slice left a
    permanent backlog: a crawl promotes more events than one batch covers, so
    the oldest ones kept getting summarized while the newest never did, and the
    shortfall carried over to the next run.

    The queue is small even after a bulk crawl, because an event only reaches
    'new' once it has cleared the gates — attribution for a record, distinct
    outlet corroboration for a peristiwa. A 358-article ingest produced 31
    summarizable events; the several hundred uncorroborated candidates stay out
    of it. `limit` is still there for tests and for interrupting a long first
    run.
    """
    sql = "SELECT id FROM events WHERE status = 'new' ORDER BY created_at"
    params: tuple = ()
    if limit is not None:
        sql += " LIMIT ?"
        params = (limit,)
    ids = [r["id"] for r in conn.execute(sql, params).fetchall()]
    results = []
    for eid in ids:
        try:
            results.append(summarize_event(conn, eid))
        except ValueError as e:
            # A handful of events on old syncs carry no linked articles (a
            # scar from a since-fixed sync bug that once minted mismatched
            # Postgres ids). One bad row shouldn't block every event behind
            # it in the queue.
            print(f"skip event {eid}: {e}")
    return results
