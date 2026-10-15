import { lquery as query, lqueryOne as queryOne, lrun, ltx, pipelineOp, pipelineOpInBackground } from "./localDb";

/**
 * Curation, one event at a time.
 *
 * The unit is the event — a record (one figure's action) or a peristiwa (a
 * national story). Everything else a curator corrects hangs off it: the figure
 * who acts in a record, the people its coverage names, and which peristiwa the
 * record is part of.
 *
 * Reads and writes jejak.db, the pipeline's own database (localDb.ts): a
 * decision is in force for the next crawl the moment it is made, and reaches
 * the public site with the next push to Neon.
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

/**
 * Why an event came down. Every takedown names one (or more); the codes are
 * the labels jejak/curation_suggest.py learns from, so they are kept in step
 * with REASONS there. Order is the order /kurasi lists them in.
 */
export const REASONS = [
  { code: "wrong_person", label: "Salah orang", hint: "Liputan tentang orang lain, misalnya nama sama." },
  { code: "not_their_action", label: "Bukan tindakan tokoh", hint: "Tokoh hanya disebut atau dikutip, bukan pelakunya." },
  { code: "trivial", label: "Remeh / seremonial", hint: "Kunjungan, ucapan selamat, seremoni tanpa substansi." },
  { code: "not_newsworthy", label: "Tak relevan untuk rekam jejak", hint: "Benar, tetapi tak berarti bagi rekam jejak tokoh ini." },
  { code: "duplicate", label: "Duplikat", hint: "Sudah ada catatan atau peristiwa yang sama." },
  { code: "mixed", label: "Campuran beberapa kejadian", hint: "Artikelnya tentang kejadian berbeda yang tergabung, mis. dua kebakaran di provinsi lain." },
  { code: "hoax", label: "Hoaks / sudah dibantah", hint: "Klaimnya keliru atau sudah dibantah." },
  { code: "garbled", label: "Judul/ringkasan rusak", hint: "Isinya ada, tetapi judul atau ringkasannya kacau." },
  { code: "cv_material", label: "Bahan CV, bukan peristiwa", hint: "Pelantikan, jabatan baru, latar belakang: masuk ke CV tokoh (lihat “Jadikan info CV”)." },
  { code: "other", label: "Lainnya", hint: "Tulis alasannya di catatan." },
] as const;

export type ReasonCode = (typeof REASONS)[number]["code"];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && REASONS.some((r) => r.code === value);
}

export function reasonLabel(code: string | null | undefined): string {
  return REASONS.find((r) => r.code === code)?.label ?? code ?? "";
}

/** The pipeline's guess at what the curator would do; see curation_suggest.py. */
export interface Suggestion {
  reason: ReasonCode | null;
  confidence: number | null;
  support: number;
  examples: number[];
  auto_hide: boolean;
}

/** Why the curator ruled as they did, as recorded beside the verdict. */
export interface Ruling {
  reasons: ReasonCode[];
  note: string | null;
  suggested: string | null;
}

export type LinkVerdict = "confirmed" | "rejected";

export function isLinkVerdict(value: unknown): value is LinkVerdict {
  return value === "confirmed" || value === "rejected";
}

export type Kind = "record" | "peristiwa";

/**
 * Which slice of the queue to show. `links` = records with unruled proposals;
 * `followups` = events with an unruled follow-up proposal on either side;
 * `suggested` = unreviewed events the suggester would take down; `auto` =
 * events it did take down, waiting for a curator to confirm or restore.
 */
export type Filter = "unreviewed" | "suggested" | "auto" | "live" | "rejected" | "links" | "followups";

const PUBLIC = "e.status IN ('new', 'summarized', 'approved')";

const AUTO_HIDDEN = `e.curated IS NULL AND EXISTS (
    SELECT 1 FROM curation_suggestions cs WHERE cs.event_id = e.id AND cs.auto_hide = 1)`;

const FILTER_SQL: Record<Filter, string> = {
  live: `e.curated IS NOT 'rejected' AND NOT (${AUTO_HIDDEN})`,
  rejected: "e.curated = 'rejected'",
  unreviewed: "e.curated IS NULL",
  suggested: `e.curated IS NULL AND EXISTS (
    SELECT 1 FROM curation_suggestions cs
     WHERE cs.event_id = e.id AND cs.reason IS NOT NULL AND cs.auto_hide = 0)`,
  auto: AUTO_HIDDEN,
  followups: `EXISTS (
    SELECT 1 FROM followup_links l
     WHERE (l.earlier_id = e.id OR l.later_id = e.id) AND l.verdict IS NULL)`,
  links: `EXISTS (
    SELECT 1 FROM record_links l WHERE l.record_id = e.id AND l.verdict IS NULL)`,
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
  has_summary: boolean | number;
  /** Proposed peristiwa links nobody has ruled on (records only). */
  open_links: number;
  confirmed_links: number;
  /** Takedown reasons, for a rejected row. */
  reasons: ReasonCode[];
  suggestion: Suggestion | null;
}

interface SuggestionColumns {
  s_reason: ReasonCode | null;
  s_confidence: number | null;
  s_support: number | null;
  s_examples: string | null;
  s_auto_hide: number | null;
  scored: boolean | number;
}

const SUGGESTION_SELECT = `cs.reason AS s_reason, cs.confidence AS s_confidence,
            cs.support AS s_support, cs.examples AS s_examples,
            cs.auto_hide AS s_auto_hide, cs.event_id IS NOT NULL AS scored`;

function jsonCodes(raw: string | null | undefined): ReasonCode[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isReasonCode) : [];
  } catch {
    return [];
  }
}

