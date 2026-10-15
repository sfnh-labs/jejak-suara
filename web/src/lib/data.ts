import { query, queryOne } from "./db";
import { peristiwaImage, themeImage } from "./peristiwa-images";
import type {
  EventRecord,
  FeedItem,
  FigureSummary,
  Peristiwa,
  PublicComment,
  SentimentPoint,
  StoryStep,
} from "./types";

/**
 * What "published" means, in one place.
 *
 * Two independent gates. `status` is the pipeline's own progress marker, and
 * everything from clustering onward is public — see the note on RECORD_SELECT
 * for why this is not `= 'approved'`. `curated` is the human override written
 * by /kurasi; it is a Postgres-only column the pipeline never touches, so a
 * rejection survives the next crawl's sync (scripts/sync_to_neon.py).
 *
 * A third, weaker gate: an event the pipeline's suggester auto-hid
 * (curation_suggestions.auto_hide, off unless enabled and proven precise)
 * stays down only while no curator has ruled on it. Any verdict wins.
 *
 * IS DISTINCT FROM, not `<>`: a plain inequality is NULL for the untouched
 * rows, which is every event nobody has curated yet, and would hide the site.
 */
export const LIVE = (alias: string) =>
  `${alias}.status IN ('new', 'summarized', 'approved')
   AND ${alias}.curated IS DISTINCT FROM 'rejected'
   AND (${alias}.curated IS NOT NULL OR NOT EXISTS (
     SELECT 1 FROM curation_suggestions cs
      WHERE cs.event_id = ${alias}.id AND cs.auto_hide = 1))`;

/**
 * Everything a record card needs, aggregated per event.
 *
 * Source articles and comment stances are folded up in LATERAL subqueries
 * rather than joined directly — a plain LEFT JOIN would emit one row per source
 * article per event and silently multiply every card.
 *
 * The summary is LEFT JOINed and the status filter matches getPeristiwa's, on
 * purpose. Requiring `status = 'approved'` plus an inner join on
 * `event_summaries` made a record wait for the summarize stage while a
 * peristiwa published the moment it clustered — so every fresh crawl added
 * only peristiwa to the top of the feed, and the recent end of the timeline
 * was one kind of thing. Both kinds now become visible at the same point in
 * the pipeline, and the feed is ordered by date rather than by how far each
 * kind has progressed.
 *
 * Corroboration therefore has to be counted from the articles rather than read
 * off the summary, which does not exist yet for a freshly clustered record.
 */
// The feed is ordered by when the event happened, which is the date the card
// prints. Ordering by last_seen (when it was last reported) instead put a
// still-running story back at the top, but the dateline stayed at event_date —
// so the visible dates ran 16, 18, 17, 23 Agu down the rail and the feed read
// as broken. A record that is still being covered now surfaces through the
// 3-day cluster window in cluster.py, which starts it a new record, rather
// than through re-sorting an old one; last_seen stays stored and synced.
const FEED_ORDER = "e.event_date";

