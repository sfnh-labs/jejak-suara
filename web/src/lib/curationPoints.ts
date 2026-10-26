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
  /** Where the answer holds, for its speaker lesson: "" everywhere, a figure id, or "e<id>". */
  scope?: string;
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
  /** Left open by auto-answering for the curator to check it. */
  spot_check: boolean;
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
        ? `${groupSize} kutipan “${p.speaker}” menjadi milik ${p.name}, begitu juga “${p.speaker}” berikutnya${p.scope ? " di catatan sejenis" : ""}.`
        : `${groupSize} kutipan “${p.speaker}” ditandai bukan tokoh yang dilacak, dan tidak ditanyakan lagi.`;
  }
}

type Row = Omit<Point, "proposal" | "effect" | "confidence" | "correction" | "spot_check"> & {
  proposal: string;
  answer: string | null;
  spot_check: number;
};

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
    spot_check: Boolean(r.spot_check),
    proposal,
    correction,
    effect: effectOf(r.kind, proposal, r.group_size),
    confidence: cal.get(`${r.kind}|${r.bucket ?? ""}`) ?? confidenceOf(0, 0),
  };
}

const POINT_SELECT = `SELECT p.id, p.kind, p.event_id, p.group_size, p.proposal, p.article_id,
            a.source, a.published_at, p.paragraph, p.hl_start, p.hl_end, p.score, p.bucket,
            p.status, p.answer, p.answered_by, p.answered_at, p.spot_check
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
  /** Points auto-answering has answered, ever. */
  answeredAuto: number;
  /** When the pipeline last switched it off itself, and on what checks. */
  switchedOff: { at: string; agreed: number; checked: number } | null;
}

/** Per kind: what is waiting, how often the curator agreed, and whether auto is on. */
export async function getKindStats(): Promise<KindStats[] | null> {
  if (!(await pointsReady())) return null;
  const [open, autoDone, cal, auto, off] = await Promise.all([
    query<{ kind: PointKind; n: number }>(
      `SELECT kind, count(*) AS n FROM curation_points WHERE status IN ('open', 'lewati') GROUP BY kind`
    ),
    query<{ kind: PointKind; n: number }>(
      `SELECT kind, count(*) AS n FROM curation_points WHERE status IN ('auto', 'auto_wrong') GROUP BY kind`
    ),
    calibration(),
    getAutoKinds(),
    readState<Record<string, { at: string; agreed: number; checked: number }>>(AUTO_OFF_KEY),
  ]);
  const openBy = new Map(open.map((r) => [r.kind, Number(r.n)]));
  const autoBy = new Map(autoDone.map((r) => [r.kind, Number(r.n)]));
  return (Object.keys(KIND_LABEL) as PointKind[]).map((kind) => {
    const buckets = [...cal]
      .filter(([k]) => k.startsWith(`${kind}|`))
      .map(([k, c]) => ({ bucket: k.slice(kind.length + 1), confidence: c, eligible: autoEligible(c) }))
      .sort((a, b) => b.confidence.answered - a.confidence.answered);
    const agreed = buckets.reduce((n, b) => n + b.confidence.agreed, 0);
    const answered = buckets.reduce((n, b) => n + b.confidence.answered, 0);
    return {
      kind, open: openBy.get(kind) ?? 0, overall: confidenceOf(agreed, answered), buckets, auto: auto.has(kind),
      answeredAuto: autoBy.get(kind) ?? 0, switchedOff: auto.has(kind) ? null : off[kind] ?? null,
    };
  });
}

/** {kind: when it was switched on}; the pipeline reads it (jejak/curation_points.py). */
const AUTO_KEY = "curation_auto";
/** {kind: {at, agreed, checked}}: kinds the pipeline switched off itself. */
const AUTO_OFF_KEY = "curation_auto_off";

async function readState<T extends object>(key: string): Promise<Partial<T>> {
  const row = await queryOne<{ value: string }>(`SELECT value FROM pipeline_state WHERE key = ?`, [key]);
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === "object" ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

async function writeState(key: string, value: object): Promise<void> {
  await lrun(
    `INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), new Date().toISOString()]
  );
}

async function getAutoKinds(): Promise<Set<PointKind>> {
  const on = await readState<Record<string, string | boolean>>(AUTO_KEY);
  return new Set((Object.keys(on) as PointKind[]).filter((k) => on[k] && k in KIND_LABEL));
}

/**
 * Switch auto-answering for a kind on or off. The pipeline only acts on the
 * bands that have cleared the gate, and re-checks it every run; the time it
 * was switched on is where its spot checks start counting from, so checks
 * that switched it off before do not switch it straight off again.
 */