function suggestionOf(r: SuggestionColumns): Suggestion | null {
  if (!r.scored || (!r.s_reason && !r.s_auto_hide)) return null;
  let examples: number[] = [];
  try {
    const parsed: unknown = JSON.parse(r.s_examples ?? "[]");
    if (Array.isArray(parsed)) examples = parsed.filter((x): x is number => typeof x === "number");
  } catch {
    // a malformed list only costs the "like these" links
  }
  return {
    reason: isReasonCode(r.s_reason) ? r.s_reason : null,
    confidence: r.s_confidence === null ? null : Number(r.s_confidence),
    support: Number(r.s_support ?? 0),
    examples,
    auto_hide: Number(r.s_auto_hide ?? 0) === 1,
  };
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
  const rows = await query<Omit<QueueRow, "reasons" | "suggestion"> & SuggestionColumns & { reasons: string | null }>(
    `SELECT e.id AS event_id, e.kind, e.figure_id, f.name AS figure_name,
            e.event_date, e.title, e.curated, cr.reasons, ${SUGGESTION_SELECT},
            COALESCE(src.outlet_count, 0)  AS outlet_count,
            COALESCE(src.article_count, 0) AS article_count,
            es.event_id IS NOT NULL        AS has_summary,
            COALESCE(lk.open_links, 0)      AS open_links,
            COALESCE(lk.confirmed_links, 0) AS confirmed_links
       FROM events e
       LEFT JOIN figures f ON f.id = e.figure_id
       LEFT JOIN event_summaries es ON es.event_id = e.id
       LEFT JOIN curation_labels cr ON cr.event_id = e.id
       LEFT JOIN curation_suggestions cs ON cs.event_id = e.id
       LEFT JOIN (
         SELECT event_id, count(DISTINCT source) AS outlet_count, count(*) AS article_count
           FROM articles WHERE event_id IS NOT NULL GROUP BY event_id
       ) src ON src.event_id = e.id
       LEFT JOIN (
         SELECT CASE WHEN ?1 = 'record' THEN record_id ELSE peristiwa_id END AS event_id,
                count(*) FILTER (WHERE verdict IS NULL)        AS open_links,
                count(*) FILTER (WHERE verdict = 'confirmed')  AS confirmed_links
           FROM record_links GROUP BY 1
       ) lk ON lk.event_id = e.id
      WHERE e.kind = ?1 AND ${PUBLIC} AND ${FILTER_SQL[filter]}
      ORDER BY ${filter === "suggested" ? "cs.confidence DESC NULLS LAST," : ""}
               e.event_date DESC NULLS LAST, e.id DESC
      LIMIT ?2 OFFSET ?3`,
    [kind, PAGE_SIZE, (Math.max(page, 1) - 1) * PAGE_SIZE]
  );
  return rows.map(({ s_reason, s_confidence, s_support, s_examples, s_auto_hide, scored, reasons, ...r }) => ({
    ...r,
    has_summary: Boolean(r.has_summary),
    reasons: jsonCodes(reasons),
    suggestion: suggestionOf({ s_reason, s_confidence, s_support, s_examples, s_auto_hide, scored }),
  }));
}

export async function getQueueCounts(kind: Kind): Promise<Record<Filter, number>> {
  const keys = Object.keys(FILTER_SQL) as Filter[];
  const row = await queryOne<Record<Filter, string>>(
    `SELECT ${keys.map((k) => `count(*) FILTER (WHERE ${FILTER_SQL[k]}) AS ${k}`).join(",\n            ")}
       FROM events e
      WHERE e.kind = ? AND ${PUBLIC}`,
    [kind]
  );
  return Object.fromEntries(keys.map((k) => [k, Number(row?.[k] ?? 0)])) as Record<Filter, number>;
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
  /** The article's id, for opening it in the reading pane. */
  id: string;
  /** Whether the pipeline holds its text, so it can be read here. */
  has_body: boolean;
  source: string;
  url: string;
  title: string | null;
  published_at: string | null;
  lead: string | null;
}

/** One office a figure holds or held. The first in a list is the main one. */
export interface Position {
  role: string;
  org: string;
  /** Free text: "2024–sekarang", "2019–2024". */
  period: string;
}

/** "Ketua" + "MPR RI" → "Ketua MPR RI": the one-line title shown under a name. */
export function positionTitle(p: Position): string {
  return [p.role, p.org].map((x) => x.trim()).filter(Boolean).join(" ");
}

export function parsePositions(raw: unknown): Position[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((x) =>
      x && typeof x === "object"
        ? [{
            role: String((x as Record<string, unknown>).role ?? ""),
            org: String((x as Record<string, unknown>).org ?? ""),
            period: String((x as Record<string, unknown>).period ?? ""),
          }]
        : []
    );
  } catch {
    return [];
  }
}

/** The CV fields beside positions, as /kurasi edits them. */
export interface Profile {
  /** Not edited in /kurasi; null leaves the stored one as it is. */
  bio: string | null;
  facts: { label: string; value: string }[];
  education: { year?: string; detail: string }[];
  sources: { label: string; url: string }[];
}

function jsonList<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export interface FigureRef {
  id: string;
  name: string;
  role: string | null;
  aliases: string[];
  positions: Position[];
  /** The rest of the CV; owners only (the record's own figure). */
  profile: Profile;
  cv_checked_at: string | null;
  active: boolean;
}