const RECORD_SELECT = `
  SELECT e.id                         AS event_id,
         e.figure_id,
         COALESCE(f.name, e.figure_id) AS figure_name,
         e.event_date,
         e.last_seen,
         e.title,
         e.event_type,
         es.summary_text              AS summary,
         e.quote,
         e.quote_url,
         COALESCE(es.corroboration_count, src.outlet_count, 0) AS corroboration_count,
         COALESCE(es.single_source_flag,
                  CASE WHEN COALESCE(src.outlet_count, 0) <= 1 THEN 1 ELSE 0 END)
                                      AS single_source_flag,
         COALESCE(src.sources, '[]'::json) AS sources,
         s.score                      AS sentiment_score,
         s.label                      AS sentiment_label,
         s.sample_size                AS sentiment_sample_size,
         json_build_object(
           'positive', COALESCE(d.positive, 0),
           'neutral',  COALESCE(d.neutral, 0),
           'negative', COALESCE(d.negative, 0),
           'total',    COALESCE(d.total, 0)
         )                            AS stance,
         json_build_object(
           'positive', COALESCE(d.fig_positive, 0),
           'neutral',  COALESCE(d.fig_neutral, 0),
           'negative', COALESCE(d.fig_negative, 0),
           'total',    COALESCE(d.fig_total, 0)
         )                            AS figure_stance
    FROM events e
    LEFT JOIN event_summaries es ON es.event_id = e.id
    LEFT JOIN figures f ON f.id = e.figure_id
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT a.source) AS outlet_count,
             json_agg(
               json_build_object(
                 'source', a.source, 'url', a.url,
                 'title', a.title, 'published_at', a.published_at
               -- The order the summarizer numbered them in, so [Sumber N]
               -- links to the Nth source. SQLite sorts NULLs first.
               ) ORDER BY a.published_at NULLS FIRST, a.id
             ) AS sources
        FROM articles a
       WHERE a.event_id = e.id
    ) src ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE c.stance = 'positive') AS positive,
             count(*) FILTER (WHERE c.stance = 'neutral')  AS neutral,
             count(*) FILTER (WHERE c.stance = 'negative') AS negative,
             count(*)                                      AS total,
             -- Only comments that name the figure: see jejak/figure_stance.py.
             count(*) FILTER (WHERE c.figure_stance = 'positive') AS fig_positive,
             count(*) FILTER (WHERE c.figure_stance = 'neutral')  AS fig_neutral,
             count(*) FILTER (WHERE c.figure_stance = 'negative') AS fig_negative,
             count(c.figure_stance)                               AS fig_total
        FROM comments c
       WHERE c.event_id = e.id
    ) d ON TRUE
    LEFT JOIN LATERAL (
      SELECT score, label, sample_size
        FROM sentiment
       WHERE event_id = e.id
       ORDER BY (channel = 'youtube') DESC, sample_size DESC NULLS LAST
       LIMIT 1
    ) s ON TRUE
   WHERE e.kind = 'record'
     AND ${LIVE("e")}
`;

export async function getFigures(): Promise<FigureSummary[]> {
  return query<FigureSummary>(
    `SELECT f.id,
            f.name,
            COALESCE(f.role, '')      AS role,
            COALESCE(f.aliases, '[]') AS aliases,
            COALESCE(st.event_count, 0)  AS event_count,
            COALESCE(st.outlet_count, 0) AS outlet_count,
            COALESCE(st.comment_count, 0) AS comment_count,
            st.avg_sentiment,
            st.last_record_at,
            COALESCE(st.recent_count, 0) AS recent_count
       FROM figures f
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT e.id)     AS event_count,
                count(DISTINCT a.source) AS outlet_count,
                count(c.id)              AS comment_count,
                avg(s.score)             AS avg_sentiment,
                -- last_seen, the newest article, is what the feed sorts by, so
                -- the homepage's story row orders figures the same way.
                max(e.last_seen)         AS last_record_at,
                count(DISTINCT e.id) FILTER (
                  WHERE e.last_seen::timestamptz > now() - interval '24 hours'
                )                        AS recent_count
           FROM events e
           LEFT JOIN articles a  ON a.event_id = e.id
           LEFT JOIN comments c  ON c.event_id = e.id
           LEFT JOIN sentiment s ON s.event_id = e.id
          WHERE e.figure_id = f.id
            AND e.kind = 'record'
            AND ${LIVE("e")}
       ) st ON TRUE
      WHERE f.active
      ORDER BY st.event_count DESC NULLS LAST, f.name`
  );
}

export async function getFigure(figureId: string): Promise<FigureSummary | null> {
  const rows = await getFigures();
  return rows.find((f) => f.id === figureId) ?? null;
}

/** Records per page on a figure's Rekam Jejak. */
export const FIGURE_PAGE_SIZE = 100;

