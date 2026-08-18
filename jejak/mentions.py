"""Discover public figures from the coverage itself, instead of a curated list.

Indonesian reporting almost always names a person together with their role —
"Menkeu Sri Mulyani", "Rektor UI Ari Kuncoro", "Ketua Umum PSSI Erick Thohir".
One such mention yields everything needed at once: a candidate person, the role
they hold, the organisation it belongs to, and a date from the article.

Nothing here is specific to politics. The gazetteer is a list of role words, and
a rector, a union chair and a minister are all extracted by the same rule.

What this produces is *candidates*, never published facts. A candidate becomes a
tracked figure only after enough distinct outlets mention them, the same
corroboration test that governs peristiwa.
"""
from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone

# Role words that introduce a person. Ordered longest-first at match time so
# "Wakil Menteri" wins over "Menteri". Deliberately mixed-domain.
TITLES: tuple[str, ...] = (
    # government / state
    "Presiden", "Wakil Presiden", "Menteri", "Wakil Menteri", "Menko",
    "Menkeu", "Mendagri", "Menlu", "Menhan", "Menkes", "Mendikbud",
    "Menkumham", "Mensesneg", "Sekjen", "Dirjen", "Direktur Jenderal",
    "Gubernur", "Wakil Gubernur", "Bupati", "Wakil Bupati", "Wali Kota",
    "Wakil Wali Kota", "Camat", "Lurah", "Kepala Daerah", "Juru Bicara",
    # legislature / judiciary / commissions
    "Ketua", "Wakil Ketua", "Ketua Umum", "Sekretaris Jenderal", "Anggota",
    "Hakim", "Ketua Hakim", "Jaksa", "Jaksa Agung", "Komisioner",
    # collective actors — see _COLLECTIVE_TITLES below
    "Pimpinan", "Pengurus", "Sekretaris", "Bendahara", "Kuasa Hukum",
    "Juru Bicara", "Pakar", "Advokat", "Aktivis", "Pengamat",
    # security
    "Kapolri", "Kapolda", "Kapolres", "Panglima", "Kepala Staf", "Danrem",
    # academia
    "Rektor", "Wakil Rektor", "Dekan", "Guru Besar", "Profesor", "Dosen",
    "Peneliti", "Kepala Sekolah",
    # business / civil society / other
    "Direktur", "Direktur Utama", "Komisaris", "Komisaris Utama", "CEO",
    "Pendiri", "Kepala", "Koordinator", "Manajer", "Pelatih", "Kapten",
    # Newsroom abbreviations. Indonesian headlines contract almost every title
    # to save characters, and the long form above never matches them. Missing
    # them is not merely a lost discovery: attribution treats a headline with
    # no preceding title as being *about* the first tracked figure named, so
    # "Jubir PCO Sebut Prabowo..." landed on Prabowo's own timeline when it is
    # the spokesman speaking about him.
    "Jubir", "Waketum", "Wamen", "Wagub", "Wabup", "Wawali", "Wakapolri",
    "Wakapolda", "Kapolsek", "Kabareskrim", "Kadiv", "Kadis", "Kabid",
    "Kabag", "Kasat", "Karo", "Dirut", "Wadir", "Plt", "Plh",
)

# Longest first so multi-word titles are not shadowed by their prefix.
_TITLE_ALT = "|".join(
    re.escape(t) for t in sorted(TITLES, key=len, reverse=True)
)

# A person's name: 1–3 capitalised words. Indonesian names frequently lack a
# surname, so a single capitalised token is legitimate.
_NAME = r"[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}"

# "<Title><capitalised run>", e.g. "Rektor UI Ari Kuncoro". Both the qualifier
# and the person are capitalised, so the run is split afterwards by _split_run
# rather than by the pattern itself.
_MENTION_RE = re.compile(
    rf"\b(?P<title>{_TITLE_ALT})\b(?P<run>(?:\s+[A-Z][A-Za-z'-]*){{1,6}})"
)

# Matching runs sentence by sentence: a capitalised run must not cross a full
# stop, or "…Prabowo Subianto. Pilihan lain…" reads as a four-word name.
_SENTENCE_RE = re.compile(r"[.!?;\n]+")