/** Someone the coverage names. `articles` = how many of the event's articles. */
export interface NamedPerson {
  kind: "figure" | "candidate";
  id: string;
  name: string;
  role: string | null;
  /** Figures only. */
  aliases: string[];
  /** Figures only. */
  positions: Position[];
  articles: number;
  /** Candidates only: the verdict already recorded, if any. */
  verdict: string | null;
  /** Peristiwa only: a related figure the curator struck. */
  struck?: boolean;
  /** The record's own figure: who the record is about. */
  owner?: boolean;
  /** Figures only: the rest of the CV, so every figure edits the same way. */
  profile?: Profile;
  cv_checked_at?: string | null;
  active?: boolean;
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

/** A follow-up pair seen from one end: the event on the other side. */
export interface FollowupRow {
  event_id: number;
  title: string | null;
  event_date: string | null;
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
  ruling: Ruling | null;
  suggestion: Suggestion | null;
  /** What this event follows up, and what follows it up. */
  followups: { earlier: FollowupRow[]; later: FollowupRow[] };
  /** The labelled events the suggestion leans on, for "like these". */
  examples: { event_id: number; title: string | null; reasons: ReasonCode[] }[];
  /** NULL = the figure's own act; 'about' = coverage concerning them. */
  framing: string | null;
  /** Rework requests on this event, newest first. */
  reworks: Rework[];
  /** "Jadikan info CV" drafts from this event, newest first. */
  cvProposals: CvProposal[];
}

/** CV entries drafted from an event's articles (jejak/cv_extract.py). */
export interface CvDraft {
  positions: Position[];
  facts: { label: string; value: string }[];
  education: { year?: string; detail: string }[];
  sources: { label: string; url: string }[];
}

export interface CvProposal {
  id: number;
  figure_id: string;
  note: string | null;
  status: ReworkStatus;
  proposal: CvDraft | null;
  error: string | null;
  created_at: string;
}

/** An event as a rework sees it, before and after. */
export interface ReworkSnapshot {
  kind: Kind;
  figure_id: string | null;
  framing: string | null;
  title: string | null;
  event_type: string | null;
  summary_text: string | null;
}

export type ReworkStatus = "queued" | "running" | "ready" | "accepted" | "discarded" | "failed";

/** A curator's request to have an event written again (scripts/kurasi_ops.py rework). */
export interface Rework {
  id: number;
  note: string | null;
  framing: "own" | "about" | null;
  new_figure_id: string | null;
  to_peristiwa: boolean;
  status: ReworkStatus;
  error: string | null;
  before: ReworkSnapshot | null;
  after: ReworkSnapshot | null;
  created_at: string;
  finished_at: string | null;
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

/** Shorter than this, a stored body is a failed fetch's leftovers (a cookie
 *  notice, "Baca berita tanpa iklan"), not something to read. */
const MIN_READABLE = 200;

export interface ReadingArticle {
  id: string;
  source: string;
  url: string;
  title: string | null;
  published_at: string | null;
  lead: string | null;
  /** Paragraphs, in Indonesian (a translation when `lang` says otherwise). */
  paragraphs: string[];
  /** The language the article was published in, when it was not Indonesian. */
  lang: string | null;
  /** The stored text stops at a paywall ("Arsip premium…"). */
  truncated: boolean;
}

/** How an outlet's paywall ends the text the fetcher was given. */
const PAYWALL = /Arsip premium dapat diakses|Gabung Premium KOMPAS\.com PLUS|Baca selengkapnya di aplikasi/i;

/**
 * One of the event's articles, as the curation page's reading pane shows it:
 * the text the pipeline fetched, so the curator need not leave the page — most
 * news sites refuse to be framed.
 *
 * Only an article of this event: the id comes from the URL.
 */
export async function getReading(eventId: number, articleId: string): Promise<ReadingArticle | null> {
  const row = await queryOne<{
    id: string; source: string; url: string; title: string | null;
    published_at: string | null; summary: string | null; body: string | null; body_lang: string | null;
  }>(
    `SELECT id, source, url, title, published_at, summary, body, body_lang
       FROM articles WHERE id = ? AND event_id = ?`,
    [articleId, eventId]
  );
  if (!row) return null;
  const body = row.body?.trim() ?? "";
  const paragraphs = body.length >= MIN_READABLE
    ? body.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  return {
    id: row.id, source: row.source, url: row.url, title: row.title,
    published_at: row.published_at, lead: plain(row.summary), paragraphs,
    lang: row.body_lang && row.body_lang !== "id" ? row.body_lang : null,
    truncated: PAYWALL.test(body),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word occurrence. `\b` is ASCII-only in JS, so letters are spelled out. */
function wordPattern(term: string, flags: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}])`, `u${flags}`);
}

function candidateRecordIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.flatMap((r) => (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "number" ? [(r as { id: number }).id] : []))
      : [];
  } catch {
    return [];
  }
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
  related: { figure_id: string; struck: boolean }[],
  eventId: number
): Promise<NamedPerson[]> {
  const [figures, candidates] = await Promise.all([
    query<{
      id: string; name: string; role: string | null; aliases: string | null; positions: string | null;
      bio: string | null; facts: string | null; education: string | null; sources: string | null;
      cv_checked_at: string | null;
    }>(
      `SELECT id, name, role, aliases, positions, bio, facts, education, sources, cv_checked_at
         FROM figures WHERE active`
    ),
    // The queue's names (3+ outlets), and any name mined from this event's
    // own articles however few outlets used it: here the curator is reading
    // the evidence, so one article is enough to ask. Decided names are
    // carried out at once (kurasi_ops.py), so an applied verdict is settled.
    query<{ slug: string; name: string; role: string | null; verdict: string | null; full_name: string | null; records: string | null }>(
      `SELECT slug, name, COALESCE(curated_role, role) AS role, verdict, full_name, records
         FROM candidate_review
        WHERE slug NOT IN (SELECT id FROM figures)
          AND (verdict IS NULL OR applied_at IS NULL)
       UNION
       SELECT c.slug, c.name,
              (SELECT m2.role FROM figure_mentions m2
                WHERE m2.slug = c.slug AND m2.role <> '' LIMIT 1),
              NULL, NULL, json_array(json_object('id', ?1))
         FROM figure_candidates c
        WHERE c.status = 'candidate'
          AND c.slug NOT IN (SELECT id FROM figures)
          AND c.slug NOT IN (SELECT slug FROM candidate_review)
          AND EXISTS (SELECT 1 FROM figure_mentions m JOIN articles a ON a.id = m.article_id
                       WHERE m.slug = c.slug AND a.event_id = ?1)`,
      [eventId]
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
      aliases: parseAliases(f.aliases), positions: parsePositions(f.positions),
      articles: n, verdict: null,
      struck: relatedIds.get(f.id),
      profile: {
        bio: f.bio ?? "", facts: jsonList(f.facts), education: jsonList(f.education), sources: jsonList(f.sources),
      },
      cv_checked_at: f.cv_checked_at, active: true,
    });
  }
  for (const c of candidates) {
    const n = count([wordPattern(c.name, "")]);
    // The queue links a name to the records its evidence clustered into, and
    // sends the curator here to decide it. The evidence article is not always
    // one the site holds text for, so that link counts even when no article
    // here spells the name.
    if (n === 0 && !candidateRecordIds(c.records).includes(eventId)) continue;
    out.push({
      kind: "candidate", id: c.slug, name: c.full_name || c.name, role: c.role,
      aliases: [], positions: [], articles: n, verdict: c.verdict,
    });
  }
  return out.sort((a, b) => b.articles - a.articles || a.name.localeCompare(b.name));
}

async function getFollowups(eventId: number): Promise<{ earlier: FollowupRow[]; later: FollowupRow[] }> {
  const rows = await query<Omit<FollowupRow, "proposed"> & { evidence: string | null; side: "earlier" | "later"; proposed: number }>(
    `SELECT CASE WHEN l.later_id = ?1 THEN 'earlier' ELSE 'later' END AS side,
            o.id AS event_id, o.title, o.event_date,
            l.score, l.evidence, l.verdict, l.origin IS NOT 'curator' AS proposed
       FROM followup_links l
       JOIN events o ON o.id = CASE WHEN l.later_id = ?1 THEN l.earlier_id ELSE l.later_id END
      WHERE l.earlier_id = ?1 OR l.later_id = ?1
      ORDER BY (l.verdict = 'confirmed') DESC NULLS LAST,
               (l.verdict = 'rejected') ASC NULLS FIRST,
               l.score DESC NULLS LAST`,
    [eventId]
  );
  const out = { earlier: [] as FollowupRow[], later: [] as FollowupRow[] };
  for (const { side, ...r } of rows) {
    out[side].push({ ...r, proposed: Boolean(r.proposed), evidence: parseAliases(r.evidence) });
  }
  return out;
}

async function getLinks(kind: Kind, eventId: number): Promise<LinkRow[]> {
  // The same pairs seen from either end: a record page lists peristiwa, a
  // peristiwa page lists records.
  const [self, other] = kind === "record"
    ? ["record_id", "peristiwa_id"]
    : ["peristiwa_id", "record_id"];
  const rows = await query<Omit<LinkRow, "proposed"> & { evidence: string | null; proposed: number }>(
    `SELECT l.${other} AS event_id, o.title, o.event_date,
            f.name AS figure_name,
            l.score, l.evidence, l.verdict,
            l.origin IS NOT 'curator' AS proposed
       FROM record_links l
       JOIN events o ON o.id = l.${other}
       LEFT JOIN figures f ON f.id = o.figure_id
      WHERE l.${self} = ?
      ORDER BY (l.verdict = 'confirmed') DESC NULLS LAST,
               (l.verdict = 'rejected') ASC NULLS FIRST,
               l.score DESC NULLS LAST`,
    [eventId]
  );
  return rows.map((r) => ({ ...r, proposed: Boolean(r.proposed), evidence: parseAliases(r.evidence) }));
}

export async function getItem(eventId: number): Promise<Item | null> {
  const row = await queryOne<
    Omit<Item, "sources" | "owner" | "named" | "links" | "nearby" | "next_id" | "ruling" | "suggestion" | "examples" | "reworks" | "cvProposals">
    & SuggestionColumns
    & { r_reasons: string | null; r_note: string | null; r_suggested: string | null }
  >(
    `SELECT e.id AS event_id, e.kind, e.figure_id, e.event_date, e.last_seen,
            e.title, e.event_type, e.status, e.curated, e.framing,
            es.summary_text AS summary,
            cr.reasons AS r_reasons, cr.note AS r_note, cr.suggested AS r_suggested,
            ${SUGGESTION_SELECT}
       FROM events e
       LEFT JOIN event_summaries es ON es.event_id = e.id
       LEFT JOIN curation_labels cr ON cr.event_id = e.id
       LEFT JOIN curation_suggestions cs ON cs.event_id = e.id
      WHERE e.id = ?`,
    [eventId]
  );
  if (!row) return null;
  const { s_reason, s_confidence, s_support, s_examples, s_auto_hide, scored, r_reasons, r_note, r_suggested, ...ev } = row;
  const suggestion = suggestionOf({ s_reason, s_confidence, s_support, s_examples, s_auto_hide, scored });
  const ruling: Ruling | null = r_reasons === null && r_note === null
    ? null
    : { reasons: jsonCodes(r_reasons), note: r_note, suggested: r_suggested };
  const examples = suggestion?.examples.length
    ? await query<{ event_id: number; title: string | null; reasons: string | null }>(
        `SELECT cr.event_id, COALESCE(e.title, cr.title) AS title, cr.reasons
           FROM curation_labels cr LEFT JOIN events e ON e.id = cr.event_id
          WHERE cr.event_id IN (SELECT value FROM json_each(?))`,
        [suggestion.examples.slice(0, 5)]
      )
    : [];

  const [articles, owner, related, links, next, followups, reworks, cvProposals] = await Promise.all([
    query<Omit<ItemSource, "has_body"> & { body: string | null }>(
      `SELECT id, source, url, title, published_at, summary AS lead, body
         FROM articles WHERE event_id = ?
        ORDER BY published_at NULLS FIRST, id`,
      [eventId]
    ),
    ev.figure_id
      ? queryOne<{
          id: string; name: string; role: string | null; aliases: string | null; positions: string | null;
          bio: string | null; facts: string | null; education: string | null; sources: string | null;
          cv_checked_at: string | null; active: number;
        }>(
          `SELECT f.id, f.name, f.role, f.aliases, f.positions, f.bio, f.facts, f.education,
                  f.sources, f.cv_checked_at, f.active
             FROM figures f
            WHERE f.id = ?`,
          [ev.figure_id]
        )
      : Promise.resolve(null),
    ev.kind === "peristiwa"
      // A row in event_figure_rejections is a strike; the pipeline also
      // dropped the event_figures row when it was made.
      ? query<{ figure_id: string; struck: number }>(
          `SELECT figure_id, 0 AS struck FROM event_figures WHERE event_id = ?1
            UNION
           SELECT figure_id, 1 FROM event_figure_rejections WHERE event_id = ?1`,
          [eventId]
        ).then((rows) => rows.map((r) => ({ figure_id: r.figure_id, struck: Boolean(r.struck) })))
      : Promise.resolve([]),
    getLinks(ev.kind, eventId),
    queryOne<{ id: number }>(
      `SELECT e.id FROM events e
        WHERE e.kind = ?1 AND ${PUBLIC} AND e.curated IS NULL AND e.id <> ?2
          AND (COALESCE(e.event_date, ''), e.id) < (COALESCE(?3, ''), ?2)
        ORDER BY COALESCE(e.event_date, '') DESC, e.id DESC
        LIMIT 1`,
      [ev.kind, eventId, ev.event_date]
    ),
    getFollowups(eventId),
    getReworks(eventId),
    getCvProposals(eventId),
  ]);

  // A struck figure wins over the still-present event_figures row.
  const relatedMerged = [...new Map(
    related.sort((a, b) => Number(a.struck) - Number(b.struck)).map((r) => [r.figure_id, r])
  ).values()];

  const texts = articles.map((a) => [a.title, a.lead, a.body].filter(Boolean).join("\n"));
  const named = await namedPeople(texts, ev.figure_id, relatedMerged, eventId);
  // A related figure stays listed even if no article spells out their name —
  // a confirmed link adds them on the record's say-so.
  for (const r of relatedMerged) {
    if (named.some((n) => n.kind === "figure" && n.id === r.figure_id)) continue;
    named.push({
      kind: "figure", id: r.figure_id, name: r.figure_id, role: null,
      aliases: [], positions: [], articles: 0, verdict: null, struck: r.struck,
    });
  }

  const nearby = ev.kind === "record"
    ? await query<{ event_id: number; title: string | null; event_date: string | null }>(
        `SELECT e.id AS event_id, e.title, e.event_date
           FROM events e
          WHERE e.kind = 'peristiwa' AND ${PUBLIC}
            AND e.curated IS NOT 'rejected'
            AND abs(julianday(e.event_date) - julianday(?1)) <= 7
            AND e.id NOT IN (SELECT value FROM json_each(?2))
          ORDER BY abs(julianday(e.event_date) - julianday(?1))
          LIMIT 40`,
        [ev.event_date ?? new Date().toISOString(), links.map((l) => l.event_id)]
      )
    : [];

  // The record's figure heads the list: one place for every person in the
  // coverage, the owner marked rather than kept apart.
  if (owner) {
    const terms = [owner.name, ...parseAliases(owner.aliases)].filter((t) => t.trim().length > 2);
    named.unshift({
      kind: "figure", id: owner.id, name: owner.name, role: owner.role,
      aliases: parseAliases(owner.aliases), positions: parsePositions(owner.positions),
      articles: texts.filter((t) => terms.some((x) => wordPattern(x, "i").test(t))).length,
      verdict: null, owner: true,
      profile: {
        bio: owner.bio ?? "", facts: jsonList(owner.facts),
        education: jsonList(owner.education), sources: jsonList(owner.sources),
      },
      cv_checked_at: owner.cv_checked_at, active: Boolean(owner.active),
    });
  }

  return {
    ...ev,
    sources: articles.map(({ body, ...a }) => ({
      ...a,
      lead: plain(a.lead) || plain(body)?.slice(0, 280) || null,
      has_body: (body?.trim().length ?? 0) >= MIN_READABLE,
    })),
    owner: owner
      ? {
          id: owner.id, name: owner.name, role: owner.role, active: Boolean(owner.active),
          cv_checked_at: owner.cv_checked_at,
          aliases: parseAliases(owner.aliases),
          positions: parsePositions(owner.positions),
          profile: {
            bio: owner.bio ?? "",
            facts: jsonList(owner.facts),
            education: jsonList(owner.education),
            sources: jsonList(owner.sources),
          },
        }
      : null,
    named,
    links,
    nearby,
    next_id: next?.id ?? null,
    ruling,
    suggestion,
    followups,
    examples: examples.map((x) => ({ ...x, reasons: jsonCodes(x.reasons) })),
    reworks,
    cvProposals,
  };
}

async function getCvProposals(eventId: number): Promise<CvProposal[]> {
  const rows = await query<Omit<CvProposal, "proposal"> & { proposal: string | null }>(
    `SELECT id, figure_id, note, status, proposal, error, created_at
       FROM cv_proposals WHERE event_id = ? ORDER BY id DESC LIMIT 5`,
    [eventId]
  );
  return rows.map((r) => {
    let proposal: CvDraft | null = null;
    try {
      proposal = r.proposal ? (JSON.parse(r.proposal) as CvDraft) : null;
    } catch {
      proposal = null;
    }
    return { ...r, proposal };
  });
}

/**
 * "Jadikan info CV": have the local model draft what this event's articles
 * say about a figure's offices, background and education
 * (scripts/kurasi_ops.py cv-draft), for the curator to check and accept.
 */
export async function requestCvDraft(eventId: number, figureId: string, note: string | null): Promise<void> {
  const fig = await queryOne(`SELECT 1 FROM figures WHERE id = ? AND active`, [figureId]);
  if (!fig) throw new Error(`unknown figure: ${figureId}`);
  const busy = await queryOne(
    `SELECT 1 FROM cv_proposals WHERE event_id = ? AND status IN ('queued', 'running') AND created_at > ?`,
    [eventId, new Date(Date.now() - 15 * 60_000).toISOString()]
  );
  if (busy) throw new Error("a CV draft for this event is already running");
  await lrun(
    `INSERT INTO cv_proposals (event_id, figure_id, note, created_at) VALUES (?, ?, ?, ?)`,
    [eventId, figureId, note, new Date().toISOString()]
  );
  const row = await queryOne<{ id: number }>(`SELECT max(id) AS id FROM cv_proposals WHERE event_id = ?`, [eventId]);
  pipelineOpInBackground("cv-draft", String(row!.id));
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Put the entries the curator kept onto the figure's CV, then take the record
 * down as "Bahan CV" — it was a fact about someone, not something they did.
 *
 * Offices already listed (same role and body) are not repeated; a current one
 * ("… – kini") goes first, since the first office is the figure's title. A
 * fact replaces one with the same label. The article joins the CV's sources.
 */
export async function acceptCvDraft(proposalId: number, kept: CvDraft): Promise<void> {
  const p = await queryOne<{ event_id: number; figure_id: string; status: string }>(
    `SELECT event_id, figure_id, status FROM cv_proposals WHERE id = ?`, [proposalId]
  );
  if (!p || p.status !== "ready") throw new Error("this CV draft is not ready");
  const f = await queryOne<{ positions: string | null; facts: string | null; education: string | null; sources: string | null }>(
    `SELECT positions, facts, education, sources FROM figures WHERE id = ?`, [p.figure_id]
  );
  if (!f) throw new Error(`unknown figure: ${p.figure_id}`);

  const positions = parsePositions(f.positions);
  for (const pos of kept.positions) {
    if (positions.some((x) => sameText(x.role, pos.role) && sameText(x.org, pos.org))) continue;
    if (/kini|sekarang/i.test(pos.period)) positions.unshift(pos);
    else positions.push(pos);
  }
  const facts = jsonList<{ label: string; value: string }>(f.facts);
  for (const fact of kept.facts) {
    const i = facts.findIndex((x) => sameText(x.label, fact.label));
    if (i >= 0) facts[i] = fact;
    else facts.push(fact);
  }
  const education = jsonList<{ year?: string; detail: string }>(f.education);
  for (const e of kept.education) {
    if (!education.some((x) => sameText(x.detail, e.detail))) education.push(e);
  }
  const sources = jsonList<{ label: string; url: string }>(f.sources);
  for (const src of kept.sources) {
    if (!sources.some((x) => x.url === src.url)) sources.push(src);
  }

  await ltx(async () => {
    await lrun(
      `UPDATE figures SET positions = ?, role = COALESCE(?, role), facts = ?, education = ?, sources = ?,
              cv_curated = 1 WHERE id = ?`,
      [JSON.stringify(positions), positions[0] ? positionTitle(positions[0]) : null,
       JSON.stringify(facts), JSON.stringify(education), JSON.stringify(sources), p.figure_id]
    );
    // What the curator kept, beside what the model drafted: the nightly
    // `kurasi` stage learns from the difference.
    await lrun(`UPDATE cv_proposals SET status = 'accepted', accepted = ?, decided_at = ? WHERE id = ?`,
      [JSON.stringify(kept), new Date().toISOString(), proposalId]);
  });
  await setCuration(p.event_id, "rejected", ["cv_material"], `Masuk CV ${p.figure_id}`);
}

export async function discardCvDraft(proposalId: number): Promise<void> {
  await lrun(
    `UPDATE cv_proposals SET status = 'discarded', decided_at = ? WHERE id = ? AND status IN ('ready', 'failed')`,
    [new Date().toISOString(), proposalId]
  );
}

async function getReworks(eventId: number): Promise<Rework[]> {
  const rows = await query<Omit<Rework, "before" | "after" | "to_peristiwa"> & {
    before: string | null; after: string | null; to_peristiwa: number;
  }>(
    `SELECT id, note, framing, new_figure_id, to_peristiwa, status, error, before, after,
            created_at, finished_at
       FROM rework_requests WHERE event_id = ? ORDER BY id DESC LIMIT 10`,
    [eventId]
  );
  const snap = (raw: string | null): ReworkSnapshot | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReworkSnapshot;
    } catch {
      return null;
    }
  };
  return rows.map((r) => ({ ...r, to_peristiwa: Boolean(r.to_peristiwa), before: snap(r.before), after: snap(r.after) }));
}

/**
 * Ask for an event to be written again: with the curator's note correcting
 * the current draft, framed as about the figure rather than by them, given to
 * another figure, or made a peristiwa — any combination. The local model
 * drafts it in the background; nothing changes until the draft is accepted.
 */
export async function requestRework(
  eventId: number,
  opts: { note: string | null; framing: "own" | "about" | null; newFigureId: string | null; toPeristiwa: boolean }
): Promise<void> {
  if (!opts.note && !opts.framing && !opts.newFigureId && !opts.toPeristiwa) {
    throw new Error("a rework needs a note or a change to ask for");
  }
  const busy = await queryOne(
    // One at a time per event; a run that died (a closed laptop) stops
    // blocking after a quarter of an hour.
    `SELECT 1 FROM rework_requests
      WHERE event_id = ? AND status IN ('queued', 'running')
        AND created_at > ?`, [eventId, new Date(Date.now() - 15 * 60_000).toISOString()]
  );
  if (busy) throw new Error("a rework of this event is already running");
  await lrun(
    `INSERT INTO rework_requests (event_id, note, framing, new_figure_id, to_peristiwa, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [eventId, opts.note, opts.framing, opts.newFigureId, opts.toPeristiwa, new Date().toISOString()]
  );
  const row = await queryOne<{ id: number }>(`SELECT max(id) AS id FROM rework_requests WHERE event_id = ?`, [eventId]);
  pipelineOpInBackground("rework", String(row!.id));
}

/** Make a ready draft the event's entry. */
export async function acceptRework(requestId: number): Promise<void> {
  await pipelineOp("rework-accept", String(requestId));
}

/** Throw a ready draft away; the event stays as it was. */
export async function discardRework(requestId: number): Promise<void> {
  await lrun(
    `UPDATE rework_requests SET status = 'discarded', decided_at = ? WHERE id = ? AND status IN ('ready', 'failed')`,
    [new Date().toISOString(), requestId]
  );
}

// ---------------------------------------------------------------------------
// Writes

/**
 * Record a verdict and why. `null` clears it, putting the event back in
 * `unreviewed` and dropping its label.
 *
 * The label snapshots the event as the curator saw it, so it still means
 * something after the pipeline re-clusters or drops the event; it is what
 * jejak/curation_suggest.py learns from. Written together with the verdict,
 * so the two never disagree.
 */
export async function setCuration(
  eventId: number,
  verdict: Verdict | null,
  reasons: ReasonCode[] = [],
  note: string | null = null,
  suggested: string | null = null
): Promise<void> {
  await ltx(async () => {
    await lrun(`UPDATE events SET curated = ? WHERE id = ?`, [verdict, eventId]);
    if (verdict === null) {
      await lrun(`DELETE FROM curation_labels WHERE event_id = ?`, [eventId]);
      return;
    }
    await lrun(
      `INSERT INTO curation_labels
              (event_id, verdict, reasons, note, kind, figure_id, title, summary,
               outlets, suggested, decided_at)
       SELECT e.id, ?2, ?3, ?4, e.kind, e.figure_id, e.title, es.summary_text,
              (SELECT count(DISTINCT a.source) FROM articles a WHERE a.event_id = e.id),
              ?5, ?6
         FROM events e
         LEFT JOIN event_summaries es ON es.event_id = e.id
        WHERE e.id = ?1
       ON CONFLICT (event_id) DO UPDATE
         SET verdict = excluded.verdict, reasons = excluded.reasons,
             note = excluded.note, title = excluded.title,
             summary = excluded.summary, outlets = excluded.outlets,
             suggested = COALESCE(excluded.suggested, curation_labels.suggested),
             decided_at = excluded.decided_at`,
      [eventId, verdict, JSON.stringify(reasons), note, suggested, new Date().toISOString()]
    );
  });
}

/**
 * Rule on a record → peristiwa pair, or (`null`) withdraw the ruling.
 *
 * The verdict sits on the link row itself. A pair the pipeline never proposed
 * is the curator's own (`origin = 'curator'`) and goes when withdrawn; a
 * rejected proposal stays, so link.py never proposes it again.
 */
export async function setLinkVerdict(
  recordId: number,
  peristiwaId: number,
  verdict: LinkVerdict | null
): Promise<void> {
  const kinds = await query<{ id: number; kind: string }>(
    `SELECT id, kind FROM events WHERE id IN (?, ?)`,
    [recordId, peristiwaId]
  );
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  if (kindOf.get(recordId) !== "record" || kindOf.get(peristiwaId) !== "peristiwa") {
    throw new Error("a link joins a record to a peristiwa");
  }
  await setPairVerdict("record_links", "record_id", "peristiwa_id", recordId, peristiwaId, verdict);
}

/** The shared write behind record links and follow-ups. */
async function setPairVerdict(
  table: "record_links" | "followup_links",
  a: string,
  b: string,
  aId: number,
  bId: number,
  verdict: LinkVerdict | null
): Promise<void> {
  await ltx(async () => {
    if (verdict === null) {
      await lrun(`UPDATE ${table} SET verdict = NULL WHERE ${a} = ? AND ${b} = ?`, [aId, bId]);
      await lrun(`DELETE FROM ${table} WHERE ${a} = ? AND ${b} = ? AND origin = 'curator'`, [aId, bId]);
      return;
    }
    await lrun(
      `INSERT INTO ${table} (${a}, ${b}, origin, verdict, created_at)
       VALUES (?, ?, 'curator', ?, ?)
       ON CONFLICT (${a}, ${b}) DO UPDATE SET verdict = excluded.verdict`,
      [aId, bId, verdict, new Date().toISOString()]
    );
  });
}

/** An event the curator might chain to the one open, before or after it. */
export interface FollowupCandidate {
  event_id: number;
  title: string | null;
  event_date: string | null;
  /** Whether it happened before the open event, by date. */
  before: boolean;
  /** Distinctive words both share; why it is suggested. */
  shared: string[];
}

const STOP = new Set(`yang dengan untuk dari dalam akan pada tidak juga atau sudah karena bahwa oleh
saat setelah masih para lebih belum hingga agar bisa harus jadi menjadi terkait soal usai jelang
antara sebut minta tegaskan ungkap kata menyatakan menolak menyampaikan mengatakan meminta
tentang terhadap kepada sebagai bersama secara akibat berbagai beberapa daerah indonesia
presiden menteri pemerintah warga tahun hari baru kembali sumber lalu memiliki tersebut atas
sekitar satu dua tiga menurut mungkin waktu butuh membutuhkan berhasil peristiwa sejumlah
banyak telah dapat adalah ialah merupakan dilakukan melakukan memberikan diberikan pihak
kegiatan upaya rencana`.split(/\s+/));

function words(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? "")
      // "[Sumber 2]" citation markers in summaries.
      .replace(/\[sumber[^\]]*\]/gi, " ")
      .toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
  );
}

