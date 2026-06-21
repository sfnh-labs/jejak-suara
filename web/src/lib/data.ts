import { query, queryOne } from "./db";
import type { Article, Event, EventSummary, Sentiment } from "./types";

export async function getFigures(): Promise<
  { id: string; name: string; role: string; approved_count: number }[]
> {
  return query<{ id: string; name: string; role: string; approved_count: number }>(
    `SELECT figure_id AS id, figure_id AS name, '' AS role,
            COUNT(*) AS approved_count
     FROM events WHERE status = 'approved'
     GROUP BY figure_id ORDER BY MAX(event_date) DESC`
  );
}

export async function getFigureMeta(figureId: string): Promise<{
  name: string;
  total_events: number;
  total_outlets: number;
  total_comments: number;
} | null> {
  const ev = await queryOne<{
    total_events: number;
    total_outlets: number;
  }>(
    `SELECT COUNT(*) AS total_events,
            COUNT(DISTINCT a.source) AS total_outlets
     FROM events e
     JOIN articles a ON a.event_id = e.id
     WHERE e.figure_id = $1 AND e.status = 'approved'`,
    [figureId]
  );
  if (!ev) return null;
  return {
    name: figureId, // replaced by figures.toml
    ...ev,
    total_comments: 0,
  };
}

export async function getFigureEvents(figureId: string): Promise<
  {
    event_id: number;
    event_date: string;
    title: string;
    summary: string;
    corroboration_count: number;
    single_source_flag: number;
    category: string;
    source: string;
    sentiment_score: number | null;
    sentiment_label: string | null;
    sentiment_sample_size: number | null;
  }[]
> {
  return query(
    `SELECT e.id AS event_id, e.event_date, e.title,
            es.summary_text AS summary,
            es.corroboration_count, es.single_source_flag,
            '' AS category,
            a.source, a.title AS article_title,
            s.score AS sentiment_score,
            s.label AS sentiment_label,
            s.sample_size AS sentiment_sample_size
     FROM events e
     JOIN event_summaries es ON es.event_id = e.id
     LEFT JOIN articles a ON a.event_id = e.id
     LEFT JOIN sentiment s ON s.event_id = e.id
     WHERE e.figure_id = $1 AND e.status = 'approved'
     ORDER BY e.event_date DESC`,
    [figureId]
  );
}

export async function getFigureByName(
  name: string
): Promise<{ id: string; name: string; role: string } | null> {
  // figures are configured in figures.toml, not stored in DB
  return null;
}
