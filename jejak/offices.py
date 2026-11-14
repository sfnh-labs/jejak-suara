"""A figure's main office as role and organisation, proposed for the curator.

Most active figures came in with an office written as one phrase ("Gubernur
Jawa Tengah", "Ketua Umum Partai Demokrat") and no organisation, or one that
is no organisation at all ("Dapil Jawa Barat VII"). jejak/organizations.py
can only link an office that names its body, so those figures have no
organisation datapoint. This stage proposes one, per figure whose first
office (figures.positions[0]) has no linked organisation:

  * "dari label"     the figure's own label already ends with a known
                     organisation: "Ketua Umum Partai Demokrat" is Ketua Umum
                     of Partai Demokrat. No model.
  * "model, dikenal" the local model reads the latest paragraphs naming the
    "model, baru"    figure and states their office; "dikenal" when the
                     organisation it names is already on the list, "baru" when
                     a "Ya" adds it. What it says must be in the paragraph.

Each proposal is a "jabatan" curation point (jejak/curation_points.py),
listed on the catatan its evidence is from. The answer lives here:

  * Ya / Koreksi  write the office to positions[0] — over the entry it fixes,
                  or in front of it when that entry was another office — with
                  org_id set, adding the organisation if it is new, and mark
                  the CV curated so a regenerated CV does not undo it.
  * Bukan         is kept, and that figure is not asked again for a while.

/kurasi and the Telegram bot answer through scripts/kurasi_ops.py
(jabatan-answer, jabatan-undo), so this is the one copy of that logic.

    python -m jejak.cli offices
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone

from . import organizations
from .organizations import fold

BANDS = {"dari label": 0.8, "model, dikenal": 0.6, "model, baru": 0.4}

# What "the organisation" means, for this stage's prompt and cv_extract.py's.
ORG_RULE = """org = the institution the office belongs to, by its full name:
  a ministry ("Kementerian Keuangan"), an agency, the parliament, a party, a
  company, a university, a court, the police or armed forces, or a regional
  government ("Pemerintah Provinsi Jawa Tengah", "Pemerintah Kabupaten
  Bogor", "Pemerintah Kota Malang"). NEVER an electoral district ("Dapil
  ..."), an election or pilkada, a cabinet, a field or division ("Bidang
  ..."), a period, a year, a running mate, or a bare place name.
  role = the office alone, without the institution: "Menteri" of
  "Kementerian Keuangan", "Gubernur" of "Pemerintah Provinsi Bali", "Ketua
  Umum" of "Partai Demokrat". A commission or unit inside the body stays in
  role: "Wakil Ketua Komisi III" of "Dewan Perwakilan Rakyat"."""

SYSTEM = """You read news paragraphs that name ONE person, {name}, and state
{name}'s current main office, for a public accountability archive.

Hard rules:
- Use ONLY what the paragraphs say about {name}. Nothing from outside
  knowledge. If they state no office of {name}, return empty strings.
- The archive's current label for {name} is "{label}". It may be outdated or
  cut short; what the paragraphs say wins, and the newest paragraph is first.
- {org_rule}
- When the organisation is one of these, write it exactly as listed:
{known}

Return JSON only: {{"role": "...", "org": "...", "paragraph": <its number>}}"""

PROMPT = "Apa jabatan utama {name} saat ini, menurut paragraf di atas? Jawab JSON."

# Model calls per run: the first run has ~150 figures to read, and a publish
# run should not spend an hour on them. The newest-active figures go first.
MODEL_LIMIT = 30
# A figure whose proposal was turned down is asked again only after this,
# when there is newer coverage to read.
RETRY_AFTER = timedelta(days=14)

_NOT_AN_ORG = re.compile(
    r"^(dapil|daerah pemilihan|pemilu|pilkada|pilpres|pileg|kabinet|bidang|periode|"
    r"terpilih|pelaksana|masa jabatan|sejak|juga)\b|\b(19|20)\d\d\b|–|—", re.I)
# Words of an organisation's name that every one of its kind has, so they say
# nothing about whether the paragraph names this one.
_GENERIC = set("""pemerintah provinsi kabupaten kota kementerian kementrian badan
    partai dewan republik indonesia nasional pusat daerah lembaga komisi majelis
    dan dari untuk ri the of""".split())
_WORD = re.compile(r"[a-z0-9]+")


class Refused(RuntimeError):
    """An answer or undo that cannot be carried out, said in the curator's words."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _positions(raw: str | None) -> list:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def needs_office(positions: list) -> bool:
    """No first office, or a first office whose organisation is not linked."""
    first = positions[0] if positions else None
    return not isinstance(first, dict) or first.get("org_id") is None


def label_of(role: str | None, positions: list) -> str:
    """The figure's office as one phrase: the label, else the first office."""
    if (role or "").strip():
        return " ".join(role.split())
    first = positions[0] if positions and isinstance(positions[0], dict) else {}
    return " ".join(f"{first.get('role') or ''} {first.get('org') or ''}".split())


# ---------------------------------------------------------------------------
# Proposing


def _spellings(conn: sqlite3.Connection) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {}
    for r in conn.execute("SELECT id, name, short_name, aliases FROM organizations"):
        out[r["id"]] = [s for s in [r["name"], r["short_name"], *organizations._aliases(r["aliases"])] if s]
    return out


def split_label(label: str, index: dict[str, int]) -> tuple[str, int] | None:
    """(role, org id) when the label ends with a known organisation, after at
    least one word of office: the longest such ending wins."""
    words = label.split()
    for cut in range(1, len(words)):
        tail = fold(" ".join(words[cut:]))
        if tail in index:
            role = " ".join(words[:cut]).strip(" ,–-")
            if role:
                return role, index[tail]
    return None


def _distinct(text: str) -> list[str]:
    return [w for w in _WORD.findall(fold(text)) if len(w) > 2 and w not in _GENERIC]


def grounded(role: str, org: str, paragraph: str, spellings: list[str]) -> bool:
    """The paragraph states both: the role's words (or the role itself, when
    it is all common words like "Menteri"), and the organisation by one of its
    spellings, or by every distinctive word of the name the model wrote."""
    text = fold(paragraph)
    present = set(_WORD.findall(text))
    words = _distinct(role)
    if words:
        if sum(w in present for w in words) < 0.75 * len(words):
            return False
    elif not re.search(rf"\b{re.escape(fold(role))}\b", text):
        return False
    if any(re.search(rf"\b{re.escape(fold(s))}\b", text) for s in spellings if len(s) >= 2):
        return True
    words = _distinct(org)
    return bool(words) and all(w in present for w in words)


def trim_role(role: str, org: str, spellings: list[str]) -> str:
    """The role without the organisation the model also wrote into it:
    "Menteri Dalam Negeri" of Kementerian Dalam Negeri is "Menteri", "Wakil
    Ketua DPR" of DPR is "Wakil Ketua". "Wali Kota" stays whole."""
    words = role.split()
    for s in sorted(spellings, key=len, reverse=True):
        n = len(s.split())
        if len(words) > n and fold(" ".join(words[-n:])) == fold(s):
            return " ".join(words[:-n])
    in_org = set(_WORD.findall(fold(org)))
    while len(words) > 1 and fold(words[-1]) in in_org and not (
            fold(words[-1]) == "kota" and fold(words[-2]) == "wali"):
        words.pop()
    return " ".join(words)


def _name_pattern(fig) -> re.Pattern | None:
    """How a paragraph names the figure: their name, an alias, or a longer
    word of the name ("Dasco"), as quotes are matched to speakers."""
    terms = {t for t in fig.match_terms() if len(t) >= 4}
    terms |= {w.lower() for w in fig.name.split() if len(w) >= 5}
    if not terms:
        return None
    return re.compile(r"\b(?:" + "|".join(re.escape(fold(t)) for t in sorted(terms)) + r")\b")


def named_sentences(paragraph: str, fig) -> list[tuple[int, int]]:
    """The spans of the paragraph's sentences that name the figure."""
    from .curation_points import _sentences
    pat = _name_pattern(fig)
    if pat is None:
        return []
    return [(a, b) for a, b in _sentences(paragraph) if pat.search(fold(paragraph[a:b]))]


def is_org(org: str) -> bool:
    org = " ".join(org.split())
    return len(org) >= 2 and not _NOT_AN_ORG.search(org)


def _evidence(conn: sqlite3.Connection, fig, limit: int = 3) -> list[dict]:
    """The latest paragraphs naming the figure, newest first, one per catatan:
    [{event_id, article_id, paragraph, hl_start, hl_end}]."""
    from .curation_points import _actor_evidence
    out = []
    for r in conn.execute(
        """SELECT id FROM events
            WHERE (figure_id = ? OR id IN (SELECT event_id FROM record_figures WHERE figure_id = ? AND role = 'related'))
              AND curated IS NOT 'rejected'
            ORDER BY event_date DESC, id DESC LIMIT 8""", (fig.id, fig.id)
    ):
        ev = _actor_evidence(conn, r["id"], fig)
        if ev:
            out.append({"event_id": r["id"], "article_id": ev[0], "paragraph": ev[1],
                        "hl_start": ev[2], "hl_end": ev[3]})
            if len(out) >= limit:
                break
    return out


def _latest_event(conn: sqlite3.Connection, figure_id: str) -> int | None:
    row = conn.execute(
        """SELECT id FROM events
            WHERE (figure_id = ? OR id IN (SELECT event_id FROM record_figures WHERE figure_id = ? AND role = 'related'))
              AND curated IS NOT 'rejected'
            ORDER BY event_date DESC, id DESC LIMIT 1""", (figure_id, figure_id)).fetchone()
    return row[0] if row else None


def ask_model(name: str, label: str, paragraphs: list[str], known: list[str]) -> dict:
    from .cv_extract import _chat_json
    doc = "\n\n".join(f"[Paragraf {i}]\n{p}" for i, p in enumerate(paragraphs, 1))
    raw = _chat_json([
        {"role": "system", "content": SYSTEM.format(
            name=name, label=label or "-", org_rule=ORG_RULE,
            known="\n".join(f"  - {k}" for k in known))},
        {"role": "user", "content": doc + "\n\n" + PROMPT.format(name=name)},
    ], num_predict=120)
    return raw if isinstance(raw, dict) else {}


def _put(conn, figure_id: str, role: str, org: str, band: str, ev: dict | None,
         event_id: int, model: str | None) -> bool:
    cur = conn.execute(
        """INSERT OR IGNORE INTO office_proposals
               (figure_id, role, org, band, event_id, article_id, paragraph, hl_start, hl_end,
                model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (figure_id, role, org, band, event_id, (ev or {}).get("article_id"),
         (ev or {}).get("paragraph"), (ev or {}).get("hl_start"), (ev or {}).get("hl_end"),
         model, _now()))
    # Commit each proposal on its own: the write lock must not stay held
    # through the model calls that follow, or the bot and /kurasi time out.
    conn.commit()
    return cur.rowcount > 0


def _candidates(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Active figures needing an office, without one waiting for an answer,
    the most recently covered first."""
    rows = conn.execute(
        """SELECT f.id, f.name, f.role, f.aliases, f.positions,
                  (SELECT max(e.event_date) FROM events e WHERE e.figure_id = f.id) AS latest
             FROM figures f
            WHERE f.active = 1
              AND NOT EXISTS (SELECT 1 FROM office_proposals o
                               WHERE o.figure_id = f.id AND o.verdict IS NULL)
            ORDER BY latest IS NULL, latest DESC, f.id"""
    ).fetchall()
    return [r for r in rows if needs_office(_positions(r["positions"]))]


def propose(conn: sqlite3.Connection, use_model: bool = True, limit: int = MODEL_LIMIT) -> dict:
    """Propose an office for every figure that needs one and is not waiting
    on an answer: from their label when it names a known organisation, else
    from the model, up to `limit` model calls."""
    from .config import Figure
    from .cv_extract import ModelDown
    from .summarize import OLLAMA_MODEL

    index = organizations.index(conn)
    spellings = _spellings(conn)
    known = sorted({spellings[i][0] for i in spellings if spellings[i]})
    stats = {"dari_label": 0, "model": 0, "model_none": 0, "model_ungrounded": 0, "no_evidence": 0}
    calls = 0
    model_up = use_model
    for f in _candidates(conn):
        past = conn.execute(
            "SELECT band, verdict, decided_at FROM office_proposals WHERE figure_id = ?",
            (f["id"],)).fetchall()
        positions = _positions(f["positions"])
        label = label_of(f["role"], positions)
        split = split_label(label, index)
        if split and not any(p["band"] == "dari label" for p in past):
            role, org_id = split
            fig = Figure(id=f["id"], name=f["name"], role=f["role"] or "")
            ev = (_evidence(conn, fig, limit=1) or [None])[0]
            event_id = ev["event_id"] if ev else _latest_event(conn, f["id"])
            if event_id is None:
                stats["no_evidence"] += 1
                continue
            stats["dari_label"] += _put(conn, f["id"], role, spellings[org_id][0], "dari label",
                                        ev, event_id, None)
            continue
        if not model_up or calls >= limit:
            continue
        turned_down = [p["decided_at"] for p in past if p["verdict"] == "rejected" and p["decided_at"]]
        if turned_down and max(turned_down) > (datetime.now(timezone.utc) - RETRY_AFTER).isoformat():
            continue
        try:
            aliases = json.loads(f["aliases"]) if f["aliases"] else []
        except ValueError:
            aliases = []
        fig = Figure(id=f["id"], name=f["name"], role=f["role"] or "", aliases=aliases)
        evidence = _evidence(conn, fig)
        if not evidence:
            stats["no_evidence"] += 1
            continue
        calls += 1
        try:
            raw = ask_model(f["name"], label, [e["paragraph"] for e in evidence], known)
        except ModelDown:
            model_up = False
            stats["model_down"] = 1
            continue
        except RuntimeError:
            stats["model_none"] += 1
            continue
        role = " ".join(str(raw.get("role") or "").split()).strip(" ,.")
        org = " ".join(str(raw.get("org") or "").split()).strip(" ,.")
        if not role or not org or not is_org(org):
            stats["model_none"] += 1
            continue
        org_id = index.get(fold(org))
        if org_id is not None:
            org = spellings[org_id][0]
        try:
            n = int(raw.get("paragraph") or 1)
        except (TypeError, ValueError):
            n = 1
        order = [evidence[n - 1]] if 1 <= n <= len(evidence) else []
        role = trim_role(role, org, spellings.get(org_id, []))
        found = None
        for e in order + evidence:
            for a, b in named_sentences(e["paragraph"], fig):
                if grounded(role, org, e["paragraph"][a:b], spellings.get(org_id, [])):
                    found = {**e, "hl_start": a, "hl_end": b}
                    break
            if found:
                break
        if found is None:
            stats["model_ungrounded"] += 1
            continue
        ev = found
        band = "model, dikenal" if org_id is not None else "model, baru"
        stats["model"] += _put(conn, f["id"], role, org, band, ev, ev["event_id"],
                               f"ollama/{OLLAMA_MODEL}")
    conn.commit()
    return stats


# ---------------------------------------------------------------------------
# Answering


def ensure_org(conn: sqlite3.Connection, org: str) -> tuple[int, bool]:
    """(id, added): the organisation by any of its spellings, added when new."""
    org = " ".join(org.split())
    hit = organizations.index(conn).get(fold(org))
    if hit is not None:
        return hit, False
    cur = conn.execute("INSERT INTO organizations (name, aliases, updated_at) VALUES (?, '[]', ?)",
                       (org, _now()))
    return cur.lastrowid, True


def write_office(conn: sqlite3.Connection, figure_id: str, role: str, org: str) -> dict:
    """Make role – org the figure's first office. Returns what undoing needs."""
    row = conn.execute("SELECT positions, cv_curated FROM figures WHERE id = ?", (figure_id,)).fetchone()
    if row is None:
        raise Refused(f"tokoh tidak dikenal: {figure_id}")
    role, org = " ".join(role.split()), " ".join(org.split())
    if not role or not org:
        raise Refused("isi jabatan dan organisasinya")
    if not is_org(org):
        raise Refused(f"“{org}” bukan organisasi: tulis lembaganya, bukan dapil, pemilu atau periode")
    org_id, added = ensure_org(conn, org)
    name = conn.execute("SELECT name FROM organizations WHERE id = ?", (org_id,)).fetchone()[0]
    positions = _positions(row["positions"])
    new = {"role": role, "org": name, "period": "", "org_id": org_id}
    first = positions[0] if positions and isinstance(positions[0], dict) else None
    # The entry it fixes is replaced: the same office written as one phrase
    # ("Gubernur Jawa Tengah" for Gubernur), or the same role. Another office,
    # or one naming another body, stays below it.
    old_role, old_org = fold(first.get("role")) if first else "", (first or {}).get("org") or ""
    if first is not None and first.get("org_id") is None and (
            not old_role or old_role == fold(role)
            or (not old_org.strip() and (old_role + " ").startswith(fold(role) + " "))):
        new["period"] = first.get("period") or ""
        positions[0] = new
    else:
        positions.insert(0, new)
    wrote = json.dumps(positions, ensure_ascii=False)
    conn.execute("UPDATE figures SET positions = ?, cv_curated = 1 WHERE id = ?", (wrote, figure_id))
    return {"kind": "jabatan", "figure_id": figure_id, "prev": row["positions"],
            "cv_curated": row["cv_curated"], "wrote": wrote, "org_added": org_id if added else None}


def revert_office(conn: sqlite3.Connection, undo: dict) -> None:
    if undo.get("kind") != "jabatan":
        return
    row = conn.execute("SELECT positions FROM figures WHERE id = ?", (undo["figure_id"],)).fetchone()
    if row is None:
        return
    if row["positions"] != undo["wrote"]:
        raise Refused("CV tokoh ini sudah diubah sejak itu; perbaiki jabatannya di /kurasi/tokoh")
    conn.execute("UPDATE figures SET positions = ?, cv_curated = ? WHERE id = ?",
                 (undo["prev"], undo["cv_curated"], undo["figure_id"]))
    added = undo.get("org_added")
    if added is not None:
        still = any(isinstance(p, dict) and p.get("org_id") == added
                    for (raw,) in conn.execute("SELECT positions FROM figures WHERE positions IS NOT NULL")
                    for p in _positions(raw))
        if not still:
            conn.execute("DELETE FROM organizations WHERE id = ?", (added,))


def _point(conn: sqlite3.Connection, point_id: int) -> tuple[sqlite3.Row, dict]:
    p = conn.execute("SELECT id, kind, status, answer, answered_by, proposal FROM curation_points "
                     "WHERE id = ?", (point_id,)).fetchone()
    if p is None or p["kind"] != "jabatan":
        raise Refused(f"bukan poin jabatan: {point_id}")
    return p, json.loads(p["proposal"])


def _verdict(conn, proposal_id: int, verdict: str | None) -> None:
    conn.execute("UPDATE office_proposals SET verdict = ?, decided_at = ? WHERE id = ?",
                 (verdict, _now() if verdict else None, proposal_id))


def answer(conn: sqlite3.Connection, point_id: int, verdict: str,
           role: str | None = None, org: str | None = None) -> str:
    """The curator's answer to a jabatan point: ya | bukan | koreksi | lewati."""
    p, prop = _point(conn, point_id)
    if p["status"] not in ("open", "lewati"):
        raise Refused("poin ini sudah dijawab")
    undo: dict = {"kind": "none"}
    label = None
    if verdict == "ya":
        undo = write_office(conn, prop["figure_id"], prop["role"], prop["org"])
        _verdict(conn, prop["proposal_id"], "confirmed")
    elif verdict == "koreksi":
        role, org = (role or "").strip(), (org or "").strip()
        if fold(role) == fold(prop["role"]) and fold(org) == fold(prop["org"]):
            raise Refused("itu usulan yang sama; jawab Ya")
        undo = write_office(conn, prop["figure_id"], role, org)
        label = f"{' '.join(role.split())} – {' '.join(org.split())}"
        _verdict(conn, prop["proposal_id"], "corrected")
    elif verdict == "bukan":
        _verdict(conn, prop["proposal_id"], "rejected")
    elif verdict != "lewati":
        raise Refused(f"jawaban tidak dikenal: {verdict}")
    conn.execute(
        "UPDATE curation_points SET status = ?, answer = ?, answered_by = 'curator', answered_at = ? "
        "WHERE id = ?", (verdict, json.dumps({"label": label, "undo": undo}, ensure_ascii=False),
                         _now(), point_id))
    return f"jabatan {point_id}: {verdict}" + (f" ({label})" if label else "")


def auto_yes(conn: sqlite3.Connection, prop: dict) -> dict:
    """Auto-answering's "Ya" (curation_points.auto_answer)."""
    undo = write_office(conn, prop["figure_id"], prop["role"], prop["org"])
    _verdict(conn, prop["proposal_id"], "confirmed")
    return undo


def undo(conn: sqlite3.Connection, point_id: int, salah: bool = False) -> str:
    """Put a curator's answer back and ask again; with `salah`, an auto "Ya"
    put back and ruled wrong."""
    p, prop = _point(conn, point_id)
    try:
        recorded = (json.loads(p["answer"]) if p["answer"] else {}).get("undo") or {}
    except ValueError:
        recorded = {}
    if salah:
        if p["status"] != "auto":
            raise Refused("hanya jawaban otomatis yang ditandai salah")
        revert_office(conn, recorded)
        _verdict(conn, prop["proposal_id"], "rejected")
        conn.execute("UPDATE curation_points SET status = 'auto_wrong', answered_by = 'curator', "
                     "answered_at = ? WHERE id = ?", (_now(), point_id))
        return f"jabatan {point_id}: salah"
    if p["answered_by"] != "curator" or p["status"] not in ("ya", "bukan", "koreksi", "lewati"):
        raise Refused("hanya jawaban kurator yang dibatalkan di sini")
    revert_office(conn, recorded)
    _verdict(conn, prop["proposal_id"], None)
    conn.execute("UPDATE curation_points SET status = 'open', answer = NULL, answered_by = NULL, "
                 "answered_at = NULL WHERE id = ?", (point_id,))
    return f"jabatan {point_id}: dibuka lagi"
