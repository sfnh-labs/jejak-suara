import { lquery as query, lqueryOne as queryOne, lrun, ltx, tableExists } from "./localDb";
import { setFollowupVerdict, setLinkVerdict, type LinkVerdict } from "./curation";

/**
 * Curation points: the pipeline's open questions about a catatan, asked one
 * at a time (jejak/curation_points.py writes them).
 *
 * Each point is a view onto a row that already holds the answer —
 * record_links, followup_links, actor_reviews, event_quotes — so answering
 * writes there, through the same writers the rest of /kurasi uses, and the
 * point keeps what it changed so "Batalkan" can put it back. The answers on
 * the points are what confidence per kind is measured on.
 *
 * The table is the pipeline's; on a jejak.db the `points` stage has not run
 * on yet it does not exist, and everything here reads as "no points".
 */

export type PointKind = "peristiwa" | "lini" | "pelaku" | "pembicara";
export type PointAnswer = "ya" | "bukan" | "koreksi" | "lewati";
export type PointStatus = PointAnswer | "open" | "auto" | "auto_wrong" | "settled";

export const KIND_LABEL: Record<PointKind, string> = {
  peristiwa: "Catatan → peristiwa",
  lini: "Lini cerita",
  pelaku: "Pelaku atau disebut",
  pembicara: "Pembicara kutipan",
};

/** The auto-answer gate, as for auto-hide (jejak/curation_points.py). */
export const AUTO_MIN_ANSWERS = 25;
export const AUTO_MIN_AGREEMENT = 0.95;
const PRIOR = 1;

export function isPointAnswer(value: unknown): value is PointAnswer {
  return value === "ya" || value === "bukan" || value === "koreksi" || value === "lewati";
}

interface Proposal {
  claim: string;
  // peristiwa
  peristiwa_id?: number;
  // lini
  earlier_id?: number;
  later_id?: number;
  title?: string;
  // pelaku, pembicara
  figure_id?: string | null;
  name?: string | null;
  owner_id?: string;
  quotes?: number;
  // pembicara
  speaker?: string;
  candidates?: { id: string; name: string }[];
  quote_ids?: number[];
  events?: number;
}

export interface Point {
  id: number;
  kind: PointKind;
  event_id: number;
  group_size: number;
  proposal: Proposal;
  article_id: string | null;
  /** Outlet and date of the evidence article. */
  source: string | null;
  published_at: string | null;
  paragraph: string | null;
  hl_start: number | null;
  hl_end: number | null;
  score: number | null;
  bucket: string | null;
  status: PointStatus;
  answered_by: string | null;
  answered_at: string | null;
  correction: string | null;
  /** What a "Ya" would change, in a sentence. */
  effect: string;
  confidence: Confidence;
}

export interface Confidence {
  agreed: number;
  answered: number;
  /** Smoothed agreement, 0..1; null before any answer for this kind and band. */
  value: number | null;
}

export function confidenceOf(agreed: number, answered: number): Confidence {
  return { agreed, answered, value: answered ? agreed / (answered + PRIOR) : null };
}

export function autoEligible(c: Confidence): boolean {
  return c.answered >= AUTO_MIN_ANSWERS && c.value !== null && c.value >= AUTO_MIN_AGREEMENT;
}

export function pointsReady(): Promise<boolean> {
  return tableExists("curation_points");
}

/** {kind: {bucket: Confidence}} over the curator's own answers (auto ones agree with themselves). */
async function calibration(): Promise<Map<string, Confidence>> {
  const rows = await query<{ kind: string; bucket: string | null; status: string; n: number }>(
    `SELECT kind, bucket, status, count(*) AS n FROM curation_points
      WHERE status IN ('ya', 'bukan', 'koreksi', 'auto_wrong')
      GROUP BY kind, bucket, status`
  );
  const cells = new Map<string, [number, number]>();
  for (const r of rows) {
    const key = `${r.kind}|${r.bucket ?? ""}`;
    const c = cells.get(key) ?? [0, 0];
    c[1] += Number(r.n);
    if (r.status === "ya") c[0] += Number(r.n);
    cells.set(key, c);
  }
  return new Map([...cells].map(([k, [a, n]]) => [k, confidenceOf(a, n)]));
}

