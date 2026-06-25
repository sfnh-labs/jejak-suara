export type EventStatus = "new" | "summarized" | "approved" | "rejected";

export interface Article {
  id: string;
  figure_id: string;
  source: string;
  url: string;
  title: string;
  summary: string | null;
  body: string | null;
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