/**
 * Events the curator might chain to this one, so a follow-up is picked from
 * a list instead of typed in by number.
 *
 * Same kind, and for a record the same figure: a figure's story is told on
 * their page. Without a search, the ones within FOLLOWUP_WINDOW_DAYS that
 * share the most distinctive title-and-summary words (a word scores by how
 * rare it is among the candidates, so "kebakaran" counts for less than
 * "garibaldi"); with one, any whose title contains it.
 * Pairs already proposed or ruled on are left out — they are listed above.
 */
const FOLLOWUP_WINDOW_DAYS = 60;

export async function getFollowupCandidates(item: Item, search = ""): Promise<FollowupCandidate[]> {
  const exclude = [item.event_id, ...item.followups.earlier.map((f) => f.event_id), ...item.followups.later.map((f) => f.event_id)];
  const q = search.trim();
  const rows = await query<{ event_id: number; title: string | null; event_date: string | null; summary: string | null }>(
    `SELECT e.id AS event_id, e.title, e.event_date, es.summary_text AS summary
       FROM events e
       LEFT JOIN event_summaries es ON es.event_id = e.id
      WHERE e.kind = ?1 AND ${PUBLIC} AND e.curated IS NOT 'rejected'
        AND e.id NOT IN (SELECT value FROM json_each(?2))
        AND (?3 IS NULL OR e.figure_id = ?3)
        AND CASE WHEN ?5 <> '' THEN e.title LIKE '%' || ?5 || '%' ESCAPE '\\'
                 ELSE e.event_date IS NOT NULL AND ?4 IS NOT NULL
                      AND abs(julianday(e.event_date) - julianday(?4)) <= ${FOLLOWUP_WINDOW_DAYS}
            END
      ORDER BY e.event_date DESC NULLS LAST
      LIMIT ${q ? 20 : 1500}`,
    [item.kind, exclude, item.kind === "record" ? item.figure_id : null, item.event_date, q.replace(/[%_\\]/g, "\\$&")]
  );
  // A record's own figure is in every one of their records; it says nothing.
  const own = new Set(
    item.owner ? [...words(item.owner.name), ...item.owner.aliases.flatMap((a) => [...words(a)])] : []
  );
  const mine = new Set([...words(`${item.title ?? ""} ${item.summary ?? ""}`)].filter((w) => !own.has(w)));
  const myTitle = words(item.title);
  const docs = rows.map((r) => ({ r, w: words(`${r.title ?? ""} ${r.summary ?? ""}`), t: words(r.title) }));
  const df = new Map<string, number>();
  for (const { w } of docs) for (const t of w) if (mine.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  // Shared by more than one candidate in ten, a word is the beat, not the story.
  const common = Math.max(3, docs.length / 10);
  const at = item.event_date ?? "";
  const scored = docs.map(({ r, w, t }) => {
    const shared = [...w]
      .filter((x) => mine.has(x) && (df.get(x) ?? 0) <= common)
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
    // What a headline says is the story; a word in a title on either side counts triple.
    const inTitle = shared.filter((x) => myTitle.has(x) || t.has(x));
    const score = shared.reduce((n, x) => n + (inTitle.includes(x) ? 3 : 1) / (df.get(x) ?? 1), 0);
    return {
      score,
      cand: {
        event_id: r.event_id, title: r.title, event_date: r.event_date,
        before: (r.event_date ?? "") < at || ((r.event_date ?? "") === at && r.event_id < item.event_id),
        shared: shared.slice(0, 5),
      },
      inTitle: inTitle.length,
    };
  });
  if (q) return scored.map((x) => x.cand).slice(0, 10);
  return scored
    .filter((x) => x.cand.shared.length >= 2 && x.inTitle >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.cand);
}

/**
 * Chain two events as a confirmed follow-up, whichever way round they were
 * given: the earlier by date is the one followed up. Equal dates fall back to
 * the lower id, which is the one clustered first.
 */
export async function confirmFollowupBetween(a: number, b: number): Promise<void> {
  const rows = await query<{ id: number; event_date: string | null }>(
    `SELECT id, event_date FROM events WHERE id IN (?, ?)`,
    [a, b]
  );
  const ea = rows.find((r) => r.id === a);
  const eb = rows.find((r) => r.id === b);
  if (!ea || !eb) throw new Error("unknown event");
  const aFirst = (ea.event_date ?? "") < (eb.event_date ?? "")
    || ((ea.event_date ?? "") === (eb.event_date ?? "") && a < b);
  await setFollowupVerdict(aFirst ? a : b, aFirst ? b : a, "confirmed");
}

/**
 * Rule on a follow-up pair, or (`null`) withdraw the ruling, as for record
 * links. Both events must be the same kind, and a record's follow-up must be
 * the same figure's.
 */
export async function setFollowupVerdict(
  earlierId: number,
  laterId: number,
  verdict: LinkVerdict | null
): Promise<void> {
  if (earlierId === laterId) throw new Error("an event cannot follow itself");
  const rows = await query<{ id: number; kind: string; figure_id: string | null; event_date: string | null }>(
    `SELECT id, kind, figure_id, event_date FROM events WHERE id IN (?, ?)`,
    [earlierId, laterId]
  );
  const early = rows.find((r) => r.id === earlierId);
  const late = rows.find((r) => r.id === laterId);
  if (!early || !late) throw new Error("unknown event");
  if (early.kind !== late.kind) throw new Error("a follow-up joins two events of the same kind");
  if (early.kind === "record" && early.figure_id !== late.figure_id) {
    throw new Error("a record's follow-up must be the same figure's record");
  }
  await setPairVerdict("followup_links", "earlier_id", "later_id", earlierId, laterId, verdict);
}

/**
 * Correct a tracked figure, in the roster the pipeline attributes with.
 *
 * `positions` null leaves them as they are (a retirement says nothing about
 * offices); a list, even an empty one, replaces them. Editing offices or the
 * CV marks the figure `cv_curated`, so scripts/import_cv.py never overwrites
 * a human correction.
 */
export async function saveFigureEdit(
  figureId: string,
  name: string,
  role: string | null,
  aliases: string[],
  active: boolean,
  positions: Position[] | null = null,
  profile: Profile | null = null
): Promise<void> {
  const pos = positions === null ? null : JSON.stringify(positions);
  const cv = profile === null
    ? [null, null, null, null]
    : [profile.bio, JSON.stringify(profile.facts), JSON.stringify(profile.education), JSON.stringify(profile.sources)];
  const changed = await lrun(
    `UPDATE figures SET name = ?2, role = ?3, aliases = ?4, active = ?5,
            positions = COALESCE(?6, positions), bio = COALESCE(?7, bio),
            facts = COALESCE(?8, facts), education = COALESCE(?9, education),
            sources = COALESCE(?10, sources),
            cv_curated = CASE WHEN ?6 IS NOT NULL OR ?7 IS NOT NULL THEN 1 ELSE cv_curated END
      WHERE id = ?1`,
    [figureId, name, role ?? "", JSON.stringify(aliases), active, pos, ...cv]
  );
  if (changed === 0) throw new Error(`unknown figure: ${figureId}`);
}

/** Every active figure, for the merge target picker. */
export type FigureOption = {
  id: string;
  name: string;
  role: string | null;
  aliases: string[];
  /** Records the figure owns, so a suggested merge can say which way round. */
  records: number;
};

export async function getFigureOptions(): Promise<FigureOption[]> {
  const rows = await query<{ id: string; name: string; role: string | null; aliases: string | null; records: number }>(
    `SELECT f.id, f.name, f.role, f.aliases,
            (SELECT count(*) FROM events e WHERE e.figure_id = f.id AND e.kind = 'record') AS records
       FROM figures f WHERE f.active ORDER BY f.name`
  );
  return rows.map((r) => ({ ...r, aliases: parseAliases(r.aliases) }));
}

/** A tracked figure that may be the same person as someone on the page. */
export interface DuplicateHint {
  figure: FigureOption;
  /** Why it was suggested, in the curator's words. */
  why: string;
}

// Given names shared by too many people to suggest anything on their own.
const COMMON_NAMES = new Set(`muhammad mohammad mohamad muhamad moh mochamad ahmad achmad abdul
abdullah siti nur nurul sri budi agus dwi tri eko putra putri wahyu adi andi arif rahmat
hendra dedi joko bambang yusuf ali hasan ibrahim ismail umar anwar rizki rizky fajar`.split(/\s+/));

// Words that come before a name without being part of it.
const LEADING = new Set(["pak", "bapak", "bu", "ibu", "h", "hj", "dr", "drs", "ir", "kh", "prof", "haji"]);

function nameTokens(name: string): string[] {
  const words = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEADING.has(words[0])) words.shift();
  return words;
}