# Place names that qualify a role rather than naming a person, so "Gubernur Jawa
# Tengah Ahmad Luthfi" yields Ahmad Luthfi and not "Jawa Tengah Ahmad".
_PLACES = {
    "aceh", "sumatera", "utara", "barat", "selatan", "timur", "tengah", "riau",
    "jambi", "bengkulu", "lampung", "bangka", "belitung", "kepulauan", "riau",
    "jakarta", "dki", "banten", "jawa", "yogyakarta", "diy", "bali", "nusa",
    "tenggara", "ntb", "ntt", "kalimantan", "sulawesi", "gorontalo", "maluku",
    "papua", "pegunungan", "barat daya", "bandung", "surabaya", "medan",
    "semarang", "makassar", "palembang", "depok", "bekasi", "tangerang",
    "bogor", "surakarta", "solo", "malang", "padang", "pekanbaru", "manado",
    "denpasar", "samarinda", "banjarmasin", "pontianak", "jayapura", "kota",
    "kabupaten", "provinsi", "raya",
}

# Domain words that extend a role ("Menteri Keuangan", "Dosen Teknik").
_ROLE_WORDS = {
    "keuangan", "pertahanan", "pendidikan", "kebudayaan", "kesehatan",
    "dalam", "luar", "negeri", "hukum", "ham", "agama", "sosial", "pertanian",
    "perdagangan", "perindustrian", "perhubungan", "komunikasi", "digital",
    "informatika", "teknik", "ekonomi", "hukum", "politik", "riset",
    "teknologi", "investasi", "koordinator", "bidang", "umum", "utama",
    "jenderal", "besar", "staf", "eksekutif", "operasional", "keuangan",
    "pemuda", "olahraga", "energi", "sumber", "daya", "mineral", "komisi",
    "koperasi", "desa", "transmigrasi", "lingkungan", "hidup", "kehutanan",
    "kelautan", "perikanan", "pariwisata", "ekonomi", "kreatif", "tenaga",
    "kerja", "pekerjaan", "perumahan", "rakyat", "badan", "usaha", "milik",
    "pemberdayaan", "perempuan", "perlindungan", "anak", "imigrasi",
    "pemasyarakatan", "reformasi", "birokrasi", "aparatur", "sipil",
    "sekretariat", "kabinet", "kepala", "wakil", "muda", "madya",
    "universitas", "institut", "politeknik", "akademi", "fakultas", "sekolah",
    "yayasan", "perkumpulan", "asosiasi", "ikatan", "persatuan",
}

# Role words directly followed by the institution's own proper name.
_INSTITUTION_WORDS = {
    "universitas", "institut", "politeknik", "akademi", "sekolah", "yayasan",
    "perkumpulan", "asosiasi", "ikatan", "persatuan", "partai", "fakultas",
}

# Titles that are inherently scoped to a place, so the word right after them
# names a jurisdiction rather than the person — "Kapolres Bangkalan Wibowo".
# There are far too many regencies to enumerate in _PLACES.
# Institution-scoped titles (Rektor, Dekan) are deliberately absent: their
# qualifier is an organisation, which the acronym rule and the institution words
# below already handle, and stripping a word unconditionally would eat a name.
_PLACE_SCOPED_TITLES = {
    "Gubernur", "Wakil Gubernur", "Bupati", "Wakil Bupati", "Wali Kota",
    "Wakil Wali Kota", "Camat", "Lurah", "Kapolda", "Kapolres", "Danrem",
    "Kepala Daerah",
}

# Words that look like names but never are, so "Menteri Keuangan Republik" does
# not become a person called Republik.
_NOT_A_NAME = {
    "republik", "indonesia", "negara", "nasional", "pusat", "daerah", "umum",
    "sementara", "terpilih", "baru", "lama", "kita", "mereka", "dan", "atau",
    "yang", "itu", "ini", "tersebut", "juga", "akan", "saat", "usai", "soal",
    "kepada", "dari", "untuk", "dalam", "dengan", "pada", "bahwa", "ketika",
    "senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu",
    "januari", "februari", "maret", "april", "mei", "juni", "juli",
    "agustus", "september", "oktober", "november", "desember",
}

