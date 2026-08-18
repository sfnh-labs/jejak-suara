"""Redaction for the people whose comments are collected.

Commenters are private individuals. They are not the subject of this site — a
named public official is — and they never opted into appearing next to one.

It is also the sharper edge of the same UU ITE risk the project's design
principles are built around, pointed the other way. `buzzer` labels some of
these accounts as coordinated, and a coordination claim printed beside a
resolvable identity is an accusation against a private individual.

So the display name is never stored in full. `mask_author` runs at write time,
in `sentiment._store_comments`, and only the redacted form reaches the
database.

What partial redaction does and does not buy. It keeps the name recognisable
as a name — a reader sees distinct people rather than a wall of hashes — and it
costs a casual reader the ability to copy a name straight into a search box.
It is *not* de-identification. These are YouTube handles, which resolve
publicly, and the first and last characters plus the exact length usually
narrow a handle to one account: `@Makhsus` shows as `@Ma**sus`, which is six of
its eight characters. Anyone who sets out to identify a specific commenter
will succeed. This is a deliberate trade of privacy for legibility, chosen
knowing that; it is not a security control and must not be described as one.

`author_id` is the part that is genuinely removed. buzzer's cross-event and
burst signals need a stable identity, so the field is kept — but hashed. The
raw value is a channel id that resolves straight back to the person at
youtube.com/channel/<id>, so storing it verbatim means the database holds a
working link to every commenter. buzzer only ever compares the field for
equality, so a digest serves it exactly as well.

That hash is not anonymity against a targeted check either — someone who
already suspects a specific person can hash that person's channel id and search
for it. Defeating that needs a secret salt, and a salt kept in this same
database would fall with it, so it is deliberately not attempted here.
"""
from __future__ import annotations

import hashlib

# How many characters stay legible at each end. Three is enough to recognise a
# name you already know without printing it whole.
_VISIBLE = 3

# Never redact so little that the mask is pointless. A name short enough that
# keeping three at each end would hide fewer than this many characters keeps
# proportionally less instead, and a very short one is hidden outright.
_MIN_HIDDEN = 2

HIDDEN = "*"

FALLBACK = "Anonim"


def mask_author(author_name: str | None) -> str:
    """A display name with its middle replaced by `*`.

    `sleepy-cat` reads as `sle****cat`: the ends stay, the middle goes, and the
    length is preserved so the result still looks like the name it came from.

    Idempotent, which is what makes it safe to run over stored rows. The
    characters it keeps are the ones it would keep on a second pass, and the
    run of `*` it writes is exactly as long as the run it would hide, so
    masking an already-masked name returns it unchanged — including the
    no-name fallback, which is a word and would otherwise be redacted into
    something that reads like a real commenter. That matters because
    the raw name is discarded at write time — a mask that shifted on re-run
    could never be recomputed from what is actually in the database.
    """
    name = (author_name or "").strip()
    if not name or name == FALLBACK:
        return FALLBACK

    keep = min(_VISIBLE, max(0, (len(name) - _MIN_HIDDEN) // 2))
    if keep == 0:
        return HIDDEN * len(name)
    return name[:keep] + HIDDEN * (len(name) - 2 * keep) + name[-keep:]


def is_masked(value: str | None) -> bool:
    """Whether `value` has already been through `mask_author`.

    Only a guess — a real display name is allowed to contain `*` — so this is
    for reporting and for refusing to re-mask, never for deciding that a row is
    safe to publish.
    """
    return bool(value) and HIDDEN in value


def hash_author_id(author_id: str | None) -> str:
    """The stored form of a commenter's platform id.

    Full-length so collisions are not a consideration: two accounts colliding
    would merge into one identity in buzzer's counts and manufacture a
    coordination signal out of nothing.

    Idempotent — a value that is already a digest is returned unchanged, so
    re-running the pipeline or the stored-row scrub cannot hash twice and break
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
