import { query, queryOne } from "./db";

/**
 * Curation, one event at a time.
 *
 * The unit is the event — a record (one figure's action) or a peristiwa (a
 * national story). Everything else a curator corrects hangs off it: the figure
 * who acts in a record, the people its coverage names, and which peristiwa the
 * record is part of.
 *
 * Every decision here is written to a Postgres-only column or table that no
 * sync touches, and takes effect on the site at once. The pipeline catches up
 * through scripts/apply_curation.py, which copies each decision into SQLite so
 * the next crawl attributes, links and relates figures the way the curator
 * said.
 */

/**
 * Curator verdicts on an event.
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

export type LinkVerdict = "confirmed" | "rejected";

export function isLinkVerdict(value: unknown): value is LinkVerdict {
  return value === "confirmed" || value === "rejected";
}

export type Kind = "record" | "peristiwa";

/** Which slice of the queue to show. `links` = records with unruled proposals. */
export type Filter = "unreviewed" | "live" | "rejected" | "links";

const PUBLIC = "e.status IN ('new', 'summarized', 'approved')";

const FILTER_SQL: Record<Filter, string> = {
  live: "e.curated IS DISTINCT FROM 'rejected'",
  rejected: "e.curated = 'rejected'",
  unreviewed: "e.curated IS NULL",
  links: `EXISTS (
    SELECT 1 FROM record_links l
     WHERE l.record_id = e.id
       AND NOT EXISTS (SELECT 1 FROM record_link_verdicts v
                        WHERE v.record_id = l.record_id
                          AND v.peristiwa_id = l.peristiwa_id
                          AND v.verdict IS NOT NULL))`,
};

export interface QueueRow {
  event_id: number;
  kind: Kind;
  figure_id: string | null;
  figure_name: string | null;
  event_date: string | null;
  title: string | null;
  curated: Verdict | null;
  outlet_count: number;
  article_count: number;
  has_summary: boolean;
  /** Proposed peristiwa links nobody has ruled on (records only). */
  open_links: number;
  confirmed_links: number;
}

export const PAGE_SIZE = 50;

/**
 * Deliberately not built on data.ts's LIVE predicate: this page has to be able
 * to show what that predicate excludes, since restoring a rejected event is
 * half the job.
 */
export async function getQueue(
  kind: Kind,
  filter: Filter,
  page = 1
): Promise<QueueRow[]> {
  return query<QueueRow>(
    `SELECT e.id AS event_id, e.kind, e.figure_id, f.name AS figure_name,
            e.event_date, e.title, e.curated,
            COALESCE(src.outlet_count, 0)  AS outlet_count,
            COALESCE(src.article_count, 0) AS article_count,
            es.event_id IS NOT NULL        AS has_summary,
            COALESCE(lk.open_links, 0)      AS open_links,
            COALESCE(lk.confirmed_links, 0) AS confirmed_links
       FROM events e
       LEFT JOIN figures f ON f.id = e.figure_id
       LEFT JOIN event_summaries es ON es.event_id = e.id
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT a.source)::int AS outlet_count,
                count(*)::int                 AS article_count
           FROM articles a WHERE a.event_id = e.id
       ) src ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE v.verdict IS NULL)::int        AS open_links,
                count(*) FILTER (WHERE v.verdict = 'confirmed')::int  AS confirmed_links
           FROM (SELECT record_id, peristiwa_id FROM record_links
                  UNION
                 SELECT record_id, peristiwa_id FROM record_link_verdicts) p
           LEFT JOIN record_link_verdicts v
             ON v.record_id = p.record_id AND v.peristiwa_id = p.peristiwa_id
          WHERE (e.kind = 'record' AND p.record_id = e.id)
             OR (e.kind = 'peristiwa' AND p.peristiwa_id = e.id)
       ) lk ON TRUE
      WHERE e.kind = $1 AND ${PUBLIC} AND ${FILTER_SQL[filter]}
      ORDER BY e.event_date DESC NULLS LAST, e.id DESC
      LIMIT $2 OFFSET $3`,
    [kind, PAGE_SIZE, (Math.max(page, 1) - 1) * PAGE_SIZE]
  );
}

