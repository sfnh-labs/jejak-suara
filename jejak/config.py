"""Configuration loading.

Sources stay in TOML. Figures do not: most of them are discovered from the
coverage rather than listed by hand, so the database is the source of truth and
`figures.toml` seeds it (and can override any row).
"""
from __future__ import annotations

import json
import re
import sqlite3
import tomllib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Source:
    name: str
    rss: str
    weight: float = 0.5


@dataclass(frozen=True)
class Figure:
    id: str
    name: str
    role: str
    aliases: list[str] = field(default_factory=list)
    active: bool = True

    def match_terms(self) -> list[str]:
        """All lowercased strings that, if present in text, name this figure."""
        return [t.lower() for t in ([self.name, *self.aliases]) if t]

    def first_named_at(self, text: str) -> int | None:
        """Where `text` first names this figure, as a whole word: the alias
        "Aries" is not in "karies". None if it does not."""
        m = names_pattern(tuple(self.match_terms())).search(text)
        return m.start() if m else None


@lru_cache(maxsize=4096)
def names_pattern(terms: tuple[str, ...]) -> re.Pattern:
    """Any of `terms`, case-insensitive, never inside a longer word."""
    alt = "|".join(re.escape(t) for t in sorted(set(terms), key=len, reverse=True) if t)
    return re.compile(rf"(?<!\w)(?:{alt})(?!\w)" if alt else r"(?!x)x", re.I)


def load_sources(path: Path | None = None) -> list[Source]:
    path = path or ROOT / "sources.toml"
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return [Source(**s) for s in data.get("source", [])]


def load_figures_toml(path: Path | None = None) -> list[Figure]:
    """The hand-maintained seed list."""
    path = path or ROOT / "figures.toml"
    if not Path(path).exists():
        return []
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return [
        Figure(
            id=fig["id"],
            name=fig["name"],
            role=fig.get("role", ""),
            aliases=list(fig.get("aliases", [])),
            active=fig.get("active", True),
        )
        for fig in data.get("figure", [])
    ]


def seed_figures(conn: sqlite3.Connection, path: Path | None = None) -> int:
    """Write figures.toml into the database, overriding rows it names."""
    rows = load_figures_toml(path)
    now = datetime.now(timezone.utc).isoformat()
    for fig in rows:
        conn.execute(
            """INSERT INTO figures (id, name, role, aliases, active, origin, created_at)
               VALUES (?, ?, ?, ?, ?, 'config', ?)
               ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,
                 role=excluded.role,
                 aliases=excluded.aliases,
                 active=excluded.active,
                 origin='config'""",
            (fig.id, fig.name, fig.role,
             json.dumps(fig.aliases, ensure_ascii=False),
             1 if fig.active else 0, now),
        )
    conn.commit()
    return len(rows)


def load_figures(conn: sqlite3.Connection | None = None) -> list[Figure]:
    """Every active tracked figure.

    Reads the database, seeding it from figures.toml the first time. Callers
    without a connection get one opened for them, so the many call sites that
    just want "who do we track" stay unchanged.
    """
    from . import db  # imported here: db has no config dependency to invert

    own = conn is None
    conn = conn or db.connect()
    try:
        try:
            empty = conn.execute("SELECT count(*) FROM figures").fetchone()[0] == 0
        except sqlite3.OperationalError:
            return load_figures_toml()  # database not initialised yet
        if empty:
            seed_figures(conn)
        rows = conn.execute(
            "SELECT id, name, role, aliases FROM figures WHERE active = 1 ORDER BY name"
        ).fetchall()
    finally:
        if own:
            conn.close()

    figures = []
    for row in rows:
        try:
            aliases = json.loads(row["aliases"]) if row["aliases"] else []
        except (TypeError, ValueError):
            aliases = []
        figures.append(Figure(id=row["id"], name=row["name"],
                              role=row["role"] or "", aliases=aliases))
    return figures
