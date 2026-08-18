import { query } from "./db";

/**
 * Curator verdicts.
 *
 * `null` is the resting state of every event nobody has looked at, and it is
 * public — curation is a kill switch over an already-live feed, not a gate a
 * record has to pass before it appears. So only 'rejected' changes what the
 * site renders; 'kept' exists purely so a curator can mark a row as read and
 * stop re-examining it.
 */
export type Verdict = "rejected" | "kept";

export const VERDICTS: readonly Verdict[] = ["rejected", "kept"];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export interface CurationRow {
  event_id: number;
  kind: string;
  figure_id: string | null;
  figure_name: string | null;
  event_date: string | null;
  title: string | null;
  status: string;
  curated: Verdict | null;
  summary: string | null;
  outlet_count: number;
  sources: { source: string; url: string; title: string | null }[];
}

/** Which slice of the queue to show. */
export type Filter = "live" | "rejected" | "unreviewed";

/**
 * The curation queue.
 *
 * Deliberately not built on data.ts's LIVE predicate: this page has to be able
 * to show what that predicate excludes, since restoring a rejected record is
 * half the job. Each filter therefore spells out its own condition.
 */
export async function getCurationQueue(
  filter: Filter = "live",
  limit = 200
): Promise<CurationRow[]> {
  const where = {
    live: "e.curated IS DISTINCT FROM 'rejected'",
    rejected: "e.curated = 'rejected'",
    unreviewed: "e.curated IS NULL",
  }[filter];

  return query<CurationRow>(
    `SELECT e.id AS event_id,
            e.kind,
            e.figure_id,
            f.name AS figure_name,
            e.event_date,
            e.title,
            e.status,
            e.curated,
            es.summary_text AS summary,
            COALESCE(src.outlet_count, 0)     AS outlet_count,
            COALESCE(src.sources, '[]'::json) AS sources
       FROM events e
       LEFT JOIN figures f ON f.id = e.figure_id
       LEFT JOIN event_summaries es ON es.event_id = e.id
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT a.source) AS outlet_count,
                json_agg(
                  json_build_object('source', a.source, 'url', a.url,
                                    'title', a.title)
                  ORDER BY a.published_at
                ) AS sources
           FROM articles a
          WHERE a.event_id = e.id
       ) src ON TRUE
      WHERE e.status IN ('new', 'summarized', 'approved')
        AND ${where}
      ORDER BY e.event_date DESC NULLS LAST, e.id DESC
      LIMIT $1`,
    [limit]
  );
}

/** Per-filter counts, so the tabs can show how much work is left. */
export async function getCurationCounts(): Promise<Record<Filter, number>> {
  const [row] = await query<{ live: string; rejected: string; unreviewed: string }>(
    `SELECT count(*) FILTER (WHERE curated IS DISTINCT FROM 'rejected') AS live,
            count(*) FILTER (WHERE curated = 'rejected')                AS rejected,
            count(*) FILTER (WHERE curated IS NULL)                     AS unreviewed
       FROM events
      WHERE status IN ('new', 'summarized', 'approved')`
  );
  return {
    live: Number(row?.live ?? 0),
    rejected: Number(row?.rejected ?? 0),
    unreviewed: Number(row?.unreviewed ?? 0),
  };
}

/** Record a verdict. `null` clears it, putting the event back in `unreviewed`. */
export async function setCuration(eventId: number, verdict: Verdict | null): Promise<void> {
  await query(`UPDATE events SET curated = $1 WHERE id = $2`, [verdict, eventId]);
}