function contains(long: string[], short: string[]): boolean {
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((w, j) => long[i + j] === w)) return true;
  }
  return false;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Every word of `short` in `long`, in order, gaps allowed. */
function inOrder(long: string[], short: string[]): boolean {
  let i = 0;
  for (const w of long) if (w === short[i]) i++;
  return i === short.length;
}

/**
 * How alike two spellings are, 0 when not worth suggesting. A shared surname
 * alone is not enough — Santoso, Hidayat or Nugroho are half the country —
 * and a one-word name only counts when it is someone's actual name, not one
 * of their aliases ("Prabowo" is in a stray alias of Pramono's).
 */
function likeness(a: string, b: string, singleOk: boolean): [number, string] {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return [0, ""];
  const ja = ta.join(" ");
  const jb = tb.join(" ");
  if (ja === jb) return [100, `nama sama: “${b}”`];
  const [long, short] = ta.length >= tb.length ? [ta, tb] : [tb, ta];
  const single = short.length === 1;
  if (single && !(singleOk && short[0].length >= 5 && !COMMON_NAMES.has(short[0]))) {
    return ja.length >= 8 && editDistance(ja, jb) <= 2 ? [70, `ejaan mirip: “${a}” / “${b}”`] : [0, ""];
  }
  if (contains(long, short)) return [80, `“${a}” dan “${b}”: yang satu memuat yang lain`];
  if (!single && inOrder(long, short)) return [75, `“${a}” dan “${b}”: nama yang sama, lebih lengkap`];
  if (ja.length >= 8 && editDistance(ja, jb) <= 2) return [70, `ejaan mirip: “${a}” / “${b}”`];
  return [0, ""];
}

