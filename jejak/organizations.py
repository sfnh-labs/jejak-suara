"""Organisations as a datapoint, not just a word on a CV.

An office on a figure's CV is {"role", "org", "period"} in figures.positions,
and "org" is free text: "DPR", "DPR RI" and "Dewan Perwakilan Rakyat" are the
same body written three ways, and "Pemilu 2024" is no body at all. This
module ties each office to one row of `organizations`:

  * seed()  adds the rows organizations.toml lists that the table lacks, and
    fills a row's empty short name, kind or aliases from it. A row the
    curator edited in /kurasi/organisasi keeps what they wrote.
  * link()  sets positions[].org_id on every office whose org text matches
    an organisation by its name, short name or an alias (case, accents,
    dashes and spacing aside), and drops an org_id that no longer matches.
    The org text itself is left as written: it is what the CV says, and
    figures.role, which the site shows, is built from it.
  * unlinked() is the org text that matched nothing, most-used first: the
    names to add to the list, or to correct on the CV.

Run each cycle from the `kurasi` stage, and on its own:

    python -m jejak.cli organizations
"""
from __future__ import annotations

import json
import re
import sqlite3
import tomllib
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .config import ROOT

SEED = ROOT / "organizations.toml"

KINDS = ("kementerian", "lembaga", "parlemen", "pemerintah", "kabinet", "partai", "aparat",
         "bumn", "swasta", "ormas", "kampus", "media", "olahraga", "internasional", "lainnya")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fold(text: str | None) -> str:
    """The form names are compared in: no accents or case, one kind of dash, single spaces."""
    t = unicodedata.normalize("NFKD", text or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    t = re.sub(r"[‐-―−]", "-", t)
    return " ".join(t.split())


def _aliases(raw: str | None) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    return [str(a) for a in value if str(a).strip()] if isinstance(value, list) else []


def load_seed(path: Path = SEED) -> list[dict]:
    with open(path, "rb") as f:
        rows = tomllib.load(f).get("org", [])
    out = []
    for r in rows:
        name = " ".join(str(r.get("name", "")).split())
        if not name:
            raise ValueError(f"{path}: an [[org]] without a name")
        kind = r.get("kind")
        if kind is not None and kind not in KINDS:
            raise ValueError(f"{path}: {name}: unknown kind {kind!r}")
        out.append({"name": name, "short": (r.get("short") or "").strip() or None,
                    "aliases": [a.strip() for a in r.get("aliases", []) if a.strip()], "kind": kind})
    return out


def seed(conn: sqlite3.Connection, path: Path = SEED) -> dict:
    """Add what the seed has and the table lacks; fill only empty fields."""
    added = filled = 0
    now = _now()
    for o in load_seed(path):
        row = conn.execute(
            "SELECT id, short_name, aliases, kind FROM organizations WHERE name = ? OR short_name = ?",
            (o["name"], o["name"]),
        ).fetchone()
        if row is None:
            # A short name already taken by another row stays with that row.
            short = o["short"]
            if short and conn.execute("SELECT 1 FROM organizations WHERE name = ? OR short_name = ?",
                                      (short, short)).fetchone():
                short = None
            conn.execute(
                "INSERT INTO organizations (name, short_name, aliases, kind, updated_at) VALUES (?, ?, ?, ?, ?)",
                (o["name"], short, json.dumps(o["aliases"], ensure_ascii=False), o["kind"], now),
            )
            added += 1
            continue
        sets, args = [], []
        if not row["short_name"] and o["short"] and not conn.execute(
                "SELECT 1 FROM organizations WHERE (name = ? OR short_name = ?) AND id <> ?",
                (o["short"], o["short"], row["id"])).fetchone():
            sets.append("short_name = ?"); args.append(o["short"])
        if not _aliases(row["aliases"]) and o["aliases"]:
            sets.append("aliases = ?"); args.append(json.dumps(o["aliases"], ensure_ascii=False))
        if not row["kind"] and o["kind"]:
            sets.append("kind = ?"); args.append(o["kind"])
        if sets:
            conn.execute(f"UPDATE organizations SET {', '.join(sets)}, updated_at = ? WHERE id = ?",
                         (*args, now, row["id"]))
            filled += 1
    return {"added": added, "filled": filled}


def index(conn: sqlite3.Connection) -> dict[str, int]:
    """Every spelling of every organisation -> its id. Names win over short names over aliases."""
    rows = conn.execute("SELECT id, name, short_name, aliases FROM organizations ORDER BY id").fetchall()
    out: dict[str, int] = {}
    for tier in ("name", "short", "alias"):
        for r in rows:
            keys = ([r["name"]] if tier == "name" else [r["short_name"]] if tier == "short"
                    else _aliases(r["aliases"]))
            for k in keys:
                f = fold(k)
                if f and f not in out:
                    out[f] = r["id"]
    return out


def _positions(raw: str | None) -> list | None:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, list) else None


def link(conn: sqlite3.Connection) -> dict:
    """Set positions[].org_id from the org text, on every figure. Safe to repeat."""
    ids = index(conn)
    linked = unlinked = changed = 0
    for f in conn.execute("SELECT id, positions FROM figures WHERE positions IS NOT NULL").fetchall():
        positions = _positions(f["positions"])
        if not positions:
            continue
        touched = False
        for p in positions:
            if not isinstance(p, dict):
                continue
            org_id = ids.get(fold(p.get("org")))
            if org_id is None:
                unlinked += bool((p.get("org") or "").strip())
                if "org_id" in p:
                    del p["org_id"]
                    touched = True
            else:
                linked += 1
                if p.get("org_id") != org_id:
                    p["org_id"] = org_id
                    touched = True
        if touched:
            conn.execute("UPDATE figures SET positions = ? WHERE id = ?",
                         (json.dumps(positions, ensure_ascii=False), f["id"]))
            changed += 1
    return {"linked": linked, "unlinked": unlinked, "figures_changed": changed}


def unlinked(conn: sqlite3.Connection, active_only: bool = True) -> list[tuple[str, int]]:
    """Org text on offices that matches no organisation, most-used first."""
    ids = index(conn)
    seen: Counter[str] = Counter()
    where = "WHERE active AND positions IS NOT NULL" if active_only else "WHERE positions IS NOT NULL"
    for f in conn.execute(f"SELECT positions FROM figures {where}"):
        for p in _positions(f["positions"]) or []:
            org = " ".join(str(p.get("org") or "").split()) if isinstance(p, dict) else ""
            if org and fold(org) not in ids:
                seen[org] += 1
    return seen.most_common()


def run(conn: sqlite3.Connection) -> dict:
    out = {**seed(conn), **link(conn)}
    conn.commit()
    return out