# Tokens between title and name that name an organisation rather than a person.
_ORG_HINT_RE = re.compile(r"^[A-Z]{2,}$")


@dataclass(frozen=True)
class Mention:
    name: str
    role: str
    org: str | None

    @property
    def slug(self) -> str:
        return slugify(self.name)


def slugify(name: str) -> str:
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def _plausible_name(name: str) -> bool:
    words = name.split()
    if not words:
        return False
    if any(w.lower() in _NOT_A_NAME for w in words):
        return False
    # All-caps is an organisation, not a person: "PSI", "PBNU", "KPK".
    if all(w.isupper() for w in words):
        return False
    # A lone two-letter capital is an acronym, not a person.
    return not (len(words) == 1 and len(words[0]) <= 2)


_TITLE_PRESENT_RE = re.compile(rf"\b(?:{_TITLE_ALT})\b")


# People are often named with no office at all — "Cak Imin: ...", "kata Jusuf
# Kalla". They are still actors, so they become candidates with an empty role;
# a later article that names their office fills it in.
_SPEAKER_RE = re.compile(
    r"(?:^|[,;]\s+)(?P<name>[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2})\s*:"
)
_ATTRIBUTION_RE = re.compile(
    r"\b(?:[Kk]ata|[Mm]enurut|[Uu]jar|[Ss]ebut|[Tt]egas|[Uu]ngkap)\s+"
    r"(?P<name>[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2})"
)

NO_ROLE = ""

# Titles naming a body rather than an individual. They still mark who is acting
# — which is what attribution needs — but must not create a person: "Pengurus
# Besar Nahdlatul Ulama" is an organisation, not someone called Nahdlatul Ulama.
_COLLECTIVE_TITLES = {"Pimpinan", "Pengurus", "Sekretariat", "Komisi", "Anggota"}


def first_title_position(text: str) -> int | None:
    """Where the first titled office-holder is named, if any.

    Used to decide who an article is about: whoever is named first is the
    actor, so a title appearing before a tracked figure means the article
    belongs to that office-holder rather than to the figure.
    """
    match = _TITLE_PRESENT_RE.search(text or "")
    return match.start() if match else None


def extract(text: str) -> list[Mention]:
    """Every distinct person acting in `text`, with their role when stated.

    Two kinds are collected. People named with an office ("Menkeu Sri Mulyani")
    give a role immediately. People named without one ("Cak Imin: ...", "kata
    Jusuf Kalla") are just as much actors, so they are collected with an empty
    role — a later article that states their office fills it in, because the
    roster is rebuilt from all accumulated mentions on every run.

    Deliberately pattern-based rather than model-based. A local model was tried
    for the "Rektor UI Ari Kuncoro" ambiguity and did worse: on a two-person
    sentence qwen2.5 returned only one of them. This is deterministic, needs no
    Ollama (so it runs in CI), and costs nothing per article.

    Wrong splits are survivable anyway, because promotion needs several outlets
    to produce the *same* name, and a mis-split follows one article's phrasing.
    """
    if not text:
        return []
    found: dict[tuple[str, str], Mention] = {}
    matches = (
        m
        for sentence in _SENTENCE_RE.split(text)
        for m in _MENTION_RE.finditer(sentence)
    )
    for m in matches:
        if m.group("title") in _COLLECTIVE_TITLES:
            continue
        words = m.group("run").split()
        org_words = [w for w in words if _ORG_HINT_RE.match(w)]
        rest = [w for w in words if not _ORG_HINT_RE.match(w)]

        # Leading place/domain words qualify the role; the tail is the person.
        cut = 0
        # A place-scoped title always takes a jurisdiction first, even one not
        # in _PLACES — but only when something is left over to be the name.
        if m.group("title") in _PLACE_SCOPED_TITLES and len(rest) > 1:
            cut = 1
        for i, word in enumerate(rest):
            lowered = word.lower()
            if lowered in _INSTITUTION_WORDS:
                # The institution's own name follows ("Universitas Paramadina"),
                # so take one more word with it. Longer names such as "Institut
                # Teknologi Bandung" still leave a token behind; corroboration
                # is what stops such stragglers from being promoted.
                cut = i + 2
            elif lowered in _PLACES or lowered in _ROLE_WORDS:
                cut = i + 1
        role_words, name_words = rest[:cut], rest[cut:][:3]
        if not name_words:
            continue

        name = " ".join(name_words)
        if not _plausible_name(name):
            continue
        role = " ".join([m.group("title"), *role_words])
        org = " ".join(org_words) if org_words else None
        found.setdefault((slugify(name), role.lower()),
                         Mention(name=name, role=role, org=org))

    # Untitled actors. Only recorded when the same person was not already found
    # with an office in this text, so a stated role always wins.
    titled = {slug for slug, _ in found}
    for pattern in (_SPEAKER_RE, _ATTRIBUTION_RE):
        for m in pattern.finditer(text):
            name = " ".join(m.group("name").split())
            if not _plausible_name(name):
                continue
            slug = slugify(name)
            if slug in titled:
                continue
            found.setdefault((slug, NO_ROLE),
                             Mention(name=name, role=NO_ROLE, org=None))
    return list(found.values())


