"""Pseudonyms for the people whose comments are collected.

Commenters are private individuals. They are not the subject of this site — a
named public official is — and they never opted into appearing next to one.
Publishing their real display name adds nothing a reader can use: what matters
is that a comment came from a distinct person, and which audience it came from.
The name itself is pure exposure.

It is also the sharper edge of the same UU ITE risk the project's design
principles are built around, pointed the other way. `buzzer` labels some of
these accounts as coordinated, and a coordination claim printed beside a real,
searchable name is an accusation against a private individual.

So the display name is never stored. `mask_author` runs at write time, in
`sentiment._store_comments`, and the raw name is discarded before it reaches
the database.

`author_id` is kept, because buzzer's cross-event and burst signals need a
stable identity — but it is hashed first. The raw value is a YouTube channel
id, which resolves straight back to the person at youtube.com/channel/<id>, so
storing it verbatim means the database holds a working link to every commenter.
Buzzer only ever compares the field for equality, so a digest serves it exactly
as well.

What that does and does not buy: it removes the direct lookup, so a leak of the
data (or anyone browsing it) no longer hands over the account. It is not
anonymity against a targeted check — someone who already suspects a specific
person can hash that person's channel id and search for it. Defeating that
needs a secret salt, and a salt kept in this same database would fall with it,
so it is deliberately not attempted here.
"""
from __future__ import annotations

import hashlib

# Short enough to read as a label rather than a checksum, long enough that two
# people never share one. Four digits is plenty within a single event's ~100
# comments but not across the site: at 65536 values and a few thousand
# commenters the birthday bound bites, and a measured 2592 accounts collapsed
# into 2538 labels - 54 pairs of strangers rendering as the same person. Six
# digits puts the expected number of collisions under one.
_DIGITS = 6

PREFIX = "Akun"


def mask_author(author_id: str | None, author_name: str | None = None) -> str:
    """A stable, opaque label for one commenter.

    Derived from `author_id` so the same person reads the same across every
    event they appear in — which is what makes buzzer's "same account, many
    events" finding legible to a reader rather than an unexplained badge.

    Accepts the id either raw or already hashed and gives the same answer for
    both, because it masks a prefix of `hash_author_id`. That is what lets the
    stored id be hashed without every pseudonym shifting underneath it — the
    raw value is gone after the first write, so a mask that depended on it
    could never be recomputed.

    Falls back to the display name only when the platform gave no id, so that a
    row still gets a pseudonym instead of leaking the name by default.
    """
    digest = hash_author_id(author_id)
    if not digest:
        name = (author_name or "").strip()
        if not name:
            return "Anonim"
        digest = hashlib.sha256(name.encode("utf-8")).hexdigest()
    return f"{PREFIX} {digest[:_DIGITS]}"


def hash_author_id(author_id: str | None) -> str:
    """The stored form of a commenter's platform id.

    Full-length so collisions are not a consideration: two accounts colliding
    would merge into one identity in buzzer's counts and manufacture a
    coordination signal out of nothing.

    Idempotent — a value that is already a digest is returned unchanged, so
    re-running the pipeline or the backfill scrub cannot hash twice and break
    the identity that buzzer matches on.
    """
    raw = (author_id or "").strip()
    if not raw or is_hashed(raw):
        return raw
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def is_hashed(value: str | None) -> bool:
    """Whether `value` is already in stored form."""
    if not value or len(value) != 64:
        return False
    return all(c in "0123456789abcdef" for c in value)
