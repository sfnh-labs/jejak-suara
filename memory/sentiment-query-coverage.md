---
name: sentiment-query-coverage
description: Why some events get 0 YouTube sentiment, and the query-builder fix
metadata:
  type: project
---

The sentiment stage (`jejak/sentiment.py`) searches YouTube by event, gathers
comments, and classifies them. `_query_for_event` originally built
`f"{name} {title}"` — a full verbatim headline that (a) duplicated the figure name
(headlines usually already name the figure) and (b) was too long/specific, so
YouTube returned **0 videos**.

Fixed 2026-06-13: the builder now drops the figure name when an alias/name already
appears in the title, strips Indonesian filler stopwords, and caps to
`_QUERY_MAX_WORDS` (7) content words. After the fix, most events find 60–120
comments; niche events (e.g. a diplomatic phone call) still legitimately return ~0,
and the stage stores no sentiment row in that case (sample_size 0).

Still-open limitation (README roadmap): **no relevance pre-filter** — broad queries
can pull comments about the figure generally rather than the specific event. Verified
end-to-end on event 10 (Amien Rais): 100 comments → Haiku → score -0.33 "negative",
shown on timeline + web as "public reaction (YouTube)". See also [[env-setup]].