/**
 * One page of a figure's records, newest first.
 *
 * Paged because a figure's history is unbounded (one has over 10,000 live
 * records, and rendering them all hangs the server). The page's ids are picked
 * in the subquery so RECORD_SELECT's per-event aggregates run for those rows
 * only, not for the whole history before the sort. `e.id` breaks date ties so
 * pages never overlap or skip a record.
 */
export async function getFigureEvents(figureId: string, page = 1): Promise<EventRecord[]> {
  return query<EventRecord>(
    `${RECORD_SELECT}
       AND e.id IN (
         SELECT p.id FROM events p
          WHERE p.figure_id = $1 AND p.kind = 'record' AND ${LIVE("p")}
          ORDER BY p.event_date DESC NULLS LAST, p.id DESC
          LIMIT $2 OFFSET $3
       )
     ORDER BY e.event_date DESC NULLS LAST, e.id DESC`,
    [figureId, FIGURE_PAGE_SIZE, (page - 1) * FIGURE_PAGE_SIZE]
  );
}

/** Cross-figure feed for the home page and Linimasa. */
export async function getRecentEvents(limit = 60): Promise<EventRecord[]> {
  return query<EventRecord>(
    `${RECORD_SELECT} ORDER BY ${FEED_ORDER} DESC LIMIT $1`,
    [limit]
  );
}

export async function getEvent(eventId: number): Promise<EventRecord | null> {
  return queryOne<EventRecord>(`${RECORD_SELECT} AND e.id = $1`, [eventId]);
}

/**
 * The chronologically adjacent events for the same figure, for the detail
 * page's prev/next controls.
 */
export async function getEventNeighbours(
  figureId: string,
  eventDate: string | null
): Promise<{ prev: { id: number; title: string | null } | null; next: { id: number; title: string | null } | null }> {
  if (!eventDate) return { prev: null, next: null };
  const [prev, next] = await Promise.all([
    queryOne<{ id: number; title: string | null }>(
      `SELECT id, title FROM events
        WHERE figure_id = $1 AND kind = 'record'
          AND ${LIVE("events")} AND event_date < $2
        ORDER BY event_date DESC LIMIT 1`,
      [figureId, eventDate]
    ),
    queryOne<{ id: number; title: string | null }>(
      `SELECT id, title FROM events
        WHERE figure_id = $1 AND kind = 'record'
          AND ${LIVE("events")} AND event_date > $2
        ORDER BY event_date ASC LIMIT 1`,
      [figureId, eventDate]
    ),
  ]);
  return { prev, next };
}

/**
 * Published peristiwa, newest first.
 *
 * The summary is LEFT JOINed, not required: a peristiwa is published as soon as
 * enough outlets corroborate it, which happens during clustering — the
 * summarize stage runs separately and may not have reached it yet.
 */
export async function getPeristiwa(limit = 60, ids?: number[]): Promise<Peristiwa[]> {
  const rows = await query<Peristiwa>(
    `SELECT e.id AS event_id,
            e.event_date, e.last_seen, e.title, e.event_type, e.scope, e.impact,
            es.summary_text AS summary,
            COALESCE(src.outlet_count, 0)  AS outlet_count,
            COALESCE(src.article_count, 0) AS article_count,
            COALESCE(src.sources, '[]'::json) AS sources,
            COALESCE(rel.figures, '[]'::json) AS related_figures
       FROM events e
       LEFT JOIN event_summaries es ON es.event_id = e.id
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT a.source) AS outlet_count,
                count(*)                 AS article_count,
                json_agg(
                  json_build_object(
                    'source', a.source, 'url', a.url,
                    'title', a.title, 'published_at', a.published_at
                  ) ORDER BY a.published_at NULLS FIRST, a.id
                ) AS sources
           FROM articles a
          WHERE a.event_id = e.id
       ) src ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object('id', f.id, 'name', COALESCE(f.name, ef.figure_id))
                ) AS figures
           FROM event_figures ef
           LEFT JOIN figures f ON f.id = ef.figure_id
          -- A figure struck in /kurasi is gone from jejak.db's event_figures,
          -- and the push prunes it here.
          WHERE ef.event_id = e.id
       ) rel ON TRUE
      WHERE e.kind = 'peristiwa'
        AND ${LIVE("e")}
        AND ($2::int[] IS NULL OR e.id = ANY($2::int[]))
      ORDER BY ${FEED_ORDER} DESC
      LIMIT $1`,
    [limit, ids ?? null]
  );
  const stories = await storylines(rows.map((r) => r.event_id));
  return rows.map((r) => {
    const story = stories.get(r.event_id) ?? [];
    return { ...r, story, image: storyImage(r.event_id, story, r.title) };
  });
}