def merge_aliases(conn: sqlite3.Connection) -> int:
    """Fold short-form names into the fuller name of the same person.

    Coverage alternates between "Prabowo" and "Prabowo Subianto", which arrive
    as two candidates. A candidate whose words are a leading subsequence of a
    longer candidate's, sharing at least one role, is the same person written
    shorter — so its mentions move to the longer name and its evidence counts
    towards that one candidate rather than being split across two.
    """
    rows = conn.execute(
        """SELECT fc.slug, fc.name, count(*) AS mentions
             FROM figure_candidates fc
             JOIN figure_mentions m ON m.slug = fc.slug
            WHERE fc.status = 'candidate'
            GROUP BY fc.slug"""
    ).fetchall()

    def roles(slug: str) -> set[str]:
        """First word of each stated office. Untitled mentions contribute none."""
        out: set[str] = set()
        for r in conn.execute(
            "SELECT role FROM figure_mentions WHERE slug = ?", (slug,)
        ):
            words = (r["role"] or "").split()
            if words:
                out.add(words[0].lower())
        return out

    merged = 0
    by_length = sorted(rows, key=lambda r: len(r["name"].split()))
    for short in by_length:
        short_words = short["name"].lower().split()
        for long in reversed(by_length):
            long_words = long["name"].lower().split()
            if long["slug"] == short["slug"] or len(long_words) <= len(short_words):
                continue
            if long_words[: len(short_words)] != short_words:
                continue
            short_roles, long_roles = roles(short["slug"]), roles(long["slug"])
            # An unknown office cannot contradict a known one, so a name that is
            # a leading subsequence still merges — "Prabowo" appearing untitled
            # is the same person as "Prabowo Subianto, Presiden".
            if short_roles and long_roles and not (short_roles & long_roles):
                continue
            conn.execute(
                "UPDATE OR IGNORE figure_mentions SET slug = ? WHERE slug = ?",
                (long["slug"], short["slug"]),
            )
            conn.execute("DELETE FROM figure_mentions WHERE slug = ?", (short["slug"],))
            conn.execute("DELETE FROM figure_candidates WHERE slug = ?", (short["slug"],))
            merged += 1
            break
    conn.commit()
    return merged


# How many distinct outlets must name someone before they are tracked. Same
# significance test as peristiwa: independent corroboration, not an editor's
# list. Extraction noise is idiosyncratic to one article's phrasing, so it very
# rarely clears this bar.
PROMOTE_MIN_OUTLETS = 3


