import { query, queryOne } from "./db";
import { peristiwaImage } from "./peristiwa-images";
import type {
  EventRecord,
  FeedItem,
  FigureSummary,
  Peristiwa,
  PublicComment,
  SentimentPoint,
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
 * IS DISTINCT FROM, not `<>`: a plain inequality is NULL for the untouched
 * rows, which is every event nobody has curated yet, and would hide the site.
 */
const LIVE = (alias: string) =>
  `${alias}.status IN ('new', 'summarized', 'approved')
   AND ${alias}.curated IS DISTINCT FROM 'rejected'`;

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
const RECORD_SELECT = `
  SELECT e.id                         AS event_id,
         e.figure_id,
         COALESCE(f.name, e.figure_id) AS figure_name,
         e.event_date,
         e.title,
         e.event_type,
         es.summary_text              AS summary,
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
         )                            AS stance
    FROM events e
    LEFT JOIN event_summaries es ON es.event_id = e.id
    LEFT JOIN figures f ON f.id = e.figure_id
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT a.source) AS outlet_count,
             json_agg(
               json_build_object(
                 'source', a.source, 'url', a.url,
                 'title', a.title, 'published_at', a.published_at
               ) ORDER BY a.published_at
             ) AS sources
        FROM articles a
       WHERE a.event_id = e.id
    ) src ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE c.stance = 'positive') AS positive,
             count(*) FILTER (WHERE c.stance = 'neutral')  AS neutral,
             count(*) FILTER (WHERE c.stance = 'negative') AS negative,
             count(*)                                      AS total
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
            st.avg_sentiment
       FROM figures f
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT e.id)     AS event_count,
                count(DISTINCT a.source) AS outlet_count,
                count(c.id)              AS comment_count,
                avg(s.score)             AS avg_sentiment
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

export async function getFigureEvents(figureId: string): Promise<EventRecord[]> {
  return query<EventRecord>(
    `${RECORD_SELECT} AND e.figure_id = $1 ORDER BY e.event_date DESC`,
    [figureId]
  );
}

/** Cross-figure feed for the home page and Linimasa. */
export async function getRecentEvents(limit = 60): Promise<EventRecord[]> {
  return query<EventRecord>(
    `${RECORD_SELECT} ORDER BY e.event_date DESC LIMIT $1`,
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
export async function getPeristiwa(limit = 60): Promise<Peristiwa[]> {
  const rows = await query<Peristiwa>(
    `SELECT e.id AS event_id,
            e.event_date, e.title, e.event_type, e.scope, e.impact,
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
                  ) ORDER BY a.published_at
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
          WHERE ef.event_id = e.id
       ) rel ON TRUE
      WHERE e.kind = 'peristiwa'
        AND ${LIVE("e")}
      ORDER BY e.event_date DESC
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ ...r, image: peristiwaImage(r.event_id) }));
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
