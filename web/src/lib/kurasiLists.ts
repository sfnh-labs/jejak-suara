import { lquery as query, lqueryOne as queryOne, tableExists } from "./localDb";
import { parsePositions, type NamedPerson, type Position, type Verdict } from "./curation";

/**
 * The lists behind the Tokoh, Peristiwa and Lini cerita tabs of /kurasi: one
 * page per kind of data, each opening the same forms the record page uses.
 */

const PUBLIC = "e.status IN ('new', 'summarized', 'approved')";

function jsonList<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tokoh

export interface FigureRow {
  id: string;
  name: string;
  role: string | null;
  positions: Position[];
  /** Records it is in: filed under it, or on their Terkait list (record_figures). */
  records: number;
  quotes: number;
  last_seen: string | null;
}

/** Every active figure, the busiest first; `q` narrows by name, alias or office. */
export async function getFigureList(q = ""): Promise<FigureRow[]> {
  const actors = await tableExists("record_figures");
  const acts = actors
    ? `SELECT figure_id, event_id FROM record_figures WHERE role = 'related'
        UNION SELECT figure_id, id FROM events WHERE kind = 'record' AND figure_id IS NOT NULL`
    : `SELECT figure_id, id AS event_id FROM events WHERE kind = 'record' AND figure_id IS NOT NULL`;
  const like = `%${q.trim().toLowerCase()}%`;
  const rows = await query<Omit<FigureRow, "positions"> & { positions: string | null }>(
    `WITH acts AS (${acts})
     SELECT f.id, f.name, f.role, f.positions,
            (SELECT count(*) FROM acts a JOIN events e ON e.id = a.event_id
              WHERE a.figure_id = f.id AND e.curated IS NOT 'rejected') AS records,
            (SELECT count(*) FROM event_quotes WHERE figure_id = f.id) AS quotes,
            (SELECT max(e.event_date) FROM acts a JOIN events e ON e.id = a.event_id WHERE a.figure_id = f.id) AS last_seen
       FROM figures f
      WHERE f.active
        AND (?1 = '%%' OR lower(f.name) LIKE ?1 OR lower(COALESCE(f.aliases, '')) LIKE ?1
             OR lower(COALESCE(f.role, '')) LIKE ?1 OR f.id LIKE ?1)
      ORDER BY records DESC, f.name`,
    [like]
  );
  return rows.map((r) => ({ ...r, positions: parsePositions(r.positions) }));
}

/**
 * Each figure's records per week over the last `weeks`, oldest first: the
 * same cells as the public /tokoh board (lib/data getFigureWeeks), counted
 * here from jejak.db and including records not yet curated.
 */
export async function getFigureWeeksLocal(weeks = 12): Promise<Map<string, number[]>> {
  const rows = await query<{ figure_id: string; ago: number; n: number }>(
    `SELECT figure_id,
            CAST((julianday('now', '+7 hours') - julianday(event_date, '+7 hours')) / 7 AS INTEGER) AS ago,
            count(*) AS n
       FROM events e
      WHERE kind = 'record' AND figure_id IS NOT NULL AND event_date IS NOT NULL
        AND e.curated IS NOT 'rejected'
        AND julianday(event_date) > julianday('now') - (?1 * 7 + 1)
      GROUP BY 1, 2`,
    [weeks]
  );
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const ago = Number(r.ago);
    if (ago < 0 || ago >= weeks) continue;
    if (!out.has(r.figure_id)) out.set(r.figure_id, Array(weeks).fill(0));
    out.get(r.figure_id)![weeks - 1 - ago] += Number(r.n);
  }
  return out;
}

export interface FigureRecord {
  event_id: number;
  title: string | null;
  event_date: string | null;
  curated: Verdict | null;
  /** Filed under this figure, rather than on the Terkait list of another's. */
  filed: boolean;
  open_points: number;
}

export interface FigureFull {
  person: NamedPerson;
  records: FigureRecord[];
  recordCount: number;
  quotes: { id: number; event_id: number; quote: string; source: string | null }[];
  quoteCount: number;
}