function effectOf(kind: PointKind, p: Proposal, groupSize: number): string {
  switch (kind) {
    case "peristiwa":
      return `tautan ke “${p.title}” dikonfirmasi dan tampil di situs.`;
    case "lini":
      return `catatan ini tersambung sebagai kelanjutan “${p.title}” dalam lini cerita.`;
    case "pelaku":
      return `${p.name} masuk Pelaku catatan ini, di samping yang sudah ada.`;
    case "pembicara":
      return p.figure_id
        ? `${groupSize} kutipan “${p.speaker}” menjadi milik ${p.name}.`
        : `${groupSize} kutipan “${p.speaker}” ditandai bukan tokoh yang dilacak, dan tidak ditanyakan lagi.`;
  }
}

type Row = Omit<Point, "proposal" | "effect" | "confidence" | "correction"> & { proposal: string; answer: string | null };

function toPoint(r: Row, cal: Map<string, Confidence>): Point {
  const proposal = JSON.parse(r.proposal) as Proposal;
  let correction: string | null = null;
  try {
    correction = r.answer ? (JSON.parse(r.answer) as { label?: string }).label ?? null : null;
  } catch {
    // an unreadable answer only costs the correction's label
  }
  const { answer: _answer, ...rest } = r;
  void _answer;
  return {
    ...rest,
    proposal,
    correction,
    effect: effectOf(r.kind, proposal, r.group_size),
    confidence: cal.get(`${r.kind}|${r.bucket ?? ""}`) ?? confidenceOf(0, 0),
  };
}

const POINT_SELECT = `SELECT p.id, p.kind, p.event_id, p.group_size, p.proposal, p.article_id,
            a.source, a.published_at, p.paragraph, p.hl_start, p.hl_end, p.score, p.bucket,
            p.status, p.answer, p.answered_by, p.answered_at
       FROM curation_points p
       LEFT JOIN articles a ON a.id = p.article_id`;

/**
 * A catatan's points: open first (the ones settling most first), then
 * skipped, then answered, latest first. Settled ones — decided elsewhere —
 * are left out.
 */
export async function getPoints(eventId: number): Promise<Point[]> {
  if (!(await pointsReady())) return [];
  const [rows, cal] = await Promise.all([
    query<Row>(
      `${POINT_SELECT}
        WHERE p.event_id = ? AND p.status <> 'settled'
        ORDER BY CASE p.status WHEN 'open' THEN 0 WHEN 'lewati' THEN 1 ELSE 2 END,
                 CASE WHEN p.status IN ('open', 'lewati') THEN -p.group_size END,
                 p.answered_at DESC, p.id`,
      [eventId]
    ),
    calibration(),
  ]);
  return rows.map((r) => toPoint(r, cal));
}

/** Unanswered points per catatan (skipped ones not counted), for the queue. */
export async function getOpenPointCounts(eventIds: number[]): Promise<Map<number, number>> {
  if (!eventIds.length || !(await pointsReady())) return new Map();
  const rows = await query<{ event_id: number; n: number }>(
    `SELECT event_id, count(*) AS n FROM curation_points
      WHERE status = 'open' AND event_id IN (SELECT value FROM json_each(?))
      GROUP BY event_id`,
    [eventIds]
  );
  return new Map(rows.map((r) => [r.event_id, Number(r.n)]));
}

export interface KindStats {
  kind: PointKind;
  open: number;
  overall: Confidence;
  buckets: { bucket: string; confidence: Confidence; eligible: boolean }[];
  auto: boolean;
}

/** Per kind: what is waiting, how often the curator agreed, and whether auto is on. */
export async function getKindStats(): Promise<KindStats[] | null> {
  if (!(await pointsReady())) return null;
  const [open, cal, auto] = await Promise.all([
    query<{ kind: PointKind; n: number }>(
      `SELECT kind, count(*) AS n FROM curation_points WHERE status IN ('open', 'lewati') GROUP BY kind`
    ),
    calibration(),
    getAutoKinds(),
  ]);
  const openBy = new Map(open.map((r) => [r.kind, Number(r.n)]));
  return (Object.keys(KIND_LABEL) as PointKind[]).map((kind) => {
    const buckets = [...cal]
      .filter(([k]) => k.startsWith(`${kind}|`))
      .map(([k, c]) => ({ bucket: k.slice(kind.length + 1), confidence: c, eligible: autoEligible(c) }))
      .sort((a, b) => b.confidence.answered - a.confidence.answered);
    const agreed = buckets.reduce((n, b) => n + b.confidence.agreed, 0);
    const answered = buckets.reduce((n, b) => n + b.confidence.answered, 0);
    return { kind, open: openBy.get(kind) ?? 0, overall: confidenceOf(agreed, answered), buckets, auto: auto.has(kind) };
  });
}

const AUTO_KEY = "curation_auto";