export async function getQueueCounts(kind: Kind): Promise<Record<Filter, number>> {
  const row = await queryOne<Record<Filter, string>>(
    `SELECT count(*) FILTER (WHERE ${FILTER_SQL.unreviewed}) AS unreviewed,
            count(*) FILTER (WHERE ${FILTER_SQL.live})       AS live,
            count(*) FILTER (WHERE ${FILTER_SQL.rejected})   AS rejected,
            count(*) FILTER (WHERE ${FILTER_SQL.links})      AS links
       FROM events e
      WHERE e.kind = $1 AND ${PUBLIC}`,
    [kind]
  );
  return {
    unreviewed: Number(row?.unreviewed ?? 0),
    live: Number(row?.live ?? 0),
    rejected: Number(row?.rejected ?? 0),
    links: Number(row?.links ?? 0),
  };
}

export async function getKindCounts(): Promise<Record<Kind, number>> {
  const rows = await query<{ kind: Kind; n: string }>(
    `SELECT e.kind, count(*) AS n FROM events e
      WHERE ${PUBLIC} AND e.curated IS NULL GROUP BY e.kind`
  );
  const out: Record<Kind, number> = { record: 0, peristiwa: 0 };
  for (const r of rows) out[r.kind] = Number(r.n);
  return out;
}

// ---------------------------------------------------------------------------
// One event

export interface ItemSource {
  source: string;
  url: string;
  title: string | null;
  published_at: string | null;
  lead: string | null;
}

export interface FigureRef {
  id: string;
  name: string;
  role: string | null;
  aliases: string[];
  active: boolean;
  /** Set while the edit waits for apply_curation.py to reach the pipeline. */
  edit_pending: boolean;
}

/** Someone the coverage names. `articles` = how many of the event's articles. */
export interface NamedPerson {
  kind: "figure" | "candidate";
  id: string;
  name: string;
  role: string | null;
  /** Figures only. */
  aliases: string[];
  articles: number;
  /** Candidates only: the verdict already recorded, if any. */
  verdict: string | null;
  /** Peristiwa only: a related figure the curator struck. */
  struck?: boolean;
}

export interface LinkRow {
  /** The other side of the link: a peristiwa on a record page, and vice versa. */
  event_id: number;
  title: string | null;
  event_date: string | null;
  figure_name: string | null;
  score: number | null;
  evidence: string[];
  verdict: LinkVerdict | null;
  proposed: boolean;
}

export interface Item {
  event_id: number;
  kind: Kind;
  figure_id: string | null;
  event_date: string | null;
  last_seen: string | null;
  title: string | null;
  event_type: string | null;
  status: string;
  curated: Verdict | null;
  summary: string | null;
  sources: ItemSource[];
  owner: FigureRef | null;
  named: NamedPerson[];
  links: LinkRow[];
  /** Peristiwa around the record's date that are not linked yet (records only). */
  nearby: { event_id: number; title: string | null; event_date: string | null }[];
  next_id: number | null;
}

