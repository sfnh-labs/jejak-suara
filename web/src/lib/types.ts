export type EventStatus = "new" | "summarized" | "approved" | "rejected";

export interface Article {
  id: string;
  figure_id: string;
  source: string;
  url: string;
  title: string;
  summary: string | null;
  body: string | null;
  body_original: string | null;
  body_lang: string | null;
  fetch_status: string | null;
  published_at: string | null;
  fetched_at: string;
  event_id: number | null;
}

export interface Event {
  id: number;
  figure_id: string;
  title: string | null;
  event_date: string | null;
  event_type: string | null;
  status: EventStatus;
  created_at: string;
}

export interface EventSummary {
  event_id: number;
  summary_text: string;
  citations_json: string;
  corroboration_count: number;
  single_source_flag: number;
  model: string;
  generated_at: string;
}

export interface Sentiment {
  id: number;
  event_id: number;
  channel: string;
  score: number | null;
  label: string | null;
  sample_size: number | null;
  samples_json: string | null;
  collected_at: string;
}

export interface Figure {
  id: string;
  name: string;
  role: string;
  aliases: string[];
}

export interface BuzzerSignal {
  id: number;
  event_id: number;
  anomaly_score: number | null;
  anomaly_pct: number | null;
  suspicious_ids_json: string | null;
  signals_triggered: string | null;
  analyzed_at: string;
}

/** One source article as shown in a record card's "Artikel Sumber" list. */
export interface EventSource {
  source: string;
  url: string;
  title: string;
  published_at: string | null;
}

/** Stance breakdown, derived from the stored per-comment classifications. */
export interface StanceCounts {
  positive: number;
  neutral: number;
  negative: number;
  total: number;
}

/**
 * An approved event with everything a record card renders, pre-aggregated so a
 * card costs one row rather than one row per source article.
 */
export interface EventRecord {
  event_id: number;
  figure_id: string;
  figure_name: string;
  event_date: string | null;
  title: string | null;
  event_type: string | null;
  /** Null until the summarize stage reaches it — the card renders without it. */
  summary: string | null;
  corroboration_count: number;
  single_source_flag: number;
  sources: EventSource[];
  sentiment_score: number | null;
  sentiment_label: string | null;
  sentiment_sample_size: number | null;
  stance: StanceCounts;
}

export interface FigureSummary extends Figure {
  event_count: number;
  outlet_count: number;
  comment_count: number;
  avg_sentiment: number | null;
}

/**
 * A national event: an event belonging to no tracked figure. Any figures in its
 * coverage are related, not owners. Published only once enough distinct outlets
 * corroborate it, so `outlet_count` is the significance signal.
 */
export interface Peristiwa {
  event_id: number;
  event_date: string | null;
  title: string | null;
  event_type: string | null;
  scope: string | null;
  impact: string | null;
  summary: string | null;
  outlet_count: number;
  article_count: number;
  sources: EventSource[];
  related_figures: { id: string; name: string }[];
  image: string | null;
}

/** One row of the home rail: a peristiwa (left column) or a record (right). */
export type FeedItem =
  | { kind: "peristiwa"; date: string | null; peristiwa: Peristiwa }
  | { kind: "record"; date: string | null; record: EventRecord };

export interface PublicComment {
  id: number;
  /** A pseudonym, not a real display name — see jejak/anonymize.py. */
  author_name: string | null;
  /** YouTube channel or subreddit the comment sits under. */
  channel: string | null;
  text: string;
  like_count: number | null;
  published_at: string | null;
  stance: string | null;
}

/** A day's mean sentiment for a figure, for the home page trend arrows. */
export interface SentimentPoint {
  figure_id: string;
  day: string;
  score: number;
}