/** Aliases that join two people ("Prabowo Subianto-Gibran Rakabuming") match
 *  both; they are left out of the comparison. */
function usable(term: string): boolean {
  return !/\S\s*[-–\/&]\s*\S/.test(term) || term.trim().split(/\s+/).length <= 2;
}

/**
 * Tracked figures that may be the same person as `person`, best first — so
 * the curator is shown a merge rather than having to remember the roster.
 * Compared on every spelling either side answers to (name and aliases).
 */
export function likelyDuplicates(
  person: { id: string; name: string; aliases: string[] },
  figures: FigureOption[],
  limit = 3
): DuplicateHint[] {
  const mine = [person.name, ...person.aliases].filter(usable);
  const hits: { score: number; hint: DuplicateHint }[] = [];
  for (const f of figures) {
    if (f.id === person.id) continue;
    let best: [number, string] = [0, ""];
    for (const a of mine) {
      for (const b of [f.name, ...f.aliases].filter(usable)) {
        const l = likeness(a, b, a === person.name || b === f.name);
        if (l[0] > best[0]) best = l;
      }
    }
    if (best[0] > 0) hits.push({ score: best[0] + Math.min(f.records, 50) / 100, hint: { figure: f, why: best[1] } });
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, limit).map((h) => h.hint);
}