/**
 * A peristiwa's own illustration, or else the one nearest it in its story:
 * a follow-up shares its banner with the event it follows until it gets its
 * own. Nearest by date, so a long chain takes the closest picture. Failing
 * both, the picture for its kind of story (karhutla), if it is one.
 */
function storyImage(eventId: number, story: StoryStep[], title: string | null): string | null {
  return storyImageSource(eventId, story, title)?.src ?? null;
}

/** storyImage, saying whose picture it is: `from` is the event it belongs to,
 *  or `theme` names the kind of story it illustrates. */
export function storyImageSource(
  eventId: number,
  story: StoryStep[],
  title: string | null
): { src: string; from: number | null; theme?: string } | null {
  const own = peristiwaImage(eventId);
  if (own) return { src: own, from: eventId };
  const at = story.findIndex((s) => s.event_id === eventId);
  const byDistance = story
    .map((s, i) => ({ s, d: Math.abs(i - at) }))
    .filter(({ s }) => !s.current)
    .sort((a, b) => a.d - b.d);
  for (const { s } of byDistance) {
    const img = peristiwaImage(s.event_id);
    if (img) return { src: img, from: s.event_id };
  }
  const themed = themeImage(title);
  return themed ? { src: themed.src, from: null, theme: themed.theme } : null;
}

/**
 * The "Lini cerita" for each event asked about: every live event reachable
 * through follow-up links a curator confirmed, oldest first. Events with no
 * confirmed link get no entry.
 *
 * The whole confirmed graph is read at once — it is curator-made and small —
 * and walked here, rather than a recursive query per card.
 */