export async function setAutoKind(kind: PointKind, on: boolean): Promise<void> {
  await ltx(async () => {
    const kinds = await readState<Record<string, string | boolean>>(AUTO_KEY);
    if (on) kinds[kind] = new Date().toISOString();
    else delete kinds[kind];
    await writeState(AUTO_KEY, kinds);
    if (on) {
      const off = await readState<Record<string, unknown>>(AUTO_OFF_KEY);
      if (kind in off) {
        delete off[kind];
        await writeState(AUTO_OFF_KEY, off);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Answering

/** What an answer changed, so it can be put back. */
type Undo =
  | { kind: "pair"; table: "record_links" | "followup_links"; pairs: { a: number; b: number; prev: LinkVerdict | null }[] }
  | { kind: "pelaku"; prev: { role: string; source: string; quotes: number; assigned_by: string } | null; review: string | null }
  | {
      kind: "quotes";
      ids: number[];
      prev: { figure_id: string | null; assigned_by: string | null }[];
      /** Records whose shown quote went with the answer, and what they showed. */
      shown?: { event_id: number; quote: string | null; url: string | null }[];
      /** The speaker lesson the answer taught, and the one it replaced. */
      lesson?: { speaker: string; scope: string; prev: Lesson | null } | null;
    }
  | { kind: "none" };

interface Lesson {
  figure_id: string | null;
  point_id: number | null;
  taught_by: string;
  created_at: string;
}

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
    if (answer !== "lewati") undo = await apply(p.kind, p.event_id, prop, answer, correction, pointId);
    await lrun(
      `UPDATE curation_points SET status = ?, answer = ?, answered_by = 'curator', answered_at = ? WHERE id = ?`,
      [answer, JSON.stringify({ label, undo }), new Date().toISOString(), pointId]
    );
  });
  return p.event_id;
}

async function apply(
  kind: PointKind,
  eventId: number,
  prop: Proposal,
  answer: Exclude<PointAnswer, "lewati">,
  correction: string | null,
  pointId: number
): Promise<Undo> {
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
      WHERE id IN (SELECT value FROM json_each(?)) AND figure_id IS NULL AND coalesce(assigned_by, 'auto') = 'auto'`,
    [ids]
  );
  const target = answer === "koreksi" ? correction : answer === "ya" ? prop.figure_id ?? null : undefined;
  // "Bukan" to a figure leaves the quotes waiting; "Bukan" to "not tracked" is
  // a "this is someone", which only a correction can say.
  if (target === undefined) return { kind: "none" };
  const moved = waiting.map((q) => q.id);
  await lrun(
    `UPDATE event_quotes SET figure_id = ?, assigned_by = 'curator'
      WHERE id IN (SELECT value FROM json_each(?))`,
    [target, moved]
  );
  return {
    kind: "quotes",
    ids: moved,
    prev: waiting.map((q) => ({ figure_id: q.figure_id, assigned_by: q.assigned_by })),
    shown: await replaceShownQuotes(moved, target),
    // Even with nothing left waiting: the next "Kabareskrim" is assigned from it.
    lesson: await teachSpeaker(prop, target, pointId),
  };
}

/**
 * A record showing one of these quotes, now someone else's words, shows its
 * owner's longest other quote instead, or none — as assignQuote does. Kept in
 * step with replace_shown_quotes in jejak/curation_points.py.
 */
async function replaceShownQuotes(quoteIds: number[], target: string | null): Promise<NonNullable<Extract<Undo, { kind: "quotes" }>["shown"]>> {
  if (!quoteIds.length) return [];
  const shown = await query<{ id: number; quote: string | null; quote_url: string | null; figure_id: string | null }>(
    `SELECT DISTINCT e.id, e.quote, e.quote_url, e.figure_id
       FROM events e JOIN event_quotes q ON q.event_id = e.id AND q.quote = e.quote
      WHERE q.id IN (SELECT value FROM json_each(?))`,
    [quoteIds]
  );
  const prev = [];
  for (const r of shown) {
    if (r.figure_id === target) continue;
    const next = await queryOne<{ quote: string; url: string | null }>(
      `SELECT quote, url FROM event_quotes WHERE event_id = ? AND figure_id = ? AND quote <> ?
        ORDER BY length(quote) DESC LIMIT 1`,
      [r.id, r.figure_id, r.quote]
    );
    await lrun(`UPDATE events SET quote = ?, quote_url = ? WHERE id = ?`, [next?.quote ?? "", next?.url ?? null, r.id]);
    prev.push({ event_id: r.id, quote: r.quote, url: r.quote_url });
  }
  return prev;
}

/** "Kabareskrim" in a speaker lessons' key, as jejak/quotes.py norm_speaker writes it. */
function normSpeaker(speaker: string): string {
  return speaker.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Keep a pembicara answer as a speaker lesson, so the quotes stage assigns the
 * next quote written that way itself — where the point's grouping says the
 * answer holds (`scope`). A point from before scopes were kept teaches nothing.
 */
async function teachSpeaker(prop: Proposal, figureId: string | null, pointId: number) {
  if (prop.scope === undefined || !prop.speaker || !(await tableExists("speaker_lessons"))) return null;
  const speaker = normSpeaker(prop.speaker);
  const prev = await queryOne<Lesson>(
    `SELECT figure_id, point_id, taught_by, created_at FROM speaker_lessons WHERE speaker = ? AND scope = ?`,
    [speaker, prop.scope]
  );
  await lrun(
    `INSERT INTO speaker_lessons (speaker, scope, figure_id, point_id, taught_by, created_at)
     VALUES (?, ?, ?, ?, 'curator', ?)
     ON CONFLICT (speaker, scope) DO UPDATE SET figure_id = excluded.figure_id, point_id = excluded.point_id,
       taught_by = excluded.taught_by, created_at = excluded.created_at`,
    [speaker, prop.scope, figureId, pointId, new Date().toISOString()]
  );
  return { speaker, scope: prop.scope, prev: prev ?? null };
}

/** Put back what an answer changed, from what it recorded. */
async function revert(eventId: number, prop: Proposal, undo: Undo): Promise<void> {
  if (undo.kind === "pair") {
    for (const x of undo.pairs) await setPair(undo.table, x.a, x.b, x.prev);
  } else if (undo.kind === "pelaku") {
    const fig = prop.figure_id!;
    if (undo.prev) {
      await lrun(`UPDATE record_figures SET role = ?, source = ?, quotes = ?, assigned_by = ? WHERE event_id = ? AND figure_id = ?`,
                 [undo.prev.role, undo.prev.source, undo.prev.quotes, undo.prev.assigned_by, eventId, fig]);
    } else {
      await lrun(`DELETE FROM record_figures WHERE event_id = ? AND figure_id = ?`, [eventId, fig]);
    }
    await lrun(`UPDATE actor_reviews SET decision = ?, decided_at = NULL WHERE event_id = ? AND suggested_id = ?`,
               [undo.review, eventId, fig]);
  } else if (undo.kind === "quotes") {
    for (let i = 0; i < undo.ids.length; i++) {
      await lrun(`UPDATE event_quotes SET figure_id = ?, assigned_by = ? WHERE id = ?`,
                 [undo.prev[i].figure_id, undo.prev[i].assigned_by, undo.ids[i]]);
    }
    for (const s of undo.shown ?? []) {
      await lrun(`UPDATE events SET quote = ?, quote_url = ? WHERE id = ?`, [s.quote, s.url, s.event_id]);
    }
    if (undo.lesson) {
      const l = undo.lesson;
      if (l.prev) {
        await lrun(`UPDATE speaker_lessons SET figure_id = ?, point_id = ?, taught_by = ?, created_at = ? WHERE speaker = ? AND scope = ?`,
                   [l.prev.figure_id, l.prev.point_id, l.prev.taught_by, l.prev.created_at, l.speaker, l.scope]);
      } else {
        await lrun(`DELETE FROM speaker_lessons WHERE speaker = ? AND scope = ?`, [l.speaker, l.scope]);
      }
    }
  }
}

function readUndo(answer: string | null): Undo {
  return (answer ? (JSON.parse(answer) as { undo?: Undo }).undo : null) ?? { kind: "none" };
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
  await ltx(async () => {
    await revert(p.event_id, JSON.parse(p.proposal) as Proposal, readUndo(p.answer));
    await lrun(`UPDATE curation_points SET status = 'open', answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?`, [pointId]);
  });
  return p.event_id;
}

/**
 * "Salah" on an auto answer: put back what it changed and rule the other way —
 * the link or follow-up rejected, the figure kept out of Pelaku, the quotes
 * waiting again with the lesson unlearnt. It counts against the kind's
 * confidence, and against its spot checks, which switches auto off.
 */
export async function salahPoint(pointId: number): Promise<number> {
  const p = await queryOne<{ event_id: number; kind: PointKind; status: string; answer: string | null; proposal: string }>(
    `SELECT event_id, kind, status, answer, proposal FROM curation_points WHERE id = ?`, [pointId]
  );
  if (!p) throw new Error(`unknown point: ${pointId}`);
  if (p.status !== "auto") throw new Error("only an auto answer is marked wrong");
  const prop = JSON.parse(p.proposal) as Proposal;
  const undo = readUndo(p.answer);
  await ltx(async () => {
    await revert(p.event_id, prop, undo);
    if (undo.kind === "pair") {
      for (const x of undo.pairs) await setPair(undo.table, x.a, x.b, "rejected");
    } else if (undo.kind === "pelaku") {
      await lrun(`UPDATE actor_reviews SET decision = 'keep', decided_at = ? WHERE event_id = ? AND suggested_id = ?`,
                 [new Date().toISOString(), p.event_id, prop.figure_id]);
    }
    await lrun(`UPDATE curation_points SET status = 'auto_wrong', answered_by = 'curator', answered_at = ? WHERE id = ?`,
               [new Date().toISOString(), pointId]);
  });
  return p.event_id;
}