def promote_figures(conn: sqlite3.Connection) -> dict[str, int]:
    """Turn well-corroborated candidates into tracked figures.

    A figure may arrive with no role at all — plenty of people are named
    without an office ("Cak Imin: ..."). That is fine: the role is refreshed
    from the accumulated mentions on every run, so it fills in as soon as an
    article states one, and improves as coverage accumulates.
    """
    from .config import seed_figures

    # Seed the hand-maintained roster first, so a configured figure is never
    # re-created as a discovered one and then overwritten.
    if conn.execute("SELECT count(*) FROM figures").fetchone()[0] == 0:
        seed_figures(conn)

    stats = {"promoted": 0, "updated": 0}
    now = datetime.now(timezone.utc).isoformat()

    rows = conn.execute(
        f"""SELECT m.slug, fc.name, count(DISTINCT m.source) AS outlets
              FROM figure_mentions m
              JOIN figure_candidates fc ON fc.slug = m.slug
             GROUP BY m.slug
            HAVING outlets >= {PROMOTE_MIN_OUTLETS}"""
    ).fetchall()

    for row in rows:
        slug, name = row["slug"], row["name"]
        # Most frequently reported office wins; empty roles are ignored so a
        # single titled mention beats many untitled ones.
        role_row = conn.execute(
            """SELECT role FROM figure_mentions
                WHERE slug = ? AND role IS NOT NULL AND role != ''
                GROUP BY role ORDER BY count(*) DESC LIMIT 1""",
            (slug,),
        ).fetchone()
        role = role_row["role"] if role_row else ""

        aliases = sorted({
            r["name"] for r in conn.execute(
                "SELECT name FROM figure_candidates WHERE slug = ?", (slug,)
            )
        } | {name})

        existing = conn.execute(
            "SELECT id, origin FROM figures WHERE id = ?", (slug,)
        ).fetchone()
        if existing is None:
            conn.execute(
                """INSERT INTO figures (id, name, role, aliases, active, origin, created_at)
                   VALUES (?, ?, ?, ?, 1, 'discovered', ?)""",
                (slug, name, role, json.dumps(aliases, ensure_ascii=False), now),
            )
            stats["promoted"] += 1
        elif existing["origin"] == "discovered":
            # Never overwrite a hand-configured row from figures.toml.
            conn.execute(
                "UPDATE figures SET name = ?, role = ? WHERE id = ?",
                (name, role, slug),
            )
            stats["updated"] += 1

        conn.execute(
            "UPDATE figure_candidates SET status = 'tracked', promoted_at = ? "
            "WHERE slug = ? AND status != 'tracked'",
            (now, slug),
        )

    conn.commit()
    return stats


def record_mentions(conn: sqlite3.Connection, limit: int = 500) -> dict[str, int]:
    """Scan articles not yet mined and store the mentions they contain.

    Each row keeps the article it came from, so a candidate's evidence — and
    later a CV entry's provenance — can always be traced back to reporting.
    """
    stats = {"scanned": 0, "mentions": 0, "candidates": 0}
    rows = conn.execute(
        """SELECT a.id, a.title, a.summary, a.body, a.source, a.published_at
             FROM articles a
             LEFT JOIN article_scans s ON s.article_id = a.id
            WHERE s.article_id IS NULL
            LIMIT ?""",
        (limit,),
    ).fetchall()

    for art in rows:
        stats["scanned"] += 1
        text = "\n".join(
            part for part in (art["title"], art["summary"], art["body"]) if part
        )
        for mention in extract(text):
            existing = conn.execute(
                "SELECT slug FROM figure_candidates WHERE slug = ?",
                (mention.slug,),
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO figure_candidates (slug, name, status) "
                    "VALUES (?, ?, 'candidate')",
                    (mention.slug, mention.name),
                )
                stats["candidates"] += 1
            conn.execute(
                """INSERT OR IGNORE INTO figure_mentions
                   (slug, article_id, role, org_name, source, seen_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (mention.slug, art["id"], mention.role, mention.org,
                 art["source"], art["published_at"]),
            )
            stats["mentions"] += 1
        conn.execute(
            "INSERT OR IGNORE INTO article_scans (article_id) VALUES (?)",
            (art["id"],),
        )

    conn.commit()
    stats["merged"] = merge_aliases(conn)
    stats.update(promote_figures(conn))
    return stats