export async function storylines(
  eventIds: number[],
  /** Counted even when not live: /kurasi previews an event before it airs. */
  { evenHidden = [] }: { evenHidden?: number[] } = {}
): Promise<Map<number, StoryStep[]>> {
  const out = new Map<number, StoryStep[]>();
  if (eventIds.length === 0) return out;
  const edges = await query<{ earlier_id: number; later_id: number }>(
    `SELECT v.earlier_id, v.later_id
       FROM followup_links v
       JOIN events a ON a.id = v.earlier_id
       JOIN events b ON b.id = v.later_id
      WHERE v.verdict = 'confirmed'
        AND (${LIVE("a")} OR a.id = ANY($1::int[]))
        AND (${LIVE("b")} OR b.id = ANY($1::int[]))`,
    [evenHidden]
  );
  if (edges.length === 0) return out;
  const adj = new Map<number, number[]>();
  for (const { earlier_id: a, later_id: b } of edges) {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  const components = new Map<number, number[]>();
  for (const id of eventIds) {
    if (!adj.has(id) || components.has(id)) continue;
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      for (const n of adj.get(queue.shift()!) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    const members = [...seen];
    for (const m of members) components.set(m, members);
  }
  const memberIds = [...new Set([...components.values()].flat())];
  const info = new Map(
    (await query<{ event_id: number; title: string | null; event_date: string | null }>(
      `SELECT id AS event_id, title, event_date FROM events WHERE id = ANY($1::int[])`,
      [memberIds]
    )).map((r) => [r.event_id, r])
  );
  for (const id of eventIds) {
    const members = components.get(id);
    if (!members) continue;
    out.set(
      id,
      members
        .map((m) => ({ event_id: m, title: info.get(m)?.title ?? null, event_date: info.get(m)?.event_date ?? null, current: m === id }))
        .sort((a, b) => (a.event_date ?? "").localeCompare(b.event_date ?? "") || a.event_id - b.event_id)
    );
  }
  return out;
}

/**
 * The peristiwa a record is part of, as a curator confirmed it.
 *
 * Confirmed only: jejak/link.py proposes these pairs from shared vocabulary,
 * and about half its proposals are wrong, so an unreviewed one is not shown.
 */
export async function getRecordPeristiwa(
  recordId: number
): Promise<{ event_id: number; title: string | null; event_date: string | null }[]> {
  return query(
    `SELECT e.id AS event_id, e.title, e.event_date
       FROM record_links v
       JOIN events e ON e.id = v.peristiwa_id
      WHERE v.record_id = $1 AND v.verdict = 'confirmed'
        AND e.kind = 'peristiwa' AND ${LIVE("e")}
      ORDER BY e.event_date`,
    [recordId]
  );
}

/**
 * Every published peristiwa, newest first, with only what topicOf() reads.
 * The Linimasa classifies these to count and filter by topic, then loads the
 * full cards for just the page it shows.
 */
export async function getPeristiwaIndex(): Promise<
  { event_id: number; title: string | null; summary: string | null; event_type: string | null }[]
> {
  return query(
    `SELECT e.id AS event_id, e.title, e.event_type, es.summary_text AS summary
       FROM events e
       LEFT JOIN event_summaries es ON es.event_id = e.id
      WHERE e.kind = 'peristiwa'
        AND ${LIVE("e")}
      ORDER BY ${FEED_ORDER} DESC`
  );
}

/**
 * The home rail: both kinds in one stream, newest first.
 *
 * Each kind is fetched with the same limit and the merge is then truncated to
 * that limit, which yields the true newest N across both — taking N of each and
 * showing all 2N would let whichever kind is currently more numerous decide how
 * far back the page reaches, so the feed would be paced by type rather than by
 * date.
 */
export async function getFeed(limit = 40): Promise<FeedItem[]> {
  const [records, peristiwa] = await Promise.all([
    getRecentEvents(limit),
    getPeristiwa(limit),
  ]);
  return [
    ...records.map((record) => ({
      kind: "record" as const,
      date: record.event_date,
      record,
    })),
    ...peristiwa.map((p) => ({
      kind: "peristiwa" as const,
      date: p.event_date,
      peristiwa: p,
    })),
  ]
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, limit);
}

export async function getEventComments(
  eventId: number,
  limit = 50
): Promise<PublicComment[]> {
  return query<PublicComment>(
    `SELECT id, author_name, channel, text, like_count, published_at, stance
       FROM comments
      WHERE event_id = $1
      ORDER BY like_count DESC NULLS LAST, published_at DESC
      LIMIT $2`,
    [eventId, limit]
  );
}

export async function getBuzzerSignal(eventId: number) {
  return queryOne<{
    anomaly_score: number | null;
    anomaly_pct: number | null;
    signals_triggered: string | null;
  }>(
    `SELECT anomaly_score, anomaly_pct, signals_triggered
       FROM buzzer_signals WHERE event_id = $1`,
    [eventId]
  );
}

/** Daily mean sentiment per figure, for the home page trend arrows. */
export async function getSentimentHistory(days = 7): Promise<SentimentPoint[]> {
  return query<SentimentPoint>(
    `SELECT e.figure_id,
            substring(s.collected_at from 1 for 10) AS day,
            avg(s.score)                            AS score
       FROM sentiment s
       JOIN events e ON e.id = s.event_id
      WHERE s.score IS NOT NULL
        AND s.collected_at >= to_char(now() - ($1 || ' days')::interval,
                                      'YYYY-MM-DD')
      GROUP BY e.figure_id, day
      ORDER BY day`,
    [days]
  );
}
