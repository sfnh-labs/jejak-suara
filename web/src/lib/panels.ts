import { lquery as query, lqueryOne as queryOne } from "./localDb";
import { parsePositions, type Kind, type LinkVerdict, type Position } from "./curation";

/**
 * What the record page's side panel shows: another event or a figure, read
 * where the curator already is instead of on a page of its own. The panel is
 * named in the URL (?panel=peristiwa:12, catatan:34, tokoh:<slug>), so like
 * the reading pane it is server-rendered and needs no client script.
 */

export type PanelRef =
  | { kind: "peristiwa" | "catatan"; id: number }
  | { kind: "tokoh"; id: string };

export function parsePanel(raw: string | undefined): PanelRef | null {
  const m = /^(peristiwa|catatan|tokoh):([a-z0-9-]{1,128})$/.exec(raw ?? "");
  if (!m) return null;
  if (m[1] === "tokoh") return { kind: "tokoh", id: m[2] };
  const id = Number(m[2]);
  return Number.isInteger(id) && id > 0 ? { kind: m[1] as "peristiwa" | "catatan", id } : null;
}

export function panelKey(ref: PanelRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** The URL name of an event's panel, from its kind. */
export function eventPanel(kind: Kind, id: number): string {
  return `${kind === "record" ? "catatan" : "peristiwa"}:${id}`;
}

export interface PeekEvent {
  event_id: number;
  title: string | null;
  event_date: string | null;
  figure_name: string | null;
  verdict: LinkVerdict | null;
}

/** Another event, read-only: enough to judge a link to it without leaving. */
export interface EventPeek {
  event_id: number;
  kind: Kind;
  title: string | null;
  event_date: string | null;
  last_seen: string | null;
  curated: string | null;
  summary: string | null;
  quote: string | null;
  figure: { id: string; name: string; role: string | null } | null;
  /** The record's other actors (record_figures), the filed one excluded. */
  actors: { id: string; name: string }[];
  sources: { source: string; url: string; title: string | null; published_at: string | null }[];
  /** A peristiwa's records, or the peristiwa a record belongs to; rejected links left out. */
  members: PeekEvent[];
  /** Its lini cerita, both ways, in date order; rejected pairs left out. */
  followups: PeekEvent[];
}

export async function getEventPeek(eventId: number): Promise<EventPeek | null> {
  const ev = await queryOne<Omit<EventPeek, "figure" | "actors" | "sources" | "members" | "followups"> & {
    figure_id: string | null; figure_name: string | null; figure_role: string | null;
  }>(
    `SELECT e.id AS event_id, e.kind, e.title, e.event_date, e.last_seen, e.curated, e.quote,
            es.summary_text AS summary,
            f.id AS figure_id, f.name AS figure_name, f.role AS figure_role
       FROM events e
       LEFT JOIN event_summaries es ON es.event_id = e.id
       LEFT JOIN figures f ON f.id = e.figure_id
      WHERE e.id = ?`,
    [eventId]
  );
  if (!ev) return null;
  const [self, other] = ev.kind === "record" ? ["record_id", "peristiwa_id"] : ["peristiwa_id", "record_id"];
  const [actors, sources, members, followups] = await Promise.all([
    ev.kind === "record"
      ? query<{ id: string; name: string }>(
          `SELECT f.id, f.name FROM record_figures rf JOIN figures f ON f.id = rf.figure_id
            WHERE rf.event_id = ? AND rf.role = 'actor' AND rf.figure_id IS NOT ?
            ORDER BY rf.quotes DESC, f.name`,
          [eventId, ev.figure_id]
        )
      : Promise.resolve([]),
    query<EventPeek["sources"][number]>(
      `SELECT source, url, title, published_at FROM articles WHERE event_id = ?
        ORDER BY published_at NULLS FIRST, id`,
      [eventId]
    ),
    query<PeekEvent>(
      `SELECT o.id AS event_id, o.title, o.event_date, f.name AS figure_name, l.verdict
         FROM record_links l
         JOIN events o ON o.id = l.${other}
         LEFT JOIN figures f ON f.id = o.figure_id
        WHERE l.${self} = ? AND l.verdict IS NOT 'rejected' AND o.curated IS NOT 'rejected'
        ORDER BY l.verdict = 'confirmed' DESC, o.event_date, o.id
        LIMIT 40`,
      [eventId]
    ),
    query<PeekEvent>(
      `SELECT o.id AS event_id, o.title, o.event_date, f.name AS figure_name, l.verdict
         FROM followup_links l
         JOIN events o ON o.id = CASE WHEN l.later_id = ?1 THEN l.earlier_id ELSE l.later_id END
         LEFT JOIN figures f ON f.id = o.figure_id
        WHERE (l.earlier_id = ?1 OR l.later_id = ?1) AND l.verdict IS NOT 'rejected'
        ORDER BY o.event_date, o.id`,
      [eventId]
    ),
  ]);
  const { figure_id, figure_name, figure_role, ...rest } = ev;
  return {
    ...rest,
    figure: figure_id ? { id: figure_id, name: figure_name ?? figure_id, role: figure_role } : null,
    actors,
    sources,
    members,
    followups,
  };
}

/** A figure, read-only, with where else it appears. */
export interface FigurePeek {
  id: string;
  name: string;
  role: string | null;
  positions: Position[];
  aliases: string[];
  active: boolean;
  records: number;
  quotes: number;
  /** Its latest records, as filed figure or as an actor. */
  recent: (PeekEvent & { curated: string | null; as_actor: boolean })[];
  peristiwa: PeekEvent[];
}

const RECENT = 12;

export async function getFigurePeek(figureId: string): Promise<FigurePeek | null> {
  const f = await queryOne<{ id: string; name: string; role: string | null; positions: string | null; aliases: string | null; active: number }>(
    `SELECT id, name, role, positions, aliases, active FROM figures WHERE id = ?`,
    [figureId]
  );
  if (!f) return null;
  const [counts, recent, peristiwa] = await Promise.all([
    queryOne<{ records: number; quotes: number }>(
      `SELECT (SELECT count(*) FROM events WHERE kind = 'record' AND figure_id = ?1 AND curated IS NOT 'rejected') AS records,
              (SELECT count(*) FROM event_quotes WHERE figure_id = ?1) AS quotes`,
      [figureId]
    ),
    query<PeekEvent & { curated: string | null; as_actor: number }>(
      `SELECT e.id AS event_id, e.title, e.event_date, NULL AS figure_name, NULL AS verdict, e.curated,
              e.figure_id IS NOT ?1 AS as_actor
         FROM events e
        WHERE e.kind = 'record'
          AND (e.figure_id = ?1
               OR e.id IN (SELECT event_id FROM record_figures WHERE figure_id = ?1 AND role = 'actor'))
        ORDER BY e.event_date DESC, e.id DESC
        LIMIT ${RECENT}`,
      [figureId]
    ),
    query<PeekEvent>(
      `SELECT e.id AS event_id, e.title, e.event_date, NULL AS figure_name, NULL AS verdict
         FROM event_figures ef JOIN events e ON e.id = ef.event_id
        WHERE ef.figure_id = ? AND e.kind = 'peristiwa' AND e.curated IS NOT 'rejected'
        ORDER BY e.event_date DESC, e.id DESC
        LIMIT 6`,
      [figureId]
    ),
  ]);
  let aliases: string[] = [];
  try {
    const parsed: unknown = JSON.parse(f.aliases ?? "[]");
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    // a malformed list shows as none
  }
  return {
    id: f.id, name: f.name, role: f.role, positions: parsePositions(f.positions), aliases,
    active: Boolean(f.active), records: counts?.records ?? 0, quotes: counts?.quotes ?? 0,
    recent: recent.map((r) => ({ ...r, as_actor: Boolean(r.as_actor) })),
    peristiwa,
  };
}