/**
 * Fold a duplicate figure into the one it duplicates: its records move, its
 * names join the other's aliases, and it is retired. Carried out by the
 * pipeline's own jejak.roster.merge_figure (scripts/kurasi_ops.py).
 */
export async function mergeFigure(fromId: string, intoId: string): Promise<void> {
  await pipelineOp("merge", fromId, intoId);
}

/**
 * A tracked "figure" that is no one — a place, an office, a headline fragment.
 * Retired and taken off every peristiwa; its records come down
 * (scripts/kurasi_ops.py not-a-person).
 */
export async function removeNotAPerson(figureId: string): Promise<void> {
  await pipelineOp("not-a-person", figureId);
}

/**
 * Strike a related figure from a peristiwa, or (`struck = false`) restore it.
 * A strike is remembered in event_figure_rejections, so promote_peristiwa
 * never adds the figure back.
 */
export async function setRelatedFigure(
  eventId: number,
  figureId: string,
  struck: boolean
): Promise<void> {
  await ltx(async () => {
    if (struck) {
      await lrun(
        `INSERT OR IGNORE INTO event_figure_rejections (event_id, figure_id, decided_at)
         VALUES (?, ?, ?)`,
        [eventId, figureId, new Date().toISOString()]
      );
      await lrun(`DELETE FROM event_figures WHERE event_id = ? AND figure_id = ?`, [eventId, figureId]);
    } else {
      await lrun(`DELETE FROM event_figure_rejections WHERE event_id = ? AND figure_id = ?`, [eventId, figureId]);
      await lrun(`INSERT OR IGNORE INTO event_figures (event_id, figure_id) VALUES (?, ?)`, [eventId, figureId]);
    }
  });
}