async function getAutoKinds(): Promise<Set<PointKind>> {
  const row = await queryOne<{ value: string }>(`SELECT value FROM pipeline_state WHERE key = ?`, [AUTO_KEY]);
  try {
    const parsed = row ? (JSON.parse(row.value) as Record<string, boolean>) : {};
    return new Set((Object.keys(parsed) as PointKind[]).filter((k) => parsed[k] && k in KIND_LABEL));
  } catch {
    return new Set();
  }
}

/**
 * Switch auto-answering for a kind on or off. The pipeline only acts on the
 * bands that have cleared the gate, and re-checks it every run.
 */
export async function setAutoKind(kind: PointKind, on: boolean): Promise<void> {
  const kinds = await getAutoKinds();
  if (on) kinds.add(kind);
  else kinds.delete(kind);
  const value = JSON.stringify(Object.fromEntries([...kinds].map((k) => [k, true])));
  await lrun(
    `INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [AUTO_KEY, value, new Date().toISOString()]
  );
}

// ---------------------------------------------------------------------------
// Answering

/** What an answer changed, so it can be put back. */
type Undo =
  | { kind: "pair"; table: "record_links" | "followup_links"; pairs: { a: number; b: number; prev: LinkVerdict | null }[] }
  | { kind: "pelaku"; prev: { role: string; source: string; quotes: number; assigned_by: string } | null; review: string | null }
  | { kind: "quotes"; ids: number[]; prev: { figure_id: string | null; assigned_by: string | null }[] }
  | { kind: "none" };

async function pairVerdict(table: "record_links" | "followup_links", a: number, b: number): Promise<LinkVerdict | null> {
  const [ca, cb] = table === "record_links" ? ["record_id", "peristiwa_id"] : ["earlier_id", "later_id"];
  const row = await queryOne<{ verdict: LinkVerdict | null }>(`SELECT verdict FROM ${table} WHERE ${ca} = ? AND ${cb} = ?`, [a, b]);
  return row?.verdict ?? null;
}

async function setPair(table: "record_links" | "followup_links", a: number, b: number, v: LinkVerdict | null) {
  if (table === "record_links") await setLinkVerdict(a, b, v);
  else await setFollowupVerdict(a, b, v);
}

/**
 * Answer a point. `correction` is a figure id, for "koreksi" on pembicara —
 * the only kind corrected here; peristiwa and lini are corrected in their own
 * sections of the page, after a "Bukan".
 */
export async function answerPoint(pointId: number, answer: PointAnswer, correction: string | null): Promise<number> {
  const p = await queryOne<{ id: number; kind: PointKind; event_id: number; status: string; proposal: string }>(
    `SELECT id, kind, event_id, status, proposal FROM curation_points WHERE id = ?`, [pointId]
  );
  if (!p) throw new Error(`unknown point: ${pointId}`);
  if (p.status !== "open" && p.status !== "lewati") throw new Error("point already answered");
  const prop = JSON.parse(p.proposal) as Proposal;
  if (answer === "koreksi" && p.kind !== "pembicara") throw new Error("only a speaker is corrected here");
  let label: string | null = null;
  if (answer === "koreksi") {
    const fig = correction ? await queryOne<{ name: string }>(`SELECT name FROM figures WHERE id = ?`, [correction]) : null;
    if (!fig) throw new Error("choose a figure");
    label = fig.name;
  }

  await ltx(async () => {
    let undo: Undo = { kind: "none" };
    if (answer !== "lewati") undo = await apply(p.kind, p.event_id, prop, answer, correction);
    await lrun(
      `UPDATE curation_points SET status = ?, answer = ?, answered_by = 'curator', answered_at = ? WHERE id = ?`,
      [answer, JSON.stringify({ label, undo }), new Date().toISOString(), pointId]
    );
  });
  return p.event_id;
}

async function apply(kind: PointKind, eventId: number, prop: Proposal, answer: Exclude<PointAnswer, "lewati">, correction: string | null): Promise<Undo> {
  if (kind === "peristiwa" || kind === "lini") {
    const table = kind === "peristiwa" ? "record_links" : "followup_links";
    const [a, b] = kind === "peristiwa" ? [eventId, prop.peristiwa_id!] : [prop.earlier_id!, prop.later_id!];
    const prev = await pairVerdict(table, a, b);
    await setPair(table, a, b, answer === "ya" ? "confirmed" : "rejected");
    return { kind: "pair", table, pairs: [{ a, b, prev }] };
  }

  if (kind === "pelaku") {
    const fig = prop.figure_id!;
    const prev = await queryOne<{ role: string; source: string; quotes: number; assigned_by: string }>(
      `SELECT role, source, quotes, assigned_by FROM record_figures WHERE event_id = ? AND figure_id = ?`, [eventId, fig]
    );
    const review = await queryOne<{ decision: string | null }>(`SELECT decision FROM actor_reviews WHERE event_id = ?`, [eventId]);
    if (answer === "ya") {
      // The curator's row: participants.py rebuilds only the automatic ones.
      await lrun(
        `INSERT INTO record_figures (event_id, figure_id, role, source, quotes, assigned_by)
         VALUES (?, ?, 'actor', 'curator', ?, 'curator')
         ON CONFLICT (event_id, figure_id) DO UPDATE SET role = 'actor', source = 'curator', assigned_by = 'curator'`,
        [eventId, fig, prop.quotes ?? 0]
      );
    }
    // 'actor': a second actor beside the owner, not a change of owner.
    await lrun(`UPDATE actor_reviews SET decision = ?, decided_at = ? WHERE event_id = ? AND suggested_id = ?`,
               [answer === "ya" ? "actor" : "keep", new Date().toISOString(), eventId, fig]);
    return { kind: "pelaku", prev, review: review?.decision ?? null };
  }

  // pembicara: every quote of the group still waiting. A quote the curator
  // placed since the point was made keeps their say.
  const ids = prop.quote_ids ?? [];
  const waiting = await query<{ id: number; figure_id: string | null; assigned_by: string | null }>(
    `SELECT id, figure_id, assigned_by FROM event_quotes
      WHERE id IN (SELECT value FROM json_each(?)) AND figure_id IS NULL AND assigned_by IS NOT 'curator'`,
    [ids]
  );
  const target = answer === "koreksi" ? correction : answer === "ya" ? prop.figure_id ?? null : undefined;
  // "Bukan" to a figure leaves the quotes waiting; "Bukan" to "not tracked" is
  // a "this is someone", which only a correction can say.
  if (target !== undefined && waiting.length) {
    await lrun(
      `UPDATE event_quotes SET figure_id = ?, assigned_by = 'curator'
        WHERE id IN (SELECT value FROM json_each(?))`,
      [target, waiting.map((q) => q.id)]
    );
    return { kind: "quotes", ids: waiting.map((q) => q.id), prev: waiting.map((q) => ({ figure_id: q.figure_id, assigned_by: q.assigned_by })) };
  }
  return { kind: "none" };
}

/** Put a curator's answer back as it was, and ask the point again. */
export async function undoPoint(pointId: number): Promise<number> {
  const p = await queryOne<{ event_id: number; kind: PointKind; status: string; answer: string | null; answered_by: string | null; proposal: string }>(
    `SELECT event_id, kind, status, answer, answered_by, proposal FROM curation_points WHERE id = ?`, [pointId]
  );
  if (!p) throw new Error(`unknown point: ${pointId}`);
  if (p.answered_by !== "curator" || !["ya", "bukan", "koreksi", "lewati"].includes(p.status)) {
    throw new Error("only a curator's answer is undone here");
  }
  const undo = (p.answer ? (JSON.parse(p.answer) as { undo?: Undo }).undo : null) ?? { kind: "none" as const };
  const prop = JSON.parse(p.proposal) as Proposal;
  await ltx(async () => {
    if (undo.kind === "pair") {
      for (const x of undo.pairs) await setPair(undo.table, x.a, x.b, x.prev);
    } else if (undo.kind === "pelaku") {
      const fig = prop.figure_id!;
      if (undo.prev) {
        await lrun(`UPDATE record_figures SET role = ?, source = ?, quotes = ?, assigned_by = ? WHERE event_id = ? AND figure_id = ?`,
                   [undo.prev.role, undo.prev.source, undo.prev.quotes, undo.prev.assigned_by, p.event_id, fig]);
      } else {
        await lrun(`DELETE FROM record_figures WHERE event_id = ? AND figure_id = ?`, [p.event_id, fig]);
      }
      await lrun(`UPDATE actor_reviews SET decision = ?, decided_at = NULL WHERE event_id = ? AND suggested_id = ?`,
                 [undo.review, p.event_id, fig]);
    } else if (undo.kind === "quotes") {
      for (let i = 0; i < undo.ids.length; i++) {
        await lrun(`UPDATE event_quotes SET figure_id = ?, assigned_by = ? WHERE id = ?`,
                   [undo.prev[i].figure_id, undo.prev[i].assigned_by, undo.ids[i]]);
      }
    }
    await lrun(`UPDATE curation_points SET status = 'open', answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?`, [pointId]);
  });
  return p.event_id;
}