/** A figure as its own page edits it, with its records and latest quotes. */
export async function getFigureFull(id: string): Promise<FigureFull | null> {
  const f = await queryOne<{
    id: string; name: string; role: string | null; aliases: string | null; positions: string | null;
    bio: string | null; facts: string | null; education: string | null; sources: string | null;
    cv_checked_at: string | null; active: number;
  }>(
    `SELECT id, name, role, aliases, positions, bio, facts, education, sources, cv_checked_at, active
       FROM figures WHERE id = ?`,
    [id]
  );
  if (!f) return null;
  const [actors, points] = await Promise.all([tableExists("record_figures"), tableExists("curation_points")]);
  const openPoints = points
    ? "(SELECT count(*) FROM curation_points p WHERE p.event_id = e.id AND p.status = 'open')"
    : "0";
  const [records, counts, quotes] = await Promise.all([
    query<Omit<FigureRecord, "filed"> & { filed: number }>(
      `SELECT e.id AS event_id, e.title, e.event_date, e.curated, e.figure_id = ?1 AS filed, ${openPoints} AS open_points
         FROM events e
        WHERE e.kind = 'record'
          AND (e.figure_id = ?1
               ${actors ? "OR e.id IN (SELECT event_id FROM record_figures WHERE figure_id = ?1 AND role = 'related')" : ""})
        ORDER BY e.event_date DESC, e.id DESC
        LIMIT 60`,
      [id]
    ),
    queryOne<{ records: number; quotes: number }>(
      `SELECT (SELECT count(*) FROM events e WHERE e.kind = 'record'
                 AND (e.figure_id = ?1 ${actors ? "OR e.id IN (SELECT event_id FROM record_figures WHERE figure_id = ?1 AND role = 'related')" : ""})) AS records,
              (SELECT count(*) FROM event_quotes WHERE figure_id = ?1) AS quotes`,
      [id]
    ),
    query<{ id: number; event_id: number; quote: string; source: string | null }>(
      `SELECT q.id, q.event_id, q.quote, a.source
         FROM event_quotes q LEFT JOIN articles a ON a.id = q.article_id
        WHERE q.figure_id = ?
        ORDER BY q.found_at DESC, q.id DESC
        LIMIT 8`,
      [id]
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
    person: {
      kind: "figure", id: f.id, name: f.name, role: f.role, aliases, positions: parsePositions(f.positions),
      articles: 0, verdict: null, active: Boolean(f.active), cv_checked_at: f.cv_checked_at,
      profile: { bio: f.bio ?? "", facts: jsonList(f.facts), education: jsonList(f.education), sources: jsonList(f.sources) },
    },
    records: records.map((r) => ({ ...r, filed: Boolean(r.filed), open_points: Number(r.open_points) })),
    recordCount: Number(counts?.records ?? 0),
    quotes,
    quoteCount: Number(counts?.quotes ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Peristiwa

export type PeristiwaFilter = "semua" | "usulan" | "belum" | "diturunkan";

export interface PeristiwaRow {
  event_id: number;
  title: string | null;
  event_date: string | null;
  last_seen: string | null;
  curated: Verdict | null;
  /** Records confirmed as part of it, and proposals waiting. */
  confirmed: number;
  proposed: number;
}

const PERISTIWA_FILTER: Record<PeristiwaFilter, string> = {
  semua: "e.curated IS NOT 'rejected'",
  usulan: "EXISTS (SELECT 1 FROM record_links l WHERE l.peristiwa_id = e.id AND l.verdict IS NULL)",
  belum: "e.curated IS NULL",
  diturunkan: "e.curated = 'rejected'",
};

export async function getPeristiwaList(filter: PeristiwaFilter, q = ""): Promise<PeristiwaRow[]> {
  const like = `%${q.trim().toLowerCase()}%`;
  return query<PeristiwaRow>(
    `SELECT e.id AS event_id, e.title, e.event_date, e.last_seen, e.curated,
            (SELECT count(*) FROM record_links l WHERE l.peristiwa_id = e.id AND l.verdict = 'confirmed') AS confirmed,
            (SELECT count(*) FROM record_links l WHERE l.peristiwa_id = e.id AND l.verdict IS NULL) AS proposed
       FROM events e
      WHERE e.kind = 'peristiwa' AND ${PUBLIC} AND ${PERISTIWA_FILTER[filter]}
        AND (?1 = '%%' OR lower(COALESCE(e.title, '')) LIKE ?1)
      ORDER BY e.event_date DESC NULLS LAST, e.id DESC
      LIMIT 80`,
    [like]
  );
}

export async function getPeristiwaCounts(): Promise<Record<PeristiwaFilter, number>> {
  const keys = Object.keys(PERISTIWA_FILTER) as PeristiwaFilter[];
  const row = await queryOne<Record<PeristiwaFilter, number>>(
    `SELECT ${keys.map((k) => `count(*) FILTER (WHERE ${PERISTIWA_FILTER[k]}) AS ${k}`).join(", ")}
       FROM events e WHERE e.kind = 'peristiwa' AND ${PUBLIC}`
  );
  return Object.fromEntries(keys.map((k) => [k, Number(row?.[k] ?? 0)])) as Record<PeristiwaFilter, number>;
}

// ---------------------------------------------------------------------------
// Lini cerita

export interface LiniEvent {
  event_id: number;
  kind: "record" | "peristiwa";
  title: string | null;
  event_date: string | null;
  figure_name: string | null;
}

/** A lini cerita: events joined by confirmed follow-ups, in date order. */
export interface Lini {
  events: LiniEvent[];
  latest: string | null;
}

/** Confirmed chains, the most recently continued first. */
export async function getLinis(limit = 60): Promise<Lini[]> {
  const pairs = await query<{ earlier_id: number; later_id: number }>(
    `SELECT earlier_id, later_id FROM followup_links WHERE verdict = 'confirmed'`
  );
  // Union-find over the confirmed pairs: each component is one lini.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const { earlier_id: a, later_id: b } of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const ids = [...parent.keys()];
  if (ids.length === 0) return [];
  const events = await query<LiniEvent>(
    `SELECT e.id AS event_id, e.kind, e.title, e.event_date, f.name AS figure_name
       FROM events e LEFT JOIN figures f ON f.id = e.figure_id
      WHERE e.id IN (SELECT value FROM json_each(?)) AND e.curated IS NOT 'rejected'`,
    [JSON.stringify(ids)]
  );
  const groups = new Map<number, LiniEvent[]>();
  for (const e of events) {
    const root = find(e.event_id);
    groups.set(root, [...(groups.get(root) ?? []), e]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sorted = g.sort((a, b) => (a.event_date ?? "").localeCompare(b.event_date ?? "") || a.event_id - b.event_id);
      return { events: sorted, latest: sorted[sorted.length - 1].event_date };
    })
    .sort((a, b) => (b.latest ?? "").localeCompare(a.latest ?? ""))
    .slice(0, limit);
}

export interface LiniProposal {
  earlier: LiniEvent;
  later: LiniEvent;
  score: number | null;
  evidence: string[];
}

/** Follow-ups the pipeline proposed and nobody ruled on, the strongest first. */
export async function getLiniProposals(limit = 40): Promise<{ rows: LiniProposal[]; total: number }> {
  const [rows, total] = await Promise.all([
    query<{
      earlier_id: number; e_kind: "record" | "peristiwa"; e_title: string | null; e_date: string | null; e_fig: string | null;
      later_id: number; l_kind: "record" | "peristiwa"; l_title: string | null; l_date: string | null; l_fig: string | null;
      score: number | null; evidence: string | null;
    }>(
      `SELECT l.earlier_id, a.kind AS e_kind, a.title AS e_title, a.event_date AS e_date, fa.name AS e_fig,
              l.later_id, b.kind AS l_kind, b.title AS l_title, b.event_date AS l_date, fb.name AS l_fig,
              l.score, l.evidence
         FROM followup_links l
         JOIN events a ON a.id = l.earlier_id LEFT JOIN figures fa ON fa.id = a.figure_id
         JOIN events b ON b.id = l.later_id LEFT JOIN figures fb ON fb.id = b.figure_id
        WHERE l.verdict IS NULL AND a.curated IS NOT 'rejected' AND b.curated IS NOT 'rejected'
        ORDER BY l.score DESC NULLS LAST, b.event_date DESC
        LIMIT ?`,
      [limit]
    ),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM followup_links WHERE verdict IS NULL`),
  ]);
  return {
    total: Number(total?.n ?? 0),
    rows: rows.map((r) => ({
      earlier: { event_id: r.earlier_id, kind: r.e_kind, title: r.e_title, event_date: r.e_date, figure_name: r.e_fig },
      later: { event_id: r.later_id, kind: r.l_kind, title: r.l_title, event_date: r.l_date, figure_name: r.l_fig },
      score: r.score,
      evidence: jsonList<string>(r.evidence),
    })),
  };
}
