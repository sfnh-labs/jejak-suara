"""Configuration loading from TOML files (stdlib only)."""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
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
        """All lowercased strings that, if present in text, attribute to this figure."""
        return [t.lower() for t in ([self.name, *self.aliases]) if t]


def load_sources(path: Path | None = None) -> list[Source]:
    path = path or ROOT / "sources.toml"
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return [Source(**s) for s in data.get("source", [])]


def load_figures(path: Path | None = None) -> list[Figure]:
    path = path or ROOT / "figures.toml"
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return [Figure(**fig) for fig in data.get("figure", []) if fig.get("active", True)]