// ---------------------------------------------------------------------------
// What the pipeline learns from the curator (jejak/kurasi.py)

export interface KurasiReport {
  run_at: string;
  drafted: { reworks: number; cv: number; failed: number };
  learned: { summary: number; cv: number; marked: number };
  name_prefixes: string[];
  names_queue: number;
  lessons_active: number;
  labels: number;
}

/** The last run of the nightly `kurasi` stage. */
export async function getLatestReport(): Promise<KurasiReport | null> {
  const row = await queryOne<{ run_at: string; stats: string }>(
    `SELECT run_at, stats FROM kurasi_reports ORDER BY id DESC LIMIT 1`
  );
  if (!row) return null;
  try {
    return { run_at: row.run_at, ...(JSON.parse(row.stats) as Omit<KurasiReport, "run_at">) };
  } catch {
    return null;
  }
}

export interface Lesson {
  id: number;
  kind: "summary" | "cv";
  event_id: number | null;
  figure_id: string | null;
  wrong: string | null;
  note: string | null;
  right: string | null;
  active: boolean;
  created_at: string;
}

export async function getLessons(): Promise<Lesson[]> {
  const rows = await query<Omit<Lesson, "active"> & { active: number }>(
    `SELECT id, kind, event_id, figure_id, wrong, note, right, active, created_at
       FROM curation_lessons ORDER BY id DESC LIMIT 200`
  );
  return rows.map((r) => ({ ...r, active: Boolean(r.active) }));
}

/** A lesson switched off is never shown to the model again. */
export async function setLessonActive(id: number, active: boolean): Promise<void> {
  await lrun(`UPDATE curation_lessons SET active = ? WHERE id = ?`, [active, id]);
}