function parseAliases(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === "string");
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/** RSS leads often carry markup (an <img>, a <p>); the page wants the words. */
function plain(html: string | null): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word occurrence. `\b` is ASCII-only in JS, so letters are spelled out. */
function wordPattern(term: string, flags: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}])`, `u${flags}`);
}

/**
 * Who the event's coverage names, among tracked figures and the candidate
 * queue.
 *
 * Matched here rather than read from figure_mentions, which never leaves the
 * pipeline's SQLite. Figures match case-insensitively on any alias, the way
 * attribution does; candidates match case-sensitively on the name as mined,
 * since capitalisation is the only thing that made them a name at all.
 */
async function namedPeople(
  texts: string[],
  ownerId: string | null,
  related: { figure_id: string; struck: boolean }[]
): Promise<NamedPerson[]> {
  const [figures, candidates] = await Promise.all([
    query<{ id: string; name: string; role: string | null; aliases: string | null }>(
      `SELECT id, name, role, aliases FROM figures WHERE active`
    ),
    query<{ slug: string; name: string; role: string | null; verdict: string | null; full_name: string | null }>(
      `SELECT slug, name, COALESCE(curated_role, role) AS role, verdict, full_name
         FROM figure_candidates
        WHERE slug NOT IN (SELECT id FROM figures)
          AND (verdict IS NULL OR applied_at IS NULL)`
    ),
  ]);

  const count = (patterns: RegExp[]) =>
    texts.reduce((n, t) => (patterns.some((p) => p.test(t)) ? n + 1 : n), 0);

  // A name the owner answers to is the owner. A duplicate that shares it
  // ("Ahmad Muzani Tutup", aliased "Ahmad Muzani") would otherwise turn up as
  // a second person in every article about the first.
  const owner = figures.find((f) => f.id === ownerId);
  const ownerTerms = new Set(
    owner ? [owner.name, ...parseAliases(owner.aliases)].map((t) => t.trim().toLowerCase()) : []
  );

  const relatedIds = new Map(related.map((r) => [r.figure_id, r.struck]));
  const out: NamedPerson[] = [];
  for (const f of figures) {
    if (f.id === ownerId) continue;
    const terms = [f.name, ...parseAliases(f.aliases)].filter(
      (t) => t.trim().length > 2 && !ownerTerms.has(t.trim().toLowerCase())
    );
    const n = count(terms.map((t) => wordPattern(t, "i")));
    if (n === 0 && !relatedIds.has(f.id)) continue;
    out.push({
      kind: "figure", id: f.id, name: f.name, role: f.role,
      aliases: parseAliases(f.aliases), articles: n, verdict: null,
      struck: relatedIds.get(f.id),
    });
  }
  for (const c of candidates) {
    const n = count([wordPattern(c.name, "")]);
    if (n === 0) continue;
    out.push({
      kind: "candidate", id: c.slug, name: c.full_name || c.name, role: c.role,
      aliases: [], articles: n, verdict: c.verdict,
    });
  }
  return out.sort((a, b) => b.articles - a.articles || a.name.localeCompare(b.name));
}

async function getLinks(kind: Kind, eventId: number): Promise<LinkRow[]> {
  // The same pairs seen from either end: a record page lists peristiwa, a
  // peristiwa page lists records.
  const [self, other] = kind === "record"
    ? ["record_id", "peristiwa_id"]
    : ["peristiwa_id", "record_id"];
  const rows = await query<LinkRow & { evidence: string | null }>(
    `SELECT p.${other} AS event_id, o.title, o.event_date,
            f.name AS figure_name,
            l.score, l.evidence, v.verdict,
            l.record_id IS NOT NULL AS proposed
       FROM (SELECT record_id, peristiwa_id FROM record_links WHERE ${self} = $1
              UNION
             SELECT record_id, peristiwa_id FROM record_link_verdicts WHERE ${self} = $1) p
       JOIN events o ON o.id = p.${other}
       LEFT JOIN figures f ON f.id = o.figure_id
       LEFT JOIN record_links l
         ON l.record_id = p.record_id AND l.peristiwa_id = p.peristiwa_id
       LEFT JOIN record_link_verdicts v
         ON v.record_id = p.record_id AND v.peristiwa_id = p.peristiwa_id
      ORDER BY (v.verdict = 'confirmed') DESC NULLS LAST,
               (v.verdict = 'rejected') ASC NULLS FIRST,
               l.score DESC NULLS LAST`,
    [eventId]
  );
  return rows.map((r) => ({ ...r, evidence: parseAliases(r.evidence) }));
}

export async function getItem(eventId: number): Promise<Item | null> {
  const ev = await queryOne<Omit<Item, "sources" | "owner" | "named" | "links" | "nearby" | "next_id">>(
    `SELECT e.id AS event_id, e.kind, e.figure_id, e.event_date, e.last_seen,
            e.title, e.event_type, e.status, e.curated,
            es.summary_text AS summary
       FROM events e
       LEFT JOIN event_summaries es ON es.event_id = e.id
      WHERE e.id = $1`,
    [eventId]
  );
  if (!ev) return null;

  const [articles, owner, related, links, next] = await Promise.all([
    query<ItemSource & { body: string | null }>(
      `SELECT source, url, title, published_at, summary AS lead, body
         FROM articles WHERE event_id = $1
        ORDER BY published_at NULLS FIRST, id`,
      [eventId]
    ),
    ev.figure_id
      ? queryOne<{ id: string; name: string; role: string | null; aliases: string | null; active: boolean; edit_pending: boolean }>(
          `SELECT f.id, f.name, f.role, f.aliases, f.active,
                  (fe.figure_id IS NOT NULL AND fe.applied_at IS NULL) AS edit_pending
             FROM figures f
             LEFT JOIN figure_edits fe ON fe.figure_id = f.id
            WHERE f.id = $1`,
          [ev.figure_id]
        )
      : Promise.resolve(null),
    ev.kind === "peristiwa"
      ? query<{ figure_id: string; struck: boolean }>(
          `SELECT figure_id, false AS struck FROM event_figures WHERE event_id = $1
            UNION
           SELECT figure_id, true FROM event_figure_rejections
            WHERE event_id = $1 AND struck`,
          [eventId]
        )
      : Promise.resolve([]),
    getLinks(ev.kind, eventId),
    queryOne<{ id: number }>(
      `SELECT e.id FROM events e
        WHERE e.kind = $1 AND ${PUBLIC} AND e.curated IS NULL AND e.id <> $2
          AND (COALESCE(e.event_date, ''), e.id) < (COALESCE($3, ''), $2)
        ORDER BY COALESCE(e.event_date, '') DESC, e.id DESC
        LIMIT 1`,
      [ev.kind, eventId, ev.event_date]
    ),
  ]);

  // A struck figure wins over the still-present event_figures row.
  const relatedMerged = [...new Map(
    related.sort((a, b) => Number(a.struck) - Number(b.struck)).map((r) => [r.figure_id, r])
  ).values()];

  const texts = articles.map((a) => [a.title, a.lead, a.body].filter(Boolean).join("\n"));
  const named = await namedPeople(texts, ev.figure_id, relatedMerged);
  // A related figure stays listed even if no article spells out their name —
  // a confirmed link adds them on the record's say-so.
  for (const r of relatedMerged) {
    if (named.some((n) => n.kind === "figure" && n.id === r.figure_id)) continue;
    named.push({
      kind: "figure", id: r.figure_id, name: r.figure_id, role: null,
      aliases: [], articles: 0, verdict: null, struck: r.struck,
    });
  }

  const nearby = ev.kind === "record"
    ? await query<{ event_id: number; title: string | null; event_date: string | null }>(
        `SELECT e.id AS event_id, e.title, e.event_date
           FROM events e
          WHERE e.kind = 'peristiwa' AND ${PUBLIC}
            AND e.curated IS DISTINCT FROM 'rejected'
            AND e.event_date::timestamptz
                BETWEEN $1::timestamptz - interval '7 days'
                    AND $1::timestamptz + interval '7 days'
            AND e.id <> ALL($2::int[])
          ORDER BY abs(extract(epoch FROM e.event_date::timestamptz - $1::timestamptz))
          LIMIT 40`,
        [ev.event_date ?? new Date().toISOString(), links.map((l) => l.event_id)]
      )
    : [];

  return {
    ...ev,
    sources: articles.map(({ body, ...a }) => ({ ...a, lead: plain(a.lead) || plain(body)?.slice(0, 280) || null })),
    owner: owner ? { ...owner, aliases: parseAliases(owner.aliases) } : null,
    named,
    links,
    nearby,
    next_id: next?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writes

/** Record a verdict. `null` clears it, putting the event back in `unreviewed`. */
export async function setCuration(eventId: number, verdict: Verdict | null): Promise<void> {
  await query(`UPDATE events SET curated = $1 WHERE id = $2`, [verdict, eventId]);
}

/**
 * Rule on a record → peristiwa pair. `null` withdraws the ruling: the row
 * stays, verdict-less, until apply_curation.py has cleared it in the pipeline
 * too, or a rejected pair would never be proposed again.
 */
export async function setLinkVerdict(
  recordId: number,
  peristiwaId: number,
  verdict: LinkVerdict | null
): Promise<void> {
  const kinds = await query<{ id: number; kind: string }>(
    `SELECT id, kind FROM events WHERE id = ANY($1::int[])`,
    [[recordId, peristiwaId]]
  );
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  if (kindOf.get(recordId) !== "record" || kindOf.get(peristiwaId) !== "peristiwa") {
    throw new Error("a link joins a record to a peristiwa");
  }
  await query(
    `INSERT INTO record_link_verdicts (record_id, peristiwa_id, verdict, decided_at)
     VALUES ($1, $2, $3, now()::text)
     ON CONFLICT (record_id, peristiwa_id) DO UPDATE
       SET verdict = EXCLUDED.verdict, decided_at = EXCLUDED.decided_at,
           applied_at = NULL`,
    [recordId, peristiwaId, verdict]
  );
}

/**
 * Correct a tracked figure.
 *
 * Written to `figures` as well, so the site shows it now; `figure_edits` is
 * what survives the next push (sync_figures lays it back over the pipeline's
 * row) and what apply_curation.py hands to the pipeline.
 */
export async function saveFigureEdit(
  figureId: string,
  name: string,
  role: string | null,
  aliases: string[],
  active: boolean
): Promise<void> {
  const json = JSON.stringify(aliases);
  await query(
    `INSERT INTO figure_edits (figure_id, name, role, aliases, active, edited_at)
     VALUES ($1, $2, $3, $4, $5, now()::text)
     ON CONFLICT (figure_id) DO UPDATE
       SET name = EXCLUDED.name, role = EXCLUDED.role, aliases = EXCLUDED.aliases,
           active = EXCLUDED.active, edited_at = EXCLUDED.edited_at,
           applied_at = NULL`,
    [figureId, name, role, json, active]
  );
  await query(
    `UPDATE figures SET name = $2, role = $3, aliases = $4, active = $5 WHERE id = $1`,
    [figureId, name, role, json, active]
  );
}

/** Every active figure, for the merge target picker. */
export type FigureOption = { id: string; name: string; role: string | null };

export async function getFigureOptions(): Promise<FigureOption[]> {
  return query(`SELECT id, name, role FROM figures WHERE active ORDER BY name`);
}

/**
 * Fold a duplicate figure into the one it duplicates.
 *
 * The moves run as one statement, so the site never shows the records split
 * between the two. The alias union and the retirement go through
 * saveFigureEdit, which is what keeps them over the next push.
 * `figure_merges` hands the same decision to the pipeline
 * (apply_curation.py → jejak.roster.merge_figure).
 */
export async function mergeFigure(fromId: string, intoId: string): Promise<void> {
  if (fromId === intoId) throw new Error("cannot merge a figure into itself");
  const rows = await query<{ id: string; name: string; role: string | null; aliases: string | null; active: boolean }>(
    `SELECT id, name, role, aliases, active FROM figures WHERE id = ANY($1)`,
    [[fromId, intoId]]
  );
  const from = rows.find((r) => r.id === fromId);
  const into = rows.find((r) => r.id === intoId);
  if (!from || !into) throw new Error("unknown figure");
  if (!into.active) throw new Error(`${intoId} is retired; merge into an active figure`);

  await query(
    `WITH m AS (
       INSERT INTO figure_merges (from_id, into_id, decided_at)
       VALUES ($1, $2, now()::text)
       ON CONFLICT (from_id) DO UPDATE
         SET into_id = EXCLUDED.into_id, decided_at = EXCLUDED.decided_at, applied_at = NULL
       RETURNING 1
     ), e AS (
       UPDATE events SET figure_id = $2 WHERE figure_id = $1 RETURNING 1
     ), a AS (
       UPDATE articles SET figure_id = $2 WHERE figure_id = $1 RETURNING 1
     ), ef AS (
       INSERT INTO event_figures (event_id, figure_id)
       SELECT event_id, $2 FROM event_figures WHERE figure_id = $1
       ON CONFLICT DO NOTHING RETURNING 1
     ), efd AS (
       DELETE FROM event_figures WHERE figure_id = $1 RETURNING 1
     )
     SELECT (SELECT count(*) FROM m) + (SELECT count(*) FROM e) + (SELECT count(*) FROM a)
          + (SELECT count(*) FROM ef) + (SELECT count(*) FROM efd) AS n`,
    [fromId, intoId]
  );

  const have = new Set([into.name, ...parseAliases(into.aliases)].map((a) => a.toLowerCase()));
  const aliases = parseAliases(into.aliases);
  for (const a of [from.name, ...parseAliases(from.aliases)]) {
    if (a && !have.has(a.toLowerCase())) {
      have.add(a.toLowerCase());
      aliases.push(a);
    }
  }
  await saveFigureEdit(intoId, into.name, into.role, aliases, true);
  await saveFigureEdit(fromId, from.name, from.role, parseAliases(from.aliases), false);
}

/** Strike a related figure from a peristiwa, or (`struck = false`) restore it. */
export async function setRelatedFigure(
  eventId: number,
  figureId: string,
  struck: boolean
): Promise<void> {
  // A restore is kept as a row too: the pipeline may already hold the strike,
  // and only apply_curation.py can lift it there.
  await query(
    `INSERT INTO event_figure_rejections (event_id, figure_id, struck, decided_at)
     VALUES ($1, $2, $3, now()::text)
     ON CONFLICT (event_id, figure_id) DO UPDATE
       SET struck = EXCLUDED.struck, decided_at = EXCLUDED.decided_at,
           applied_at = NULL`,
    [eventId, figureId, struck]
  );
}
