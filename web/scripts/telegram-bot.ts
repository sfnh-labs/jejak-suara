/**
 * Curation points over Telegram: answer the one-tap ones from a phone.
 *
 * A long-polling bot on the curator's Mac, beside jejak.db. It keeps a few
 * open points in the chat as cards with buttons; a tap answers through
 * answerPoint / undoPoint, the writers /kurasi itself uses, so Batalkan, the
 * confidence per kind and auto-answering all count it the same. Corrections
 * that need a search (another peristiwa, another figure) stay in /kurasi:
 * "Lewati" leaves the point marked there.
 *
 * Nothing listens for connections: the bot asks Telegram for updates, so no
 * port or tunnel is opened. Only the chat in TELEGRAM_CHAT_ID is answered.
 *
 *   npm run telegram-bot      (from web/, with web/.env.local holding
 *                              JEJAK_DB, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { localDbPath, lquery, lqueryOne, lrun, pipelineOp } from "@/lib/localDb";
import { getCandidate, getCandidateCounts, getCandidates, setCandidateVerdict, type CandidateRow } from "@/lib/candidates";
import {
  acceptRework,
  assignQuote,
  discardRework,
  requestRework,
  type ReworkSnapshot,
  canonicalOrg,
  deleteOrganization,
  figureTitle,
  getFigureOptions,
  getFollowupCandidates,
  getItem,
  getOrgChoices,
  getOrganizations,
  getRelated,
  getUnlinkedOrgs,
  likelyDuplicates,
  mergeFigure,
  orgKey,
  positionTitle,
  REASONS,
  reasonLabel,
  removeNotAPerson,
  saveFigureEdit,
  saveOrganization,
  setRelated,
  type FigureOption,
  type Organization,
  type Position,
  type QuoteRow,
  type ReasonCode,
  type Related,
} from "@/lib/curation";
import { getFigureFull } from "@/lib/kurasiLists";
import {
  answerPoint,
  AUTO_MIN_AGREEMENT,
  AUTO_MIN_ANSWERS,
  getKindStats,
  getNextAutoAnswered,
  getUncheckedCount,
  salahPoint,
  setAutoKind,
  SPOT_CHECK_EVERY,
  type Confidence,
  countOpenPointsOn,
  getNextOpenPoint,
  getNextOpenPointOn,
  getPoint,
  rejectRecord,
  restoreRecord,
  undoPoint,
  KIND_LABEL,
  NOT_TRACKED,
  officeCorrection,
  type Point,
  type PointAnswer,
  type PointKind,
  type Takedown,
} from "@/lib/curationPoints";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT = process.env.TELEGRAM_CHAT_ID ?? "";
/** How many open cards the chat holds at once: one, the next after each answer. */
const BATCH = Math.max(1, Number(process.env.TELEGRAM_BATCH ?? 1) || 1);
/** Optional: where /kurasi is reachable from the phone, for an "open" link. */
const KURASI_URL = (process.env.KURASI_URL ?? "").replace(/\/$/, "");
/** Telegram's Bot API, or a stand-in for trying the bot out locally. */
const API = (process.env.TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, "");
const STATE_KEY = "telegram_bot";
const POLL_SECONDS = 50;

// SQLite makes an empty file where JEJAK_DB points if there is none, so a
// start from the wrong folder would answer into nothing: refuse instead.
const DB_FILE = localDbPath();
if (!DB_FILE || !existsSync(DB_FILE)) {
  console.error(`JEJAK_DB must name jejak.db (got ${DB_FILE ?? "nothing"}); run from web/ with web/.env.local.`);
  process.exit(1);
}

if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN in web/.env.local: the token @BotFather gave for the bot.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Telegram

type Button = { text: string; callback_data?: string; url?: string };
type Keyboard = Button[][];

interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

async function tg<T = unknown>(method: string, body: object, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

async function send(text: string, keyboard?: Keyboard, extra: object = {}): Promise<number> {
  const msg = await tg<{ message_id: number }>("sendMessage", {
    chat_id: CHAT, text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    ...extra,
  });
  return msg.message_id;
}

const drop = (messageId: number) => tg("deleteMessage", { chat_id: CHAT, message_id: messageId }).catch(() => {});

async function edit(messageId: number, text: string, keyboard: Keyboard = []): Promise<void> {
  try {
    await tg("editMessageText", {
      chat_id: CHAT, message_id: messageId, text, parse_mode: "HTML",
      link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard },
    });
  } catch (e) {
    // Unchanged text is not a failure; a message deleted from the chat is not worth one either.
    if (!/not modified|not found|can't be edited/i.test(String(e))) throw e;
  }
}

// ---------------------------------------------------------------------------
// State: the update offset, and the open cards in the chat (point -> message).

interface State {
  offset: number;
  sent: Record<string, number>;
  /** The kind of the last card sent, so the next one is the next kind's turn. */
  lastKind?: PointKind;
  /** The catatan being worked through: its points come one after another. */
  record?: { id: number; total: number };
  /** A card's correction choices, as listed on it: event ids or figure ids. */
  picks: Record<string, string[]>;
  /** "Ketik …" prompts waiting for a reply: prompt message -> point. */
  prompts: Record<string, number>;
  /** A new figure a pembicara card offers to create, from the typed reply. */
  newFig: Record<string, { name: string; role: string; org?: string }>;
  /** Messages sent alongside a card (📄 paragraphs), deleted once it is answered. */
  extras: Record<string, number[]>;
  /** Catatan taken down from a card (card's point -> takedown), for its Batalkan. */
  takedowns: Record<string, Takedown>;
  /** A card's 📋 Catatan message (point -> message), the quote being put right there, */
  view: Record<string, number>;
  viewQuote: Record<string, number>;
  /** the figure just taken off its Terkait list, and "Ketik nama" prompts from it. */
  viewUndo: Record<string, { id: string; name: string }>;
  viewPrompts: Record<string, number>;
  /** The kandidat card: its name and message, names skipped this round, what is
   *  being asked (and its prompt), a typed new figure, choices, rejects to undo. */
  cand: {
    slug?: string;
    msg?: number;
    skip: string[];
    mode?: "new" | "alias";
    prompt?: number;
    draft?: { name: string; role: string; org: string };
    picks?: string[];
    rejected: Record<string, string>;
  };
  /** Auto answers looked at from /otomatis lately, not offered again. */
  autoSeen: number[];
  /** The /tokoh card: its message, the figure it shows, what is being typed
   *  (and its prompt), a list it was opened from, choices, the name before a
   *  rename and the other figure of a merge being confirmed. */
  fig: {
    msg?: number;
    id?: string;
    mode?: "name" | "alias" | "office" | "merge" | "search";
    prompt?: number;
    found?: string[];
    picks?: string[];
    oldName?: string;
    target?: string;
  };
  /** Rework drafts sent as cards (request -> message), and "✍️" note prompts (prompt -> point). */
  drafts: Record<string, number>;
  reworkPrompts: Record<string, number>;
  /** "Pindah ke tokoh lain" name prompts (prompt -> point). */
  reworkWho: Record<string, number>;
  /** How far publish_local.log has been read, and the run being read. */
  publish: { at?: number; started?: string; trouble: string[] };
  /** The /organisasi card likewise; `draft` is a name not registered yet. */
  org: {
    msg?: number;
    id?: number;
    mode?: "name" | "short" | "alias" | "add" | "aliasOf" | "search";
    prompt?: number;
    found?: string[];
    picks?: string[];
    draft?: string;
  };
}

async function loadState(): Promise<State> {
  const row = await lqueryOne<{ value: string }>(`SELECT value FROM pipeline_state WHERE key = ?`, [STATE_KEY]);
  try {
    const s = row ? (JSON.parse(row.value) as Partial<State>) : {};
    return {
      offset: Number(s.offset) || 0,
      sent: s.sent && typeof s.sent === "object" ? s.sent : {},
      lastKind: s.lastKind && s.lastKind in KIND_LABEL ? s.lastKind : undefined,
      record: s.record && Number.isInteger(s.record.id) ? { id: s.record.id, total: Number(s.record.total) || 1 } : undefined,
      picks: s.picks && typeof s.picks === "object" ? s.picks : {},
      prompts: s.prompts && typeof s.prompts === "object" ? s.prompts : {},
      newFig: s.newFig && typeof s.newFig === "object" ? s.newFig : {},
      extras: s.extras && typeof s.extras === "object" ? s.extras : {},
      takedowns: s.takedowns && typeof s.takedowns === "object" ? s.takedowns : {},
      view: s.view && typeof s.view === "object" ? s.view : {},
      viewQuote: s.viewQuote && typeof s.viewQuote === "object" ? s.viewQuote : {},
      viewUndo: s.viewUndo && typeof s.viewUndo === "object" ? s.viewUndo : {},
      viewPrompts: s.viewPrompts && typeof s.viewPrompts === "object" ? s.viewPrompts : {},
      cand: {
        ...(s.cand && typeof s.cand === "object" ? s.cand : {}),
        skip: Array.isArray(s.cand?.skip) ? s.cand.skip : [],
        rejected: s.cand?.rejected && typeof s.cand.rejected === "object" ? s.cand.rejected : {},
      },
      autoSeen: Array.isArray(s.autoSeen) ? s.autoSeen.filter(Number.isInteger) : [],
      fig: s.fig && typeof s.fig === "object" ? s.fig : {},
      org: s.org && typeof s.org === "object" ? s.org : {},
      drafts: s.drafts && typeof s.drafts === "object" ? s.drafts : {},
      reworkPrompts: s.reworkPrompts && typeof s.reworkPrompts === "object" ? s.reworkPrompts : {},
      reworkWho: s.reworkWho && typeof s.reworkWho === "object" ? s.reworkWho : {},
      publish: {
        at: Number.isInteger(s.publish?.at) ? s.publish!.at : undefined,
        started: typeof s.publish?.started === "string" ? s.publish.started : undefined,
        trouble: Array.isArray(s.publish?.trouble) ? s.publish!.trouble : [],
      },
    };
  } catch {
    return { offset: 0, sent: {}, picks: {}, prompts: {}, newFig: {}, extras: {}, takedowns: {}, view: {}, viewQuote: {}, viewUndo: {}, viewPrompts: {}, cand: { skip: [], rejected: {} }, autoSeen: [], fig: {}, org: {}, drafts: {}, reworkPrompts: {}, reworkWho: {}, publish: { trouble: [] } };
  }
}

async function saveState(s: State): Promise<void> {
  await lrun(
    `INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [STATE_KEY, JSON.stringify(s), new Date().toISOString()]
  );
}

// ---------------------------------------------------------------------------
// Cards

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CONTEXT = 110;
function lead(text: string, n: number): string {
  if (text.length <= n) return text;
  const from = text.indexOf(" ", text.length - n);
  return `… ${text.slice(from === -1 ? text.length - n : from + 1)}`;
}
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const to = text.lastIndexOf(" ", n);
  return `${text.slice(0, to > 0 ? to : n)} …`;
}

function excerpt(p: Point): string {
  const t = p.paragraph ?? "";
  const { hl_start: s, hl_end: e } = p;
  if (s === null || e === null || e <= s) return esc(tail(t, CONTEXT * 2));
  return `${esc(lead(t.slice(0, s), CONTEXT))}<b><u>${esc(t.slice(s, e))}</u></b>${esc(tail(t.slice(e), CONTEXT))}`;
}

function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });
}

function noEffect(p: Point): string {
  switch (p.kind) {
    case "peristiwa": return "usulan tautan ditolak dan tidak ditanyakan lagi.";
    case "lini": return "usulan lini ditolak dan tidak ditanyakan lagi.";
    case "terkait": return `${p.proposal.name} dihapus dari daftar Terkait catatan ini.`;
    case "tentang": return `kutipan ini tercatat bukan tentang ${p.proposal.name}.`;
    case "jabatan": return "CV-nya tetap; jabatannya ditanyakan lagi dari berita yang lebih baru.";
    default: return "tidak ada yang berubah.";
  }
}

function meter(p: Point): string {
  const c = p.confidence;
  return c.value === null ? "yakin –" : `yakin ${Math.round(c.value * 100)}% (${c.agreed}/${c.answered})`;
}

/**
 * A decision the pipeline made without asking (a cek: point, opened from
 * /kurasi): said on the card, since Ya there confirms what is already done.
 */
function checkTag(p: Point): string {
  return p.proposal.check ? " · keputusan otomatis" : "";
}

/** The other figures a pembicara point offers, as /kurasi lists them. */
function others(p: Point): { id: string; name: string }[] {
  return (p.proposal.candidates ?? []).filter((c) => c.id !== p.proposal.figure_id).slice(0, 3);
}

/** Each sent card's place in its catatan (" · poin 2/4"), kept for redrawing it. */
const PLACE = new Map<number, string>();

async function cardText(p: Point): Promise<string> {
  const place = PLACE.get(p.id) ?? "";
  const ev = await lqueryOne<{ title: string | null }>(`SELECT title FROM events WHERE id = ?`, [p.event_id]);
  const x = p.proposal;
  const lines = [
    `<b>${esc(KIND_LABEL[p.kind].toUpperCase())}</b> · ${meter(p)}${checkTag(p)}${p.spot_check ? " · cek acak" : ""}${place}`,
    `<i>${esc(ev?.title ?? `Catatan #${p.event_id}`)}</i>`,
    "",
  ];
  if (p.paragraph) {
    const src = [p.source, day(p.published_at)].filter(Boolean).join(" · ");
    lines.push(`<blockquote>${src ? `<b>${esc(src)}</b>\n` : ""}${excerpt(p)}</blockquote>`);
  } else if (p.kind === "tentang" && x.quote) {
    lines.push(`<blockquote>“${esc(x.quote)}” — ${esc(x.speaker_name ?? x.speaker ?? "tanpa nama")}</blockquote>`);
  } else {
    lines.push("<i>Paragrafnya tidak ditemukan di teks artikel.</i>");
  }
  lines.push("");
  // Every tracked figure named on a card as Name – Role – Organisation, as /kurasi names them.
  const roster = figureKind(p) ? new Map((await getFigureOptions()).map((f) => [f.id, f])) : new Map<string, FigureOption>();
  const who = (id: string, fallback: string) => {
    const f = roster.get(id);
    return f ? `<b>${esc(f.name)}</b>${f.title ? ` – ${esc(f.title)}` : ""}` : `<b>${esc(fallback)}</b>`;
  };
  if (p.kind === "pembicara") {
    lines.push(`<b>Siapa “${esc(x.speaker ?? "")}” di sini?</b>`);
    lines.push(`${x.check ? "Pipeline sudah menuliskannya atas nama" : "Tebakan pipeline:"} ${x.figure_id ? who(x.figure_id, x.name ?? x.figure_id) : "bukan tokoh yang dilacak"}.`);
    const alt = others(p);
    if (alt.length) lines.push(`Kandidat lain: ${alt.map((c) => who(c.id, c.name)).join("; ")}.`);
    if (p.group_size > 1) lines.push(`Jawabanmu berlaku untuk ${p.group_size} kutipan sekaligus.`);
  } else {
    lines.push(`<b>${esc(x.claim)}</b>`);
    if ((p.kind === "terkait" || p.kind === "tentang") && x.figure_id) lines.push(`Tokoh: ${who(x.figure_id, x.name ?? x.figure_id)}`);
    if (p.kind === "tentang" && (x.speaker_name || x.speaker)) lines.push(`Yang bicara: ${esc(x.speaker_name ?? x.speaker ?? "")}`);
    if (p.kind === "jabatan") lines.push(`Sekarang tertulis: ${x.current ? esc(x.current) : "<i>kosong</i>"}`);
    lines.push(`<b>Jika Ya:</b> ${esc(p.effect)}`);
    lines.push(`<b>Jika Bukan:</b> ${esc(noEffect(p))}`);
  }
  return lines.join("\n");
}

function cardKeyboard(p: Point): Keyboard {
  const a = (code: string) => `a:${p.id}:${code}`;
  const rows: Keyboard = [];
  if (p.kind === "pembicara") {
    const x = p.proposal;
    if (x.figure_id) rows.push([{ text: `Ya, ${x.name ?? x.figure_id}`, callback_data: a("ya") }]);
    others(p).forEach((c, i) => rows.push([{ text: `Ini ${c.name}`, callback_data: a(`c${i}`) }]));
    // Telegram cuts a label to its share of the row and never wraps it: a
    // long one gets a row to itself, short ones go at most two to a row.
    rows.push([{ text: "Bukan tokoh yang dilacak", callback_data: a("nt") }]);
    if (x.figure_id) rows.push([{ text: `Bukan ${x.name ?? "dia"}, belum tahu siapa`, callback_data: a("bukan") }]);
  } else {
    rows.push([{ text: "Ya", callback_data: a("ya") }, { text: "Bukan", callback_data: a("bukan") }]);
  }
  rows.push([
    { text: p.kind === "pembicara" ? "🔎 Tokoh lain" : "✏️ Koreksi", callback_data: `k:${p.id}:0` },
    { text: "⏭ Lewati", callback_data: a("lewati") },
  ]);
  rows.push([{ text: "📋 Catatan", callback_data: `v:${p.id}` }, { text: "🗑 Tolak catatan", callback_data: `r:${p.id}:` }]);
  // The article on its outlet's site, in Telegram's own browser.
  if (p.article_url && /^https?:\/\//.test(p.article_url)) {
    rows.push([{ text: `📰 Baca berita${p.source ? ` · ${clip(p.source, 28)}` : ""}`, url: p.article_url }]);
  }
  if (KURASI_URL) rows.push([{ text: "Buka di /kurasi", url: `${KURASI_URL}/kurasi/${p.event_id}` }]);
  return rows;
}

const VERDICT: Record<string, string> = { ya: "✅ Ya", bukan: "❌ Bukan", koreksi: "✏️ Dikoreksi", lewati: "⏭ Dilewati" };

async function answeredText(p: Point): Promise<string> {
  const head = `${VERDICT[p.status] ?? p.status}${p.correction ? ` → ${esc(p.correction)}` : ""}`;
  const ev = await lqueryOne<{ title: string | null }>(`SELECT title FROM events WHERE id = ?`, [p.event_id]);
  return [
    `<b>${head}</b> · ${esc(KIND_LABEL[p.kind])}`,
    `<i>${esc(ev?.title ?? `Catatan #${p.event_id}`)}</i>`,
    esc(p.kind === "pembicara" ? `“${p.proposal.speaker ?? ""}”` : p.proposal.claim),
  ].join("\n");
}

/** Why the catatan comes down: /kurasi's takedown reasons, but for "Lainnya", which needs a note. */
function reasonKeyboard(p: Point): Keyboard {
  return [
    ...REASONS.filter((r) => r.code !== "other").map((r) => [{ text: r.label, callback_data: `r:${p.id}:${r.code}` }]),
    [{ text: "← Kembali", callback_data: `b:${p.id}` }],
  ];
}

async function takenDownText(p: Point, reason: string): Promise<string> {
  const ev = await lqueryOne<{ title: string | null }>(`SELECT title FROM events WHERE id = ?`, [p.event_id]);
  return [
    `<b>🗑 Catatan ditolak</b> · ${esc(reasonLabel(reason))}`,
    `<i>${esc(ev?.title ?? `Catatan #${p.event_id}`)}</i>`,
    "Tidak tampil di situs; poin-poinnya ditutup.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The loop

/** A tap's code, as the answer and correction answerPoint takes. */
function decode(p: Point, code: string): [PointAnswer, string | null] | null {
  if (code === "ya" || code === "bukan" || code === "lewati") return [code, null];
  if (p.kind !== "pembicara") return null;
  if (code === "nt") return p.proposal.figure_id ? ["koreksi", NOT_TRACKED] : ["ya", null];
  const m = /^c(\d)$/.exec(code);
  const c = m ? others(p)[Number(m[1])] : undefined;
  return c ? ["koreksi", c.id] : null;
}

/** Fill the chat up to BATCH open cards; cards answered in /kurasi meanwhile are closed. */
async function topUp(s: State): Promise<void> {
  for (const [id, msg] of Object.entries(s.sent)) {
    const p = await getPoint(Number(id));
    if (p && p.status === "open") continue;
    await forget(s, Number(id));
    await edit(msg, p ? `${await answeredText(p)}\n<i>dijawab di /kurasi</i>` : "<i>Poin ini sudah tidak ada.</i>");
  }
  // More open cards than BATCH (it was lowered): take the extra ones back out of the chat.
  for (const id of Object.keys(s.sent).sort((a, b) => s.sent[b] - s.sent[a]).slice(0, Math.max(0, Object.keys(s.sent).length - BATCH))) {
    await drop(s.sent[id]);
    await forget(s, Number(id));
  }
  while (Object.keys(s.sent).length < BATCH) {
    const p = await nextPoint(s);
    if (!p) break;
    PLACE.set(p.id, await placeOn(s, p));
    s.sent[p.id] = await send(await cardText(p), cardKeyboard(p));
  }
  await saveState(s);
}

/** The kinds take turns, in this order; a kind with nothing open is passed over. */
const ROTATION: PointKind[] = ["peristiwa", "pembicara", "tentang", "terkait", "jabatan", "lini"];

/**
 * A catatan's points come together: the catatan being worked through gives
 * the next card while it has open points, in ROTATION's order. Then the kinds
 * take turns again, the newest open point of the kind after the last one
 * picked so, and that point's catatan is the one worked through next.
 * Jabatan is about a figure, not its catatan, so it only comes in its turn.
 */
const BY_RECORD: PointKind[] = ROTATION.filter((k) => k !== "jabatan");

async function nextPoint(s: State): Promise<Point | null> {
  const exclude = Object.keys(s.sent).map(Number);
  if (s.record) {
    const p = await getNextOpenPointOn(s.record.id, BY_RECORD, exclude);
    if (p) return p;
    s.record = undefined;
  }
  const start = s.lastKind ? ROTATION.indexOf(s.lastKind) + 1 : 0;
  for (let i = 0; i < ROTATION.length; i++) {
    const p = await getNextOpenPoint(ROTATION[(start + i) % ROTATION.length], exclude);
    if (!p) continue;
    s.lastKind = p.kind;
    if (BY_RECORD.includes(p.kind)) {
      s.record = { id: p.event_id, total: await countOpenPointsOn(p.event_id, BY_RECORD, exclude) };
    }
    return p;
  }
  return null;
}

/** " · poin 2/4" when the card's catatan has more than one point, for its header. */
async function placeOn(s: State, p: Point): Promise<string> {
  if (!s.record || s.record.id !== p.event_id || !BY_RECORD.includes(p.kind)) return "";
  const others = Object.keys(s.sent).map(Number).filter((id) => id !== p.id);
  const left = await countOpenPointsOn(p.event_id, BY_RECORD, others);
  // Points the pipeline opened on it meanwhile count too.
  s.record.total = Math.max(s.record.total, left);
  return s.record.total > 1 ? ` · poin ${s.record.total - left + 1}/${s.record.total}` : "";
}

// ---------------------------------------------------------------------------
// The catatan behind a card (📋 Catatan): its summary, Terkait list and every
// quote with whose words it is, sent beside the card and gone with it. A
// quote's speaker and the Terkait list can be put right from there, as in
// /kurasi; those are the curator's say at once, not answers to a point.

const VIEW_QUOTES = 10;

/** Who said a quote, as the view lists it. */
function saidBy(q: QuoteRow): string {
  const written = q.speaker ? `“${esc(clip(q.speaker, 60))}”` : "<i>tanpa nama</i>";
  if (q.figure_id) return `${written} → <b>${esc(q.figure_name ?? q.figure_id)}</b>${q.assigned_by === "curator" ? " ✔" : ""}`;
  return `${written} → ${q.assigned_by === "curator" ? "bukan tokoh yang dilacak ✔" : "❔ belum dikenali"}`;
}

async function viewText(p: Point, note = ""): Promise<{ text: string; quotes: QuoteRow[]; related: Related[] } | null> {
  const item = await getItem(p.event_id);
  if (!item) return null;
  const related = item.kind === "record" ? await getRelated(item.event_id, item.figure_id) : [];
  const quotes = item.quotes.slice(0, VIEW_QUOTES);
  const lines = [
    `<b>📋 CATATAN</b> · ${esc(day(item.event_date))}${item.curated === "rejected" ? " · ditolak" : ""}`,
    `<i>${esc(item.title ?? `Catatan #${item.event_id}`)}</i>`,
  ];
  if (item.owner) lines.push(`Tokoh: <b>${esc(item.owner.name)}</b>${figureTitle(item.owner) ? ` – ${esc(figureTitle(item.owner))}` : ""}`);
  if (item.summary) lines.push("", esc(clip(item.summary, 700)));
  if (item.kind === "record") {
    lines.push("", `<b>Terkait</b> (${related.length})`);
    lines.push(related.length
      ? related.map((r, i) => `${i + 1}. ${esc(r.name)}${figureTitle(r) ? ` – ${esc(clip(figureTitle(r), 60))}` : ""}${r.assigned_by === "curator" ? " ✔" : ""}`).join("\n")
      : "<i>belum ada</i>");
  }
  lines.push("", `<b>Kutipan</b> (${item.quotes.length})`);
  lines.push(quotes.length
    ? quotes.map((q, i) => `<b>${i + 1}.</b> “${esc(clip(q.quote, 140))}”\n    ${saidBy(q)}`).join("\n")
    : "<i>tidak ada</i>");
  if (item.quotes.length > quotes.length) lines.push(`<i>…dan ${item.quotes.length - quotes.length} kutipan lain, di /kurasi.</i>`);
  if (note) lines.push("", note);
  return { text: lines.join("\n"), quotes, related };
}

/** Numbered buttons, four to a row. */
function numbered(n: number, label: string, data: (i: number) => string): Keyboard {
  const rows: Keyboard = [];
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: `${label} ${i + 1}`, callback_data: data(i) });
  }
  return rows;
}

/** Send the view, or redraw it in place; `note` says what just changed. */
async function showView(s: State, p: Point, note = ""): Promise<void> {
  const v = await viewText(p, note);
  if (!v) throw new Error("Catatannya tidak ditemukan.");
  s.picks[`v${p.id}`] = [...v.quotes.map((q) => `q${q.id}`), ...v.related.map((r) => `f${r.id}`)];
  const rows: Keyboard = [
    ...numbered(v.quotes.length, "🗣", (i) => `vq:${p.id}:${i}`),
    ...numbered(v.related.length, "✖ Terkait", (i) => `vt:${p.id}:${i}`),
  ];
  const back = s.viewUndo[p.id];
  if (back) rows.push([{ text: `↩ Kembalikan ${clip(back.name, 22)}`, callback_data: `vr:${p.id}` }]);
  const unchecked = await getUncheckedCount(p.event_id);
  if (unchecked) rows.push([{ text: `🔍 Cek ${unchecked} keputusan otomatis`, callback_data: `vc:${p.id}` }]);
  rows.push([{ text: "👤 Ubah data tokoh", callback_data: `vf:${p.id}` }, { text: "✍️ Tulis ulang", callback_data: `vw:${p.id}` }]);
  rows.push([{ text: "Tutup", callback_data: `vx:${p.id}` }]);
  const at = s.view[p.id];
  if (at) {
    await edit(at, v.text, rows);
    return;
  }
  const id = await send(v.text, rows, { reply_parameters: { message_id: s.sent[p.id] ?? 0, allow_sending_without_reply: true } });
  s.view[p.id] = id;
  (s.extras[p.id] ??= []).push(id);
}

/** The view's pick at `i`: a quote id or a Terkait figure id. */
function viewPick(s: State, p: Point, i: number, kind: "q" | "f"): string {
  const all = s.picks[`v${p.id}`] ?? [];
  const of = all.filter((x) => x[0] === kind);
  const pick = of[i];
  if (!pick) throw new Error("Daftar ini sudah berubah; buka 📋 Catatan lagi.");
  return pick.slice(1);
}

/** One quote's speaker to put right: the view with that quote's choices. */
async function showQuoteFix(s: State, p: Point, quoteId: number): Promise<void> {
  const item = await getItem(p.event_id);
  const q = item?.quotes.find((x) => x.id === quoteId);
  if (!q) throw new Error("Kutipan ini sudah tidak ada.");
  s.viewQuote[p.id] = quoteId;
  const rows: Keyboard = [];
  if (q.figure_id && q.assigned_by !== "curator") rows.push([{ text: `✅ Benar, ${clip(q.figure_name ?? q.figure_id, 22)}`, callback_data: `vy:${p.id}` }]);
  rows.push([{ text: "Bukan tokoh yang dilacak", callback_data: `vn:${p.id}` }]);
  rows.push([{ text: "🔎 Ketik nama", callback_data: `vs:${p.id}` }, { text: "← Kembali", callback_data: `v:${p.id}` }]);
  await edit(s.view[p.id], [
    `<b>🗣 Siapa yang bicara?</b>`,
    `<blockquote>“${esc(clip(q.quote, 400))}”</blockquote>`,
    `Tertulis: ${saidBy(q)}`,
  ].join("\n"), rows);
}

/** The figures a name typed for a quote matched, to pick from. */
async function showQuoteFigures(s: State, p: Point, typed: string): Promise<void> {
  const found = findFigures(await getFigureOptions(), typed.trim().slice(0, 200), null);
  s.picks[`v${p.id}f`] = found.map((f) => f.id);
  const rows: Keyboard = found.map((f, i) => [{ text: clip(`${i + 1}. ${f.name}`, 30), callback_data: `vp:${p.id}:${i}` }]);
  rows.push([{ text: "🔎 Cari lagi", callback_data: `vs:${p.id}` }, { text: "← Kembali", callback_data: `v:${p.id}` }]);
  const list = found.map((f, i) => `<b>${i + 1}.</b> <b>${esc(f.name)}</b>${f.title ? ` – ${esc(f.title)}` : ""}`).join("\n");
  await edit(s.view[p.id], found.length
    ? `<b>🗣 Hasil “${esc(typed)}”:</b>\n${list}`
    : `<b>🗣 Tidak ada tokoh yang cocok dengan “${esc(typed)}”.</b> Cari lagi, atau Kembali. Tokoh baru dibuat dari /kurasi.`, rows);
}

/** The 📋 buttons (callback codes starting with "v"); returns the note for the tap. */
async function onView(s: State, kind: string, p: Point, code: string | undefined, msgId: number): Promise<string> {
  if (kind === "v") {
    await showView(s, p);
    return "";
  }
  // The tap came from the view itself: its message, even after a restart.
  s.view[p.id] = msgId;
  if (kind === "vx") {
    await drop(msgId);
    s.extras[p.id] = (s.extras[p.id] ?? []).filter((m) => m !== msgId);
    delete s.view[p.id];
    delete s.viewQuote[p.id];
    delete s.viewUndo[p.id];
    return "";
  }
  if (kind === "vq") {
    await showQuoteFix(s, p, Number(viewPick(s, p, Number(code), "q")));
    return "";
  }
  if (kind === "vt") {
    const fid = viewPick(s, p, Number(code), "f");
    const name = (await getRelated(p.event_id, null)).find((r) => r.id === fid)?.name ?? fid;
    await setRelated(p.event_id, fid, false);
    s.viewUndo[p.id] = { id: fid, name };
    await showView(s, p, `✖ ${esc(name)} dihapus dari Terkait.`);
    return "Dihapus dari Terkait";
  }
  if (kind === "vw") {
    await showReworkMenu(s, p);
    return "";
  }
  if (kind === "vwn") {
    const id = await send("Tulis apa yang salah dan bagaimana seharusnya, untuk model yang menulis ulang.", undefined, {
      reply_parameters: { message_id: msgId, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: "Catatan untuk model" },
    });
    s.reworkPrompts[id] = p.id;
    return "";
  }
  if (kind === "vwf") {
    const id = await send("Ketik nama tokoh yang seharusnya punya catatan ini.", undefined, {
      reply_parameters: { message_id: msgId, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: "Nama tokoh" },
    });
    s.reworkWho[id] = p.id;
    return "";
  }
  if (kind === "vwp") {
    const to = s.picks[`w${p.id}`]?.[Number(code)];
    if (!to) throw new Error("Pilihan ini sudah kedaluwarsa; ketik namanya lagi.");
    const name = (await getFigureOptions()).find((f) => f.id === to)?.name ?? to;
    await askRework(p.event_id, null, null, to);
    delete s.picks[`w${p.id}`];
    await showView(s, p, `✍️ Diminta ditulis ulang sebagai catatan ${esc(name)}; drafnya datang di sini.`);
    return "Diminta";
  }
  if (kind === "vwa") {
    await askRework(p.event_id, null, "about");
    await showView(s, p, "✍️ Diminta ditulis ulang sebagai liputan tentang tokohnya; drafnya datang di sini.");
    return "Diminta";
  }
  if (kind === "vf") {
    const item = await getItem(p.event_id);
    if (!item) throw new Error("Catatannya tidak ditemukan.");
    const byId = new Map((await getFigureOptions()).map((f) => [f.id, f]));
    const ids = [item.figure_id, ...(await getRelated(p.event_id, null)).map((r) => r.id), ...item.quotes.map((q) => q.figure_id)];
    const figures = [...new Set(ids)].map((x) => (x ? byId.get(x) : undefined)).filter((f): f is FigureOption => Boolean(f)).slice(0, FOUND);
    await figureList(s, "<b>👤 Tokoh di catatan ini</b>", figures);
    return "";
  }
  if (kind === "vc") {
    await pipelineOp("open-checks", String(p.event_id));
    // They are this catatan's points now: they come next, after this card.
    if (s.record?.id !== p.event_id) {
      s.record = { id: p.event_id, total: await countOpenPointsOn(p.event_id, BY_RECORD) };
    } else {
      s.record.total = Math.max(s.record.total, await countOpenPointsOn(p.event_id, BY_RECORD));
    }
    await showView(s, p, "🔍 Keputusan otomatisnya dibuka sebagai kartu; datang setelah kartu ini.");
    return "Cek dibuka";
  }
  if (kind === "vr") {
    const back = s.viewUndo[p.id];
    if (!back) throw new Error("Tidak ada yang bisa dikembalikan.");
    await setRelated(p.event_id, back.id, true);
    delete s.viewUndo[p.id];
    await showView(s, p, `↩ ${esc(back.name)} kembali di Terkait.`);
    return "Dikembalikan";
  }
  const quoteId = s.viewQuote[p.id];
  if (!quoteId) throw new Error("Pilih kutipannya lagi.");
  if (kind === "vs") {
    const id = await send("Ketik nama tokoh yang bicara.", undefined, {
      reply_parameters: { message_id: msgId, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: "Nama tokoh" },
    });
    s.viewPrompts[id] = p.id;
    return "";
  }
  let to: string | null;
  if (kind === "vy") {
    to = (await getItem(p.event_id))?.quotes.find((q) => q.id === quoteId)?.figure_id ?? null;
    if (!to) throw new Error("Kutipan ini belum punya pembicara.");
  } else if (kind === "vn") {
    to = null;
  } else if (kind === "vp") {
    to = s.picks[`v${p.id}f`]?.[Number(code)] ?? null;
    if (!to) throw new Error("Pilihan ini sudah kedaluwarsa; ketik namanya lagi.");
  } else {
    throw new Error("Tombol tidak dikenal.");
  }
  await assignQuote(quoteId, to);
  delete s.viewQuote[p.id];
  delete s.picks[`v${p.id}f`];
  await showView(s, p, "🗣 Pembicara disimpan.");
  return "Pembicara disimpan";
}

// ---------------------------------------------------------------------------
// Kandidat tokoh (/kandidat): names the media use often enough that are not
// tracked yet, as /kurasi/kandidat lists them, most outlets first. One card at
// a time; each decision brings the next. They are not points: a decision is
// carried out at once (lib/candidates), a new figure by the pipeline's own code.

/** Undecided names, most outlets first, without the ones skipped this round. */
async function nextCandidate(s: State): Promise<CandidateRow | null> {
  const rows = await getCandidates("undecided", 300);
  return rows.find((r) => !s.cand.skip.includes(r.slug)) ?? null;
}

/** A feed's context as plain text: RSS summaries carry <img …> markup, sometimes cut mid-tag. */
function plain(t: string): string {
  const decoded = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const untagged = decoded.replace(/<[^>]*>/g, " ");
  const after = untagged.includes(">") ? untagged.slice(untagged.lastIndexOf(">") + 1) : untagged;
  return after.replace(/\s+/g, " ").trim();
}

/** The kandidat card: the name, where the media use it, and tracked figures it may be. */
async function candidateCard(s: State, c: CandidateRow, note = ""): Promise<[string, Keyboard]> {
  const like = findFigures(await getFigureOptions(), c.name, null).slice(0, 2);
  s.cand.picks = like.map((f) => f.id);
  const lines = [
    `<b>👤 KANDIDAT TOKOH</b> · ${c.outlets} media · ${c.mentions}× disebut`,
    `<b>${esc(c.name)}</b>${c.role ? ` · <i>${esc(c.role)}</i>` : ""}`,
  ];
  // The same sentence comes from several articles: once is enough.
  const seen = [...new Map(c.headlines.map((h) => [plain(h.context ?? h.title), h] as const)).entries()]
    .filter(([t]) => t)
    .slice(0, 3);
  if (seen.length) {
    lines.push("", ...seen.map(([t, h]) => `• ${esc(clip(t, 220))}${h.source ? ` — <i>${esc(h.source)}</i>` : ""}`));
  }
  if (c.records.length) {
    lines.push("", "<b>Di catatan:</b>", ...c.records.slice(0, 3).map((r) => `• ${esc(clip(r.title, 90))}`));
  }
  if (like.length) {
    lines.push("", "<b>Mungkin tokoh yang sudah ada:</b>", ...like.map((f, i) => `<b>${i + 1}.</b> ${esc(f.name)}${f.title ? ` – ${esc(f.title)}` : ""}`));
  }
  if (c.notes) lines.push("", `📝 ${esc(clip(c.notes, 300))}`);
  if (note) lines.push("", note);
  const rows: Keyboard = like.map((f, i) => [{ text: clip(`🔗 Ini ${i + 1}. ${f.name}`, 32), callback_data: `c:same:${i}` }]);
  rows.push(
    [{ text: "✅ Jadikan tokoh", callback_data: "c:new" }, { text: "🔗 Tokoh lain", callback_data: "c:alias" }],
    [{ text: "❌ Bukan orang / tolak", callback_data: "c:no" }, { text: "⏭ Lewati", callback_data: "c:skip" }],
  );
  const url = c.headlines.find((h) => h.url && /^https?:\/\//.test(h.url))?.url;
  if (url) rows.push([{ text: "📰 Baca berita", url }]);
  return [lines.join("\n"), rows];
}

/** The current card's name, re-read: it may have been decided in /kurasi meanwhile. */
async function currentCandidate(s: State): Promise<CandidateRow> {
  const c = s.cand.slug ? await getCandidate(s.cand.slug) : null;
  if (!c) throw new Error("Kandidat ini sudah tidak ada; /kandidat untuk yang berikutnya.");
  return c;
}

/** Send the next undecided name's card, or say there is none. */
async function showNextCandidate(s: State): Promise<void> {
  const c = await nextCandidate(s);
  s.cand.mode = undefined;
  s.cand.draft = undefined;
  s.cand.picks = undefined;
  if (!c) {
    s.cand.slug = undefined;
    s.cand.msg = undefined;
    await send(s.cand.skip.length ? "Tidak ada kandidat lagi selain yang dilewati. /kandidat ulang untuk melihatnya lagi." : "Tidak ada kandidat tokoh yang menunggu.");
    s.cand.skip = [];
    return;
  }
  s.cand.slug = c.slug;
  s.cand.msg = await send(...(await candidateCard(s, c)));
}

/**
 * The card again, with what is being asked or what just happened under it:
 * its own buttons, or `rows` of a list to pick from, whose `picks` they point into.
 */
async function redrawCandidate(s: State, c: CandidateRow, note = "", rows?: Keyboard, picks?: string[]): Promise<void> {
  const [text, own] = await candidateCard(s, c, note);
  if (rows) s.cand.picks = picks ?? [];
  await edit(s.cand.msg!, text, rows ?? own);
}

async function askCandidate(s: State, mode: "new" | "alias", c: CandidateRow): Promise<void> {
  s.cand.mode = mode;
  const ask = mode === "new"
    ? `Ketik nama lengkap, jabatan dan organisasinya, dipisah koma: <i>Nama Lengkap, jabatan, organisasi</i> (mis. <i>${esc(c.name)}, Wakil Kepala, Badan Gizi Nasional</i>). Jabatan dan organisasi boleh kosong.`
    : `Ketik nama tokoh yang sudah dilacak; “${esc(c.name)}” jadi salah satu nama lainnya.`;
  const id = await send(ask, undefined, {
    reply_parameters: { message_id: s.cand.msg!, allow_sending_without_reply: true },
    reply_markup: { force_reply: true, input_field_placeholder: mode === "new" ? "Nama Lengkap, jabatan, organisasi" : "Nama tokoh" },
  });
  s.cand.prompt = id;
}

/** A reply to a kandidat prompt: the new figure to confirm, or figures to pick from. */
async function onCandidateReply(s: State, typed: string): Promise<void> {
  const c = await currentCandidate(s);
  if (s.cand.mode === "new") {
    const [rawName, rawRole = "", ...rest] = typed.split(",");
    const draft = { name: rawName.trim().slice(0, 200), role: rawRole.trim().slice(0, 300), org: rest.join(",").trim().slice(0, 300) };
    if (draft.name.length < 3) throw new Error("Namanya terlalu pendek.");
    s.cand.draft = draft;
    // Someone tracked already under that name: say so before a duplicate is made.
    const like = findFigures(await getFigureOptions(), draft.name, null).slice(0, 3);
    const lines = [
      `<b>➕ Tokoh baru:</b> ${[draft.name, draft.role, draft.org].filter(Boolean).map(esc).join(" – ")}`,
      ...(fold(draft.name) !== fold(c.name) ? [`Nama lain: ${esc(c.name)}`] : []),
    ];
    if (like.length) {
      lines.push("", "<b>⚠️ Mirip tokoh yang sudah ada:</b>", ...like.map((f, i) => `<b>${i + 1}.</b> ${esc(f.name)}${f.title ? ` – ${esc(f.title)}` : ""}`));
    }
    const rows: Keyboard = [[{ text: "✅ Buat tokoh ini", callback_data: "c:make" }]];
    like.forEach((f, i) => rows.push([{ text: clip(`🔗 Sama dengan ${i + 1}. ${f.name}`, 32), callback_data: `c:same:${i}` }]));
    rows.push([{ text: "✏️ Ketik ulang", callback_data: "c:new" }, { text: "← Kembali", callback_data: "c:back" }]);
    await redrawCandidate(s, c, lines.join("\n"), rows, like.map((f) => f.id));
    return;
  }
  const found = findFigures(await getFigureOptions(), typed.trim().slice(0, 200), null);
  const rows: Keyboard = found.map((f, i) => [{ text: clip(`${i + 1}. ${f.name}`, 30), callback_data: `c:same:${i}` }]);
  rows.push([{ text: "🔎 Cari lagi", callback_data: "c:alias" }, { text: "← Kembali", callback_data: "c:back" }]);
  await redrawCandidate(s, c, found.length
    ? `<b>🔗 Hasil “${esc(typed)}”:</b>\n${found.map((f, i) => `<b>${i + 1}.</b> ${esc(f.name)}${f.title ? ` – ${esc(f.title)}` : ""}`).join("\n")}`
    : `<b>🔗 Tidak ada tokoh yang cocok dengan “${esc(typed)}”.</b>`, rows, found.map((f) => f.id));
}

/** The kandidat buttons ("c:…"); returns the note for the tap. */
async function onCandidate(s: State, action: string, arg: string | undefined, msgId: number): Promise<string> {
  if (msgId !== s.cand.msg) throw new Error("Kartu kandidat ini sudah lewat; /kandidat untuk yang berikutnya.");
  if (action === "undo") throw new Error("Batalkan dari kartu yang sudah dijawab.");
  const c = await currentCandidate(s);
  const decided = async (text: string, undo = false) => {
    await edit(msgId, `${text}\n<i>${esc(c.name)}</i>`, undo ? [[{ text: "Batalkan", callback_data: "cu" }]] : []);
    if (undo) s.cand.rejected[String(msgId)] = c.slug;
    await showNextCandidate(s);
  };
  switch (action) {
    case "back":
      s.cand.mode = s.cand.draft = s.cand.picks = undefined;
      await redrawCandidate(s, c);
      return "";
    case "new":
    case "alias":
      await askCandidate(s, action, c);
      return "";
    case "skip":
      s.cand.skip.push(c.slug);
      await edit(msgId, `<b>⏭ Dilewati</b>\n<i>${esc(c.name)}</i>`);
      await showNextCandidate(s);
      return "Dilewati";
    case "no":
      await setCandidateVerdict(c.slug, "reject");
      await decided("<b>❌ Ditolak</b>", true);
      return "Ditolak";
    case "make": {
      const d = s.cand.draft;
      if (!d) throw new Error("Ketik namanya lagi.");
      const positions = d.role || d.org ? [{ role: d.role, org: d.org, period: "" }] : [];
      const extra = fold(d.name) !== fold(c.name) ? c.name : "";
      await setCandidateVerdict(c.slug, "promote", d.name, extra, positions.length ? positionTitle(positions[0]) : "", "",
        positions.length ? JSON.stringify(positions) : null);
      await decided(`<b>✅ Tokoh baru:</b> ${[d.name, d.role, d.org].filter(Boolean).map(esc).join(" – ")}`);
      return "Tokoh dibuat";
    }
    case "same": {
      const fid = s.cand.picks?.[Number(arg)];
      if (!fid) throw new Error("Pilihan ini sudah kedaluwarsa; ketik namanya lagi.");
      const fig = (await getFigureOptions()).find((f) => f.id === fid);
      await setCandidateVerdict(c.slug, "alias", null, null, null, fid, null);
      await decided(`<b>🔗 Nama lain dari ${esc(fig?.name ?? fid)}</b>`);
      return "Disimpan sebagai nama lain";
    }
    default:
      throw new Error("Tombol tidak dikenal.");
  }
}

/** "Batalkan" on a rejected name's card: back in the queue, and on a card again. */
async function undoCandidateReject(s: State, msgId: number): Promise<string> {
  const slug = s.cand.rejected[String(msgId)];
  if (!slug) throw new Error("Penolakan ini tidak bisa dibatalkan dari sini; buka /kurasi/kandidat.");
  await setCandidateVerdict(slug, null);
  delete s.cand.rejected[String(msgId)];
  await edit(msgId, "<b>↩ Penolakan dibatalkan</b>; namanya kembali ke antrean.");
  return "Dibatalkan";
}

// ---------------------------------------------------------------------------
// Auto-answering (/otomatis): per kind, whether it is on and which bands have
// cleared the gate, switched as in /kurasi; and the answers it gave, one card
// at a time, newest first, to let stand or call Salah — which puts it back,
// rules the other way and counts against the kind, as /kurasi's does.

const pct = (c: Confidence) => (c.value === null ? "–" : `${Math.round(c.value * 100)}% (${c.agreed}/${c.answered})`);

async function autoText(note = ""): Promise<[string, Keyboard]> {
  const stats = (await getKindStats()) ?? [];
  const lines = ["<b>🤖 JAWABAN OTOMATIS</b>", ""];
  const rows: Keyboard = [];
  for (const k of stats) {
    const ready = k.buckets.filter((b) => b.eligible);
    lines.push(`<b>${esc(KIND_LABEL[k.kind])}</b> · ${k.auto ? "🟢 nyala" : "⚪ mati"} · ${k.open} terbuka · yakin ${pct(k.overall)}`);
    if (ready.length) lines.push(`  siap: ${ready.map((b) => esc(b.bucket || "–")).join(", ")}`);
    else {
      const best = k.buckets[0];
      lines.push(`  belum ada pita yang siap${best ? ` · terbanyak: ${esc(best.bucket || "–")} ${best.confidence.answered}/${AUTO_MIN_ANSWERS}` : ""}`);
    }
    if (k.answeredAuto) lines.push(`  dijawab otomatis: ${k.answeredAuto}`);
    if (k.switchedOff) lines.push(`  ⚠️ dimatikan pipeline ${esc(day(k.switchedOff.at))}: cek ${k.switchedOff.agreed}/${k.switchedOff.checked} benar`);
    // Switching on does nothing until a band is ready: no button for that.
    if (k.auto) rows.push([{ text: `⚪ Matikan ${KIND_LABEL[k.kind]}`, callback_data: `ot:${k.kind}:0` }]);
    else if (ready.length) rows.push([{ text: `🟢 Nyalakan ${KIND_LABEL[k.kind]}`, callback_data: `ot:${k.kind}:1` }]);
  }
  lines.push("", `<i>Pita siap: ${AUTO_MIN_ANSWERS}+ jawabanmu dan yakin ${Math.round(AUTO_MIN_AGREEMENT * 100)}%+. Yang menyala hanya menjawab pita yang siap; satu dari ${SPOT_CHECK_EVERY} tetap ditanyakan sebagai cek acak.</i>`);
  if (stats.some((k) => k.answeredAuto)) rows.push([{ text: "🧾 Periksa jawaban otomatis", callback_data: "oc" }]);
  if (note) lines.push("", note);
  return [lines.join("\n"), rows];
}

/** The next auto answer to look at, on the overview's message or a new one. */
async function showAutoAnswer(s: State, msgId?: number): Promise<void> {
  const p = await getNextAutoAnswered(s.autoSeen);
  // The card as it was asked, said as what was done and what Salah does instead.
  const asked = p ? (await cardText(p)).replace("<b>Jika Ya:</b>", "<b>Sudah dilakukan:</b>").replace("<b>Jika Bukan:</b>", "<b>Jika Salah:</b>") : "";
  const text = p
    ? `<b>🤖 Dijawab otomatis: Ya</b> · ${esc(day(p.answered_at))}\n\n${asked}`
    : "Tidak ada jawaban otomatis lagi yang belum kamu periksa.";
  const rows: Keyboard = p
    ? [[{ text: "❌ Salah", callback_data: `os:${p.id}` }, { text: "✅ Benar, lanjut", callback_data: `ok:${p.id}` }]]
    : [];
  if (msgId) await edit(msgId, text, rows);
  else await send(text, rows);
}

/** The /otomatis buttons ("o…"); returns the note for the tap. */
async function onAuto(s: State, kind: string, arg: string, code: string | undefined, msgId: number): Promise<string> {
  if (kind === "ot") {
    if (!(arg in KIND_LABEL)) throw new Error("Jenis tidak dikenal.");
    await setAutoKind(arg as PointKind, code === "1");
    const label = KIND_LABEL[arg as PointKind];
    await edit(msgId, ...(await autoText(code === "1" ? `🟢 ${esc(label)} dinyalakan; berlaku di proses berikutnya.` : `⚪ ${esc(label)} dimatikan.`)));
    return code === "1" ? "Dinyalakan" : "Dimatikan";
  }
  if (kind === "oc") {
    await showAutoAnswer(s);
    return "";
  }
  const id = Number(arg);
  if (!Number.isInteger(id)) throw new Error("Tombol tidak dikenal.");
  // Kept short: only what was looked at recently needs leaving out.
  s.autoSeen = [...s.autoSeen.filter((x) => x !== id), id].slice(-500);
  if (kind === "os") {
    const p = await getPoint(id);
    if (!p || p.status !== "auto") throw new Error("Jawaban ini sudah bukan jawaban otomatis.");
    await salahPoint(id);
    await edit(msgId, `<b>❌ Salah dicatat</b> · ${esc(KIND_LABEL[p.kind])}\n${esc(p.kind === "pembicara" ? `“${p.proposal.speaker ?? ""}”` : p.proposal.claim)}\n<i>Dikembalikan dan diputuskan sebaliknya; dihitung melawan jawaban otomatis jenis ini.</i>`);
    await showAutoAnswer(s);
    return "Salah dicatat";
  }
  if (kind === "ok") {
    await showAutoAnswer(s, msgId);
    return "";
  }
  throw new Error("Tombol tidak dikenal.");
}

// ---------------------------------------------------------------------------
// Tokoh and organisasi (/tokoh, /organisasi, 👤 on the 📋 view): a figure's
// name, aliases and offices put right, a duplicate merged, a "figure" that is
// no one retired; an organisation added, renamed, given a short name, aliases
// and a kind. The same writers as /kurasi/tokoh and /kurasi/organisasi. One
// card of each at a time: its buttons act on the figure or organisation the
// card shows, so a tap on an older card is refused rather than misapplied.

const ORG_KIND_LABEL: Record<string, string> = {
  kementerian: "Kementerian", lembaga: "Lembaga", parlemen: "Parlemen", pemerintah: "Pemerintah daerah",
  kabinet: "Kabinet", partai: "Partai", aparat: "Aparat", bumn: "BUMN", swasta: "Swasta", ormas: "Ormas",
  kampus: "Kampus", media: "Media", olahraga: "Olahraga", internasional: "Internasional", lainnya: "Lainnya",
};

/** Splits a typed list: one per line, or separated by "|", ";" or commas. */
const typedList = (t: string) => t.split(/[\n|;,]/).map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean);

/**
 * The organisation as offices should write it, and a line saying whether it
 * matched one: the registry's, one other figures already use, or a new name.
 */
async function orgMatch(typed: string): Promise<{ org: string; note: string }> {
  const [choices, registry] = await Promise.all([getOrgChoices(), getOrganizations()]);
  // An alias names the registered organisation too ("Partai Gerindra"):
  // the office is written with its registered name.
  const key = orgKey(typed);
  const byAlias = registry.find((o) => o.aliases.some((a) => orgKey(a) === key));
  const org = byAlias ? byAlias.name : canonicalOrg(typed, choices);
  const reg = registry.find((o) => orgKey(o.name) === orgKey(org));
  if (reg) {
    const as = orgKey(typed) !== orgKey(org) ? ` (dari “${esc(typed.trim())}”)` : "";
    return { org, note: `🏢 Organisasi: <b>${esc(reg.name)}</b>${reg.short_name ? ` · ${esc(reg.short_name)}` : ""}${as} — terdaftar.` };
  }
  const used = choices.find((c) => orgKey(c.name) === orgKey(org));
  return used && used.uses > 0
    ? { org, note: `🏢 Organisasi: <b>${esc(org)}</b> — dipakai ${used.uses} tokoh, belum terdaftar. /organisasi ${esc(org)} untuk mendaftarkannya.` }
    : { org, note: `🏢 Organisasi baru: <b>${esc(org)}</b> — belum dipakai tokoh lain. Kalau ini nama lain organisasi yang sudah ada, tambahkan sebagai alias lewat /organisasi.` };
}

// --- Tokoh

async function figureCard(s: State, id: string, note = ""): Promise<[string, Keyboard]> {
  const full = await getFigureFull(id);
  if (!full) throw new Error("Tokoh ini tidak ditemukan.");
  const f = full.person;
  const options = await getFigureOptions();
  const dups = f.active ? likelyDuplicates({ id: f.id, name: f.name, aliases: f.aliases }, options) : [];
  s.fig.id = id;
  s.fig.picks = dups.map((d) => d.figure.id);
  const lines = [`<b>👤 TOKOH</b>${f.active ? "" : " · <i>nonaktif</i>"}`, `<b>${esc(f.name)}</b>`];
  lines.push("", "<b>Jabatan</b>");
  lines.push(f.positions.length
    ? f.positions.map((p, i) => `${i + 1}. ${esc(positionTitle(p))}${p.period ? ` (${esc(p.period)})` : ""}${i === 0 ? " ⭐" : ""}`).join("\n")
    : "<i>belum ada</i>");
  lines.push("", `<b>Alias</b> ${f.aliases.length ? f.aliases.map((a, i) => `${i + 1}. ${esc(a)}`).join(" · ") : "<i>tidak ada</i>"}`);
  lines.push("", `${full.recordCount} catatan · ${full.quoteCount} kutipan`);
  if (dups.length) {
    lines.push("", "<b>Mungkin orang yang sama</b>");
    lines.push(dups.map((d, i) => `${i + 1}. <b>${esc(d.figure.name)}</b>${d.figure.title ? ` – ${esc(clip(d.figure.title, 50))}` : ""}\n    <i>${esc(d.why)}</i>`).join("\n"));
  }
  if (note) lines.push("", note);
  const rows: Keyboard = [];
  if (f.active) {
    rows.push([{ text: "✏️ Nama", callback_data: "f:n" }, { text: "🏷 + Alias", callback_data: "f:a" }, { text: "💼 + Jabatan", callback_data: "f:j" }]);
    if (s.fig.oldName && s.fig.oldName !== f.name && !f.aliases.some((a) => fold(a) === fold(s.fig.oldName!))) {
      rows.push([{ text: `🏷 Simpan “${clip(s.fig.oldName, 22)}” sebagai alias`, callback_data: "f:ka" }]);
    }
    rows.push(...numbered(Math.min(f.aliases.length, 8), "✖ Alias", (i) => `f:ax:${i}`));
    rows.push(...numbered(Math.min(f.positions.length, 8), "✖ Jab", (i) => `f:jx:${i}`));
    const lift: Button[] = f.positions.slice(1, 8).map((_, i) => ({ text: `⭐ ${i + 2}`, callback_data: `f:jm:${i + 1}` }));
    for (let i = 0; i < lift.length; i += 4) rows.push(lift.slice(i, i + 4));
    dups.forEach((d, i) => rows.push([{ text: `🔀 Sama dengan ${clip(`${i + 1}. ${d.figure.name}`, 24)}`, callback_data: `f:m:${i}` }]));
    rows.push([{ text: "🔀 Gabung dengan… (ketik)", callback_data: "f:mt" }, { text: "🚫 Bukan orang", callback_data: "f:b" }]);
  }
  rows.push([{ text: "Tutup", callback_data: "f:x" }]);
  return [lines.join("\n"), rows];
}

/** A list of figures to open, as a new /tokoh message. */
async function figureList(s: State, head: string, figures: { id: string; name: string; title?: string }[]): Promise<void> {
  if (s.fig.msg) await drop(s.fig.msg);
  s.fig = { found: figures.map((f) => f.id) };
  const list = figures.map((f, i) => `<b>${i + 1}.</b> <b>${esc(f.name)}</b>${f.title ? ` – ${esc(clip(f.title, 60))}` : ""}`).join("\n");
  const rows: Keyboard = figures.map((f, i) => [{ text: clip(`${i + 1}. ${f.name}`, 30), callback_data: `f:o:${i}` }]);
  rows.push([{ text: "🔎 Cari tokoh", callback_data: "f:q" }, { text: "Tutup", callback_data: "f:x" }]);
  s.fig.msg = await send(figures.length ? `${head}\n${list}` : `${head}\n<i>tidak ada</i>`, rows);
}

/** /tokoh [nama]: a search, or the newest figures the pipeline added (where junk shows up). */
async function tokohCommand(s: State, q: string): Promise<void> {
  if (q) {
    const found = findFigures(await getFigureOptions(), q.slice(0, 200), null);
    await figureList(s, `<b>👤 Tokoh “${esc(q)}”</b>`, found);
    return;
  }
  const rows = await lquery<{ id: string }>(
    `SELECT id FROM figures WHERE active AND origin = 'discovered' ORDER BY created_at DESC, id LIMIT ${FOUND}`
  );
  const byId = new Map((await getFigureOptions()).map((f) => [f.id, f]));
  await figureList(s, "<b>👤 Tokoh terbaru dari pipeline</b> <i>(cari: /tokoh nama)</i>",
    rows.map((r) => byId.get(r.id)).filter((f): f is FigureOption => Boolean(f)));
}

async function askFigure(s: State, mode: NonNullable<State["fig"]["mode"]>, msgId: number): Promise<void> {
  const ask: Record<typeof mode, [string, string]> = {
    name: ["Ketik nama yang benar.", "Nama tokoh"],
    alias: ["Ketik alias yang ditambahkan, dipisah koma (mis. <i>Pak Bas, Basuki</i>). Minimal 3 huruf.", "Alias"],
    office: ["Ketik jabatannya: <i>jabatan, organisasi</i>, boleh ditambah periode (mis. <i>Menteri, Kementerian Perdagangan, 2024–</i>). Jadi jabatan utama.", "Jabatan, organisasi"],
    merge: ["Ketik nama tokoh yang sama dengan ini.", "Nama tokoh"],
    search: ["Ketik nama tokoh yang dicari.", "Nama tokoh"],
  };
  s.fig.mode = mode;
  s.fig.prompt = await send(ask[mode][0], undefined, {
    reply_parameters: { message_id: msgId, allow_sending_without_reply: true },
    reply_markup: { force_reply: true, input_field_placeholder: ask[mode][1] },
  });
}

/** Saves the figure with one thing changed, keeping the rest as it is. */
async function saveFigure(id: string, change: (f: { name: string; aliases: string[]; positions: Position[] }) => void): Promise<void> {
  const full = await getFigureFull(id);
  if (!full) throw new Error("Tokoh ini tidak ditemukan.");
  const f = { name: full.person.name, aliases: [...full.person.aliases], positions: [...full.person.positions] };
  change(f);
  const role = f.positions.length ? positionTitle(f.positions[0]) : null;
  await saveFigureEdit(id, f.name, role, f.aliases, full.person.active !== false, f.positions, null);
}

async function redrawFigure(s: State, note = ""): Promise<void> {
  if (!s.fig.id || !s.fig.msg) return;
  await edit(s.fig.msg, ...(await figureCard(s, s.fig.id, note)));
}

async function onFigureReply(s: State, typed: string): Promise<void> {
  const mode = s.fig.mode;
  s.fig.mode = undefined;
  const id = s.fig.id;
  const t = typed.replace(/\s+/g, " ").trim();
  if (mode === "search") return tokohCommand(s, t);
  if (!id || !s.fig.msg) throw new Error("Kartu tokohnya sudah ditutup; buka lagi dengan /tokoh.");
  if (mode === "name") {
    if (t.length < 3 || t.length > 120) throw new Error("Nama 3–120 huruf.");
    const before = (await getFigureFull(id))?.person.name;
    await saveFigure(id, (f) => {
      f.name = t;
      f.aliases = f.aliases.filter((a) => fold(a) !== fold(t));
    });
    s.fig.oldName = before;
    await redrawFigure(s, `✏️ Nama diganti: ${esc(before ?? "")} → <b>${esc(t)}</b>.`);
  } else if (mode === "alias") {
    const add = typedList(t);
    const short = add.find((a) => a.length < 3);
    if (short) throw new Error(`Alias terlalu pendek untuk dicocokkan dengan aman: ${short}`);
    const others = (await getFigureOptions()).filter((f) => f.id !== id);
    const clash = add.flatMap((a) => others.filter((f) => [f.name, ...f.aliases].some((x) => fold(x) === fold(a))).map((f) => `“${a}” juga ${f.name}`));
    await saveFigure(id, (f) => {
      for (const a of add) if (fold(a) !== fold(f.name) && !f.aliases.some((x) => fold(x) === fold(a))) f.aliases.push(a);
    });
    await redrawFigure(s, `🏷 Alias ditambahkan: ${add.map(esc).join(", ")}.${clash.length ? `\n⚠️ ${esc(clash.join("; "))} — nama itu jadi rebutan dua tokoh.` : ""}`);
  } else if (mode === "office") {
    const [role = "", orgTyped = "", ...rest] = t.split(",").map((x) => x.trim());
    if (!role || !orgTyped) throw new Error("Tulis keduanya, dipisah koma: jabatan, organisasi. Ketuk 💼 lagi.");
    const { org, note } = await orgMatch(orgTyped);
    await saveFigure(id, (f) => {
      f.positions = [{ role, org, period: rest.join(", ") }, ...f.positions.filter((p) => !(fold(p.role) === fold(role) && orgKey(p.org) === orgKey(org)))].slice(0, 20);
    });
    await redrawFigure(s, `💼 Jabatan utama: <b>${esc(role)} – ${esc(org)}</b>.\n${note}`);
  } else if (mode === "merge") {
    const found = findFigures(await getFigureOptions(), t, id).slice(0, 6);
    s.fig.picks = found.map((f) => f.id);
    const rows: Keyboard = found.map((f, i) => [{ text: clip(`🔀 ${i + 1}. ${f.name}`, 30), callback_data: `f:m:${i}` }]);
    rows.push([{ text: "← Kembali", callback_data: "f:r" }]);
    const list = found.map((f, i) => `<b>${i + 1}.</b> <b>${esc(f.name)}</b>${f.title ? ` – ${esc(f.title)}` : ""}`).join("\n");
    await edit(s.fig.msg, found.length ? `<b>🔀 Sama dengan siapa?</b> Hasil “${esc(t)}”:\n${list}` : `<b>🔀 Tidak ada tokoh yang cocok dengan “${esc(t)}”.</b>`, rows);
  }
}

/** The 👤 buttons ("f:…"); returns the note for the tap. */
async function onFigure(s: State, action: string, arg: string | undefined, msgId: number): Promise<string> {
  if (action === "x") {
    await drop(msgId);
    if (msgId === s.fig.msg) s.fig = {};
    return "";
  }
  if (action === "q") {
    s.fig.msg = msgId;
    await askFigure(s, "search", msgId);
    return "";
  }
  if (msgId !== s.fig.msg) throw new Error("Kartu ini sudah diganti; buka lagi dengan /tokoh.");
  const i = Number(arg);
  if (action === "o") {
    const id = s.fig.found?.[i];
    if (!id) throw new Error("Daftar ini sudah kedaluwarsa; cari lagi.");
    s.fig.oldName = undefined;
    await edit(msgId, ...(await figureCard(s, id)));
    return "";
  }
  const id = s.fig.id;
  if (!id) throw new Error("Pilih tokohnya lagi.");
  if (action === "r") {
    await redrawFigure(s);
    return "";
  }
  if (action === "n" || action === "a" || action === "j" || action === "mt") {
    await askFigure(s, action === "n" ? "name" : action === "a" ? "alias" : action === "j" ? "office" : "merge", msgId);
    return "";
  }
  if (action === "ka") {
    const old = s.fig.oldName;
    if (!old) throw new Error("Tidak ada nama lama.");
    await saveFigure(id, (f) => {
      if (old.length >= 3 && !f.aliases.some((a) => fold(a) === fold(old))) f.aliases.push(old);
    });
    s.fig.oldName = undefined;
    await redrawFigure(s, `🏷 “${esc(old)}” disimpan sebagai alias.`);
    return "Disimpan";
  }
  if (action === "ax" || action === "jx" || action === "jm") {
    let what = "";
    await saveFigure(id, (f) => {
      if (action === "ax") {
        what = f.aliases[i] ?? "";
        if (!what) throw new Error("Alias ini sudah tidak ada.");
        f.aliases.splice(i, 1);
      } else {
        const p = f.positions[i];
        if (!p) throw new Error("Jabatan ini sudah tidak ada.");
        what = positionTitle(p);
        f.positions.splice(i, 1);
        if (action === "jm") f.positions.unshift(p);
      }
    });
    await redrawFigure(s, action === "ax" ? `✖ Alias “${esc(what)}” dihapus.` : action === "jx" ? `✖ Jabatan “${esc(what)}” dihapus.` : `⭐ Jabatan utama: ${esc(what)}.`);
    return "Disimpan";
  }
  if (action === "m") {
    const other = s.fig.picks?.[i];
    if (!other) throw new Error("Pilihan ini sudah kedaluwarsa.");
    const all = new Map((await getFigureOptions()).map((f) => [f.id, f]));
    const a = all.get(id);
    const b = all.get(other);
    if (!a || !b) throw new Error("Salah satu tokoh sudah tidak aktif.");
    s.fig.target = other;
    // Catatan as the card counts them: their own and those they are Terkait in.
    const [na, nb] = await Promise.all([getFigureFull(id), getFigureFull(other)]).then((x) => x.map((f) => f?.recordCount ?? 0));
    const [keep, fold_] = nb > na ? [b, a] : [a, b];
    await edit(msgId, [
      "<b>🔀 Jadikan satu tokoh?</b>",
      `• <b>${esc(a.name)}</b>${a.title ? ` – ${esc(a.title)}` : ""} · ${na} catatan`,
      `• <b>${esc(b.name)}</b>${b.title ? ` – ${esc(b.title)}` : ""} · ${nb} catatan`,
      "",
      "Catatan, kutipan dan namanya pindah ke yang dipertahankan; nama yang lain jadi alias, tokohnya dinonaktifkan. <b>Tidak bisa dibatalkan.</b>",
      `<i>Saran: pertahankan ${esc(keep.name)}, yang catatannya lebih banyak; ${esc(fold_.name)} digabung ke sana.</i>`,
    ].join("\n"), [
      [{ text: clip(`✅ Pertahankan ${a.name}`, 32), callback_data: "f:mk:0" }],
      [{ text: clip(`✅ Pertahankan ${b.name}`, 32), callback_data: "f:mk:1" }],
      [{ text: "← Batal", callback_data: "f:r" }],
    ]);
    return "";
  }
  if (action === "mk") {
    const other = s.fig.target;
    if (!other) throw new Error("Pilih tokohnya lagi.");
    const [from, into] = arg === "1" ? [id, other] : [other, id];
    await mergeFigure(from, into);
    s.fig.target = undefined;
    s.fig.oldName = undefined;
    await edit(msgId, ...(await figureCard(s, into, "🔀 Digabung: sekarang satu tokoh.")));
    return "Digabung";
  }
  if (action === "b") {
    const full = await getFigureFull(id);
    if (!full) throw new Error("Tokoh ini tidak ditemukan.");
    const own = full.records.filter((r) => r.filed && r.curated !== "rejected").length;
    await edit(msgId, [
      `<b>🚫 “${esc(full.person.name)}” bukan orang?</b>`,
      "Untuk tempat, jabatan, lembaga atau potongan judul yang terbaca sebagai tokoh.",
      `Dinonaktifkan, dilepas dari semua peristiwa${own ? `, dan ${own}${own >= 60 ? "+" : ""} catatannya diturunkan` : ""}. Namanya tidak ditawarkan lagi. <b>Tidak bisa dibatalkan dari sini.</b>`,
    ].join("\n"), [[{ text: "🚫 Ya, bukan orang", callback_data: "f:by" }, { text: "← Batal", callback_data: "f:r" }]]);
    return "";
  }
  if (action === "by") {
    const name = (await getFigureFull(id))?.person.name ?? id;
    const out = await removeNotAPerson(id);
    s.fig = {};
    const taken = /(\d+) records taken down/.exec(out)?.[1];
    await edit(msgId, `🚫 <b>${esc(name)}</b>: bukan orang, dinonaktifkan${taken && taken !== "0" ? `; ${taken} catatan diturunkan` : ""}.`);
    return "Dinonaktifkan";
  }
  throw new Error("Tombol tidak dikenal.");
}

// --- Organisasi

type OrgHit = { kind: "r"; org: Organization } | { kind: "u"; name: string; figures: number };

async function orgCard(s: State, id: number, note = ""): Promise<[string, Keyboard]> {
  const org = (await getOrganizations()).find((o) => o.id === id);
  if (!org) throw new Error("Organisasi ini sudah tidak ada.");
  s.org.id = id;
  s.org.draft = undefined;
  const lines = [
    "<b>🏢 ORGANISASI</b>",
    `<b>${esc(org.name)}</b>${org.short_name ? ` · ${esc(org.short_name)}` : ""}`,
    `Jenis: ${org.kind ? esc(ORG_KIND_LABEL[org.kind] ?? org.kind) : "<i>belum</i>"} · ${org.figures} tokoh`,
    `Alias: ${org.aliases.length ? org.aliases.map((a, i) => `${i + 1}. ${esc(a)}`).join(" · ") : "<i>tidak ada</i>"}`,
    "<i>Perubahan dipakai pipeline di proses berikutnya.</i>",
  ];
  if (note) lines.push("", note);
  const rows: Keyboard = [
    [{ text: "✏️ Nama lengkap", callback_data: "g:n" }, { text: "✏️ Singkatan", callback_data: "g:s" }],
    [{ text: "🏷 + Alias", callback_data: "g:a" }, { text: "📂 Jenis", callback_data: "g:k" }],
    ...numbered(Math.min(org.aliases.length, 8), "✖ Alias", (i) => `g:ax:${i}`),
  ];
  if (org.short_name) rows.push([{ text: `✖ Singkatan ${clip(org.short_name, 20)}`, callback_data: "g:sx" }]);
  rows.push([{ text: "🗑 Hapus", callback_data: "g:d" }, { text: "Tutup", callback_data: "g:x" }]);
  return [lines.join("\n"), rows];
}

/** An organisation name offices use that the registry does not know yet. */
function unlinkedCard(s: State, name: string, figures: number, note = ""): [string, Keyboard] {
  s.org.id = undefined;
  s.org.draft = name;
  const text = [
    "<b>🏢 ORGANISASI</b> · <i>belum terdaftar</i>",
    `<b>${esc(name)}</b> · dipakai ${figures} tokoh`,
    "",
    "Daftarkan apa adanya, dengan nama lengkap dan singkatan yang benar, atau jadikan alias organisasi yang sudah terdaftar (mis. <i>Kemendag</i> → Kementerian Perdagangan). Kalau bukan organisasi (dapil, komisi, bidang), perbaiki jabatan tokoh yang memakainya.",
    ...(note ? ["", note] : []),
  ].join("\n");
  return [text, [
    [{ text: clip(`➕ Daftarkan “${name}”`, 32), callback_data: "g:add" }],
    [{ text: "✏️ Daftarkan: nama, singkatan", callback_data: "g:addt" }],
    [{ text: "🏷 Alias dari…", callback_data: "g:al" }],
    // "Dapil Banten III", "Komisi IV": not an organisation; the offices need putting right.
    [{ text: "👤 Tokoh yang memakainya", callback_data: "g:u" }],
    [{ text: "Tutup", callback_data: "g:x" }],
  ]];
}

async function findOrgs(q: string): Promise<OrgHit[]> {
  const t = fold(q);
  const [registry, unlinked] = await Promise.all([getOrganizations(), getUnlinkedOrgs()]);
  const hits: { hit: OrgHit; n: number }[] = [];
  for (const o of registry) {
    const names = [o.name, o.short_name ?? "", ...o.aliases].map(fold).filter(Boolean);
    const n = names.includes(t) ? 100 : names.some((x) => x.startsWith(t)) ? 80 : names.some((x) => x.includes(t)) ? 60 : 0;
    if (n) hits.push({ hit: { kind: "r", org: o }, n: n + Math.min(o.figures, 30) / 100 });
  }
  for (const u of unlinked) {
    const x = fold(u.org);
    const n = x === t ? 90 : x.includes(t) ? 50 : 0;
    if (n) hits.push({ hit: { kind: "u", name: u.org, figures: u.figures }, n: n + Math.min(u.figures, 30) / 100 });
  }
  return hits.sort((a, b) => b.n - a.n).slice(0, FOUND).map((h) => h.hit);
}

/** A list of organisations to open, as a new /organisasi message. */
async function orgList(s: State, head: string, hits: OrgHit[], typed = ""): Promise<void> {
  if (s.org.msg) await drop(s.org.msg);
  s.org = { found: hits.map((h) => (h.kind === "r" ? `r${h.org.id}` : `u${h.name}`)) };
  const list = hits.map((h, i) => h.kind === "r"
    ? `<b>${i + 1}.</b> ${esc(h.org.name)}${h.org.short_name ? ` · ${esc(h.org.short_name)}` : ""} · ${h.org.figures} tokoh`
    : `<b>${i + 1}.</b> ${esc(h.name)} · ${h.figures} tokoh · <i>belum terdaftar</i>`).join("\n");
  const rows: Keyboard = hits.map((h, i) => [{ text: clip(`${i + 1}. ${h.kind === "r" ? h.org.short_name || h.org.name : h.name}`, 30), callback_data: `g:o:${i}` }]);
  if (typed && !hits.some((h) => fold(h.kind === "r" ? h.org.name : h.name) === fold(typed))) {
    s.org.draft = typed;
    rows.push([{ text: clip(`➕ Daftarkan “${typed}”`, 32), callback_data: "g:new" }]);
  }
  rows.push([{ text: "🔎 Cari organisasi", callback_data: "g:q" }, { text: "Tutup", callback_data: "g:x" }]);
  s.org.msg = await send(hits.length ? `${head}\n${list}` : `${head}\n<i>tidak ada</i>`, rows);
}

/** /organisasi [nama]: a search, or the names offices use most that no organisation matches. */
async function organisasiCommand(s: State, q: string): Promise<void> {
  if (q) return orgList(s, `<b>🏢 Organisasi “${esc(q)}”</b>`, await findOrgs(q), q.slice(0, 200));
  const unlinked = (await getUnlinkedOrgs()).slice(0, FOUND);
  await orgList(s, "<b>🏢 Belum terdaftar, paling banyak dipakai</b> <i>(cari: /organisasi nama)</i>",
    unlinked.map((u) => ({ kind: "u", name: u.org, figures: u.figures })));
}

async function askOrg(s: State, mode: NonNullable<State["org"]["mode"]>, msgId: number): Promise<void> {
  const ask: Record<typeof mode, [string, string]> = {
    name: ["Ketik nama lengkap organisasinya (mis. <i>Kementerian Perdagangan</i>).", "Nama lengkap"],
    short: ["Ketik singkatannya (mis. <i>Kemendag</i>).", "Singkatan"],
    alias: ["Ketik alias yang ditambahkan, dipisah titik koma (mis. <i>Kemendag RI; Kementerian Dagang</i>).", "Alias"],
    add: ["Ketik <i>nama lengkap, singkatan</i> (singkatan boleh kosong), mis. <i>PT Pertamina (Persero), Pertamina</i>.", "Nama lengkap, singkatan"],
    aliasOf: ["Ketik nama organisasi terdaftar yang dimaksud.", "Organisasi"],
    search: ["Ketik nama organisasi yang dicari.", "Organisasi"],
  };
  s.org.mode = mode;
  s.org.prompt = await send(ask[mode][0], undefined, {
    reply_parameters: { message_id: msgId, allow_sending_without_reply: true },
    reply_markup: { force_reply: true, input_field_placeholder: ask[mode][1] },
  });
}

/** Saves the organisation with one thing changed. */
async function saveOrg(id: number, change: (o: { name: string; short: string | null; aliases: string[]; kind: string | null }) => void): Promise<void> {
  const org = (await getOrganizations()).find((o) => o.id === id);
  if (!org) throw new Error("Organisasi ini sudah tidak ada.");
  const o = { name: org.name, short: org.short_name, aliases: [...org.aliases], kind: org.kind };
  change(o);
  await saveOrganization(id, o.name, o.short, o.aliases, o.kind);
}

const orgIdByName = async (name: string) => (await getOrganizations()).find((o) => orgKey(o.name) === orgKey(name))?.id;

/** Registers a name, then shows its card. */
async function addOrg(s: State, name: string, short: string | null, msgId: number): Promise<void> {
  await saveOrganization(null, name, short, [], null);
  const id = await orgIdByName(name);
  if (!id) throw new Error("Organisasinya tidak tersimpan.");
  await edit(msgId, ...(await orgCard(s, id, `➕ Didaftarkan. Pilih jenisnya dengan 📂 Jenis.`)));
}

async function onOrgReply(s: State, typed: string): Promise<void> {
  const mode = s.org.mode;
  s.org.mode = undefined;
  const t = typed.replace(/\s+/g, " ").trim();
  if (mode === "search") return organisasiCommand(s, t);
  const msg = s.org.msg;
  if (!msg) throw new Error("Kartu organisasinya sudah ditutup; buka lagi dengan /organisasi.");
  if (mode === "add") {
    const at = t.lastIndexOf(",");
    const [name, short] = at < 0 ? [t, ""] : [t.slice(0, at).trim(), t.slice(at + 1).trim()];
    if (name.length < 2) throw new Error("Tulis nama lengkapnya.");
    const was = s.org.draft;
    await addOrg(s, name, short || null, msg);
    // The name offices used becomes an alias when it is neither of the two.
    if (was && ![name, short].some((x) => x && orgKey(x) === orgKey(was)) && s.org.id) {
      const id = s.org.id;
      await saveOrg(id, (o) => o.aliases.push(was));
      await edit(msg, ...(await orgCard(s, id, `➕ Didaftarkan; “${esc(was)}” jadi aliasnya. Pilih jenisnya dengan 📂 Jenis.`)));
    }
    return;
  }
  if (mode === "aliasOf") {
    const hits = (await findOrgs(t)).filter((h): h is Extract<OrgHit, { kind: "r" }> => h.kind === "r").slice(0, 6);
    s.org.picks = hits.map((h) => String(h.org.id));
    const rows: Keyboard = hits.map((h, i) => [{ text: clip(`🏷 ${i + 1}. ${h.org.short_name || h.org.name}`, 30), callback_data: `g:alp:${i}` }]);
    rows.push([{ text: "← Kembali", callback_data: "g:r" }]);
    await edit(msg, hits.length
      ? `<b>🏷 “${esc(s.org.draft ?? "")}” alias dari?</b> Hasil “${esc(t)}”:\n${hits.map((h, i) => `<b>${i + 1}.</b> ${esc(h.org.name)}${h.org.short_name ? ` · ${esc(h.org.short_name)}` : ""}`).join("\n")}`
      : `<b>🏷 Tidak ada organisasi terdaftar yang cocok dengan “${esc(t)}”.</b>`, rows);
    return;
  }
  const id = s.org.id;
  if (!id) throw new Error("Pilih organisasinya lagi.");
  if (mode === "name" || mode === "short") {
    if (!t || t.length > (mode === "name" ? 200 : 60)) throw new Error("Terlalu panjang.");
    await saveOrg(id, (o) => {
      if (mode === "name") {
        if (orgKey(o.name) !== orgKey(t) && !o.aliases.some((a) => orgKey(a) === orgKey(o.name))) o.aliases.push(o.name);
        o.name = t;
      } else o.short = t;
    });
    await edit(msg, ...(await orgCard(s, id, mode === "name" ? `✏️ Nama lengkap: <b>${esc(t)}</b>; nama lama jadi alias.` : `✏️ Singkatan: <b>${esc(t)}</b>.`)));
  } else if (mode === "alias") {
    const add = t.split(";").map((a) => a.trim()).filter(Boolean);
    await saveOrg(id, (o) => {
      for (const a of add) if (!o.aliases.some((x) => orgKey(x) === orgKey(a))) o.aliases.push(a);
    });
    await edit(msg, ...(await orgCard(s, id, `🏷 Alias ditambahkan: ${add.map(esc).join("; ")}.`)));
  }
}

/** The 🏢 buttons ("g:…"); returns the note for the tap. */
async function onOrg(s: State, action: string, arg: string | undefined, msgId: number): Promise<string> {
  if (action === "x") {
    await drop(msgId);
    if (msgId === s.org.msg) s.org = {};
    return "";
  }
  if (action === "q") {
    s.org.msg = msgId;
    await askOrg(s, "search", msgId);
    return "";
  }
  if (msgId !== s.org.msg) throw new Error("Kartu ini sudah diganti; buka lagi dengan /organisasi.");
  const i = Number(arg);
  if (action === "o") {
    const pick = s.org.found?.[i];
    if (!pick) throw new Error("Daftar ini sudah kedaluwarsa; cari lagi.");
    if (pick[0] === "r") await edit(msgId, ...(await orgCard(s, Number(pick.slice(1)))));
    else {
      const name = pick.slice(1);
      const uses = (await getUnlinkedOrgs()).find((u) => u.org === name)?.figures ?? 0;
      await edit(msgId, ...unlinkedCard(s, name, uses));
    }
    return "";
  }
  if (action === "new" || action === "add") {
    const name = s.org.draft;
    if (!name) throw new Error("Ketik namanya lagi.");
    await addOrg(s, name, null, msgId);
    return "Didaftarkan";
  }
  if (action === "addt" || action === "al") {
    if (!s.org.draft) throw new Error("Pilih namanya lagi.");
    await askOrg(s, action === "addt" ? "add" : "aliasOf", msgId);
    return "";
  }
  if (action === "u") {
    const name = s.org.draft;
    if (!name) throw new Error("Pilih namanya lagi.");
    const rows = await lquery<{ id: string }>(
      `SELECT DISTINCT f.id FROM figures f, json_each(CASE WHEN json_valid(f.positions) THEN f.positions ELSE '[]' END) p
        WHERE f.active AND lower(trim(json_extract(p.value, '$.org'))) = lower(trim(?)) LIMIT ${FOUND}`, [name]
    );
    const byId = new Map((await getFigureOptions()).map((f) => [f.id, f]));
    await figureList(s, `<b>👤 Tokoh dengan jabatan di “${esc(name)}”</b>`, rows.map((r) => byId.get(r.id)).filter((f): f is FigureOption => Boolean(f)));
    return "";
  }
  if (action === "alp") {
    const id = Number(s.org.picks?.[i]);
    const name = s.org.draft;
    if (!id || !name) throw new Error("Pilihan ini sudah kedaluwarsa.");
    await saveOrg(id, (o) => {
      if (!o.aliases.some((a) => orgKey(a) === orgKey(name))) o.aliases.push(name);
    });
    await edit(msgId, ...(await orgCard(s, id, `🏷 “${esc(name)}” jadi alias organisasi ini.`)));
    return "Disimpan";
  }
  if (action === "r") {
    if (s.org.id) await edit(msgId, ...(await orgCard(s, s.org.id)));
    else if (s.org.draft) {
      const uses = (await getUnlinkedOrgs()).find((u) => u.org === s.org.draft)?.figures ?? 0;
      await edit(msgId, ...unlinkedCard(s, s.org.draft, uses));
    }
    return "";
  }
  const id = s.org.id;
  if (!id) throw new Error("Pilih organisasinya lagi.");
  if (action === "n" || action === "s" || action === "a") {
    await askOrg(s, action === "n" ? "name" : action === "s" ? "short" : "alias", msgId);
    return "";
  }
  if (action === "sx" || action === "ax") {
    await saveOrg(id, (o) => {
      if (action === "sx") o.short = null;
      else o.aliases.splice(i, 1);
    });
    await edit(msgId, ...(await orgCard(s, id, action === "sx" ? "✖ Singkatan dihapus." : "✖ Alias dihapus.")));
    return "Disimpan";
  }
  if (action === "k") {
    const kinds = Object.keys(ORG_KIND_LABEL);
    const rows: Keyboard = [];
    kinds.forEach((k, j) => {
      if (j % 3 === 0) rows.push([]);
      rows[rows.length - 1].push({ text: ORG_KIND_LABEL[k], callback_data: `g:kk:${j}` });
    });
    rows.push([{ text: "← Kembali", callback_data: "g:r" }]);
    await edit(msgId, "<b>📂 Jenis organisasinya?</b>", rows);
    return "";
  }
  if (action === "kk") {
    const kind = Object.keys(ORG_KIND_LABEL)[i];
    if (!kind) throw new Error("Jenis tidak dikenal.");
    await saveOrg(id, (o) => {
      o.kind = kind;
    });
    await edit(msgId, ...(await orgCard(s, id, `📂 Jenis: ${esc(ORG_KIND_LABEL[kind])}.`)));
    return "Disimpan";
  }
  if (action === "d") {
    const org = (await getOrganizations()).find((o) => o.id === id);
    await edit(msgId, `<b>🗑 Hapus ${esc(org?.name ?? "organisasi ini")} dari daftar?</b>\nJabatan tokoh tidak berubah; nama itu hanya tidak lagi dikenali sebagai organisasi terdaftar.`,
      [[{ text: "🗑 Ya, hapus", callback_data: "g:dy" }, { text: "← Batal", callback_data: "g:r" }]]);
    return "";
  }
  if (action === "dy") {
    const name = (await getOrganizations()).find((o) => o.id === id)?.name ?? "";
    await deleteOrganization(id);
    s.org = {};
    await edit(msgId, `🗑 <b>${esc(name)}</b> dihapus dari daftar organisasi.`);
    return "Dihapus";
  }
  throw new Error("Tombol tidak dikenal.");
}

// ---------------------------------------------------------------------------
// Tulis ulang: a catatan written again by the local model, asked for from the
// 📋 view (a note on what is wrong, or "about the figure, not by them"), and
// every draft that is ready — asked for here, in /kurasi or by the pipeline —
// sent as a card to take or throw away, as /kurasi's rework panel does.

const FRAMING_LABEL: Record<string, string> = { own: "perbuatan tokoh sendiri", about: "liputan tentang tokoh, bukan pelaku" };

interface DraftRow {
  id: number;
  event_id: number;
  note: string | null;
  framing: string | null;
  new_figure_id: string | null;
  to_peristiwa: number;
  status: string;
  error: string | null;
  before: string | null;
  after: string | null;
}

const snap = (raw: string | null): ReworkSnapshot | null => {
  try {
    return raw ? (JSON.parse(raw) as ReworkSnapshot) : null;
  } catch {
    return null;
  }
};

async function draftText(r: DraftRow, note = ""): Promise<string> {
  const names = new Map((await getFigureOptions()).map((f) => [f.id, f.name]));
  const who = (id: string | null) => (id ? names.get(id) ?? id : "");
  const line = (x: ReworkSnapshot) => [
    x.kind === "peristiwa" ? "Peristiwa" : `Catatan ${who(x.figure_id)}`.trim(),
    x.kind === "record" ? FRAMING_LABEL[x.framing === "about" ? "about" : "own"] : null,
    x.event_type,
  ].filter(Boolean).map((t) => esc(String(t))).join(" · ");
  const asked = [
    r.note ? `“${esc(clip(r.note, 300))}”` : null,
    r.framing ? `sudut pandang: ${esc(FRAMING_LABEL[r.framing] ?? r.framing)}` : null,
    r.new_figure_id ? `pindah ke ${esc(who(r.new_figure_id))}` : null,
    r.to_peristiwa ? "jadikan peristiwa" : null,
  ].filter(Boolean).join(" · ");
  const lines = [`<b>✍️ DRAF TULIS ULANG</b> · catatan #${r.event_id}`, asked ? `Diminta: ${asked}` : ""];
  const [b, a] = [snap(r.before), snap(r.after)];
  if (r.status === "failed") lines.push("", `❌ <b>Gagal:</b> ${esc(clip(r.error ?? "", 400))}${r.error?.includes("Ollama") ? "\nJalankan Ollama, lalu minta lagi." : ""}`);
  for (const [head, x] of [["Sekarang", b], [r.status === "accepted" ? "Diterima" : "Draf baru", a]] as const) {
    if (!x) continue;
    lines.push("", `<b>${head}</b> · <i>${line(x)}</i>`, `<b>${esc(x.title ?? "")}</b>`, esc(clip(x.summary_text ?? "", 900)));
  }
  // The articles the model was given, numbered as it cites them: by
  // publication, as jejak/summarize.py draft_event reads them.
  const articles = await lquery<{ source: string; url: string; title: string | null; published_at: string | null }>(
    `SELECT source, url, title, published_at FROM articles WHERE event_id = ? ORDER BY published_at, id`, [r.event_id]
  );
  if (articles.length) {
    const href = (u: string) => esc(u).replace(/"/g, "&quot;");
    lines.push("", "<b>Sumber</b>", ...articles.slice(0, 8).map((a, i) =>
      `[${i + 1}] <a href="${href(a.url)}">${esc(a.source)} · ${esc(clip(a.title ?? a.url, 80))}</a>${a.published_at ? ` · ${esc(day(a.published_at))}` : ""}`));
    if (articles.length > 8) lines.push(`<i>…dan ${articles.length - 8} artikel lain.</i>`);
  }
  if (note) lines.push("", note);
  return lines.filter((l, i) => l !== "" || i > 1).join("\n");
}

const draftKeyboard = (r: DraftRow): Keyboard => r.status === "ready"
  ? [[{ text: "✅ Pakai draf ini", callback_data: `w:${r.id}:y` }, { text: "🗑 Buang", callback_data: `w:${r.id}:n` }]]
  : r.status === "failed" ? [[{ text: "🗑 Hapus", callback_data: `w:${r.id}:n` }]] : [];

const getDraft = (id: number) => lqueryOne<DraftRow>(
  `SELECT id, event_id, note, framing, new_figure_id, to_peristiwa, status, error, before, after FROM rework_requests WHERE id = ?`, [id]
);

/** Drafts finished since the bot last looked, each as a card (once). */
async function sendDrafts(s: State, all = false): Promise<number> {
  const rows = await lquery<DraftRow>(
    `SELECT id, event_id, note, framing, new_figure_id, to_peristiwa, status, error, before, after
       FROM rework_requests WHERE status IN ('ready', 'failed') ORDER BY id`
  ).catch(() => [] as DraftRow[]);
  let n = 0;
  for (const r of rows) {
    if (s.drafts[r.id] && !all) continue;
    if (s.drafts[r.id]) await drop(s.drafts[r.id]);
    s.drafts[r.id] = await send(await draftText(r), draftKeyboard(r));
    n++;
  }
  return n;
}

async function onDraft(s: State, id: number, code: string | undefined, msgId: number): Promise<string> {
  const r = await getDraft(id);
  if (!r) throw new Error("Draf ini sudah tidak ada.");
  if (r.status !== "ready" && r.status !== "failed") {
    await edit(msgId, await draftText(r, r.status === "accepted" ? "✅ Sudah dipakai." : "🗑 Sudah dibuang."));
    throw new Error("Draf ini sudah diputuskan.");
  }
  if (code === "y") {
    if (r.status !== "ready") throw new Error("Draf yang gagal tidak bisa dipakai.");
    await acceptRework(id);
    await edit(msgId, await draftText((await getDraft(id))!, "✅ Dipakai: catatannya sekarang seperti draf ini."));
    return "Draf dipakai";
  }
  if (code === "n") {
    await discardRework(id);
    await edit(msgId, await draftText((await getDraft(id))!, "🗑 Dibuang; catatannya tetap seperti sekarang."));
    return "Dibuang";
  }
  throw new Error("Tombol tidak dikenal.");
}

/** The view's ✍️ menu: what to ask the model for. */
async function showReworkMenu(s: State, p: Point): Promise<void> {
  const item = await getItem(p.event_id);
  if (!item) throw new Error("Catatannya tidak ditemukan.");
  const rows: Keyboard = [[{ text: "📝 Tulis catatan untuk model", callback_data: `vwn:${p.id}` }]];
  if (item.kind === "record") {
    rows.push([{ text: "🔄 Liputan tentang tokoh, bukan perbuatannya", callback_data: `vwa:${p.id}` }]);
    rows.push([{ text: "👤 Pindah ke tokoh lain", callback_data: `vwf:${p.id}` }]);
  }
  rows.push([{ text: "← Kembali", callback_data: `v:${p.id}` }]);
  await edit(s.view[p.id], [
    "<b>✍️ Tulis ulang catatan ini?</b>",
    `<i>${esc(item.title ?? "")}</i>`,
    "",
    "Model lokal menulis draf baru dengan permintaanmu, biasanya kurang dari semenit; drafnya datang di sini untuk dipakai atau dibuang. Sampai itu catatannya tidak berubah.",
  ].join("\n"), rows);
}

async function askRework(eventId: number, note: string | null, framing: "about" | null, newFigureId: string | null = null): Promise<void> {
  await requestRework(eventId, { note, framing, newFigureId, toPeristiwa: false });
}

/** The figures a name typed for "pindah ke" matched, on the view. */
async function showReworkFigures(s: State, p: Point, typed: string): Promise<void> {
  const item = await getItem(p.event_id);
  const found = findFigures(await getFigureOptions(), typed.trim().slice(0, 200), item?.figure_id).slice(0, 6);
  s.picks[`w${p.id}`] = found.map((f) => f.id);
  const rows: Keyboard = found.map((f, i) => [{ text: clip(`👤 ${i + 1}. ${f.name}`, 30), callback_data: `vwp:${p.id}:${i}` }]);
  rows.push([{ text: "🔎 Cari lagi", callback_data: `vwf:${p.id}` }, { text: "← Kembali", callback_data: `vw:${p.id}` }]);
  const list = found.map((f, i) => `<b>${i + 1}.</b> <b>${esc(f.name)}</b>${f.title ? ` – ${esc(f.title)}` : ""}`).join("\n");
  await edit(s.view[p.id], found.length
    ? `<b>👤 Catatan siapa ini?</b> Hasil “${esc(typed)}”:\n${list}\n\n<i>Model menulis ulang sebagai catatan tokoh itu; drafnya datang di sini.</i>`
    : `<b>👤 Tidak ada tokoh yang cocok dengan “${esc(typed)}”.</b> Tokoh baru dibuat dari /kandidat atau kartu pembicara.`, rows);
}

// ---------------------------------------------------------------------------
// Publish runs: scripts/publish_local.log read as it grows, and a message when
// a run stops early or a stage fails, so a broken run is not found days later.

const PUBLISH_LOG = process.env.PUBLISH_LOG ?? join(dirname(resolve(DB_FILE)), "scripts", "publish_local.log");
// The run's own log lines (scripts/publish_local.sh log()) that mean trouble.
const TROUBLE = /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] .*(failed|aborting|stopping it|stale lock)/i;

async function watchPublish(s: State): Promise<void> {
  let size: number;
  try {
    size = statSync(PUBLISH_LOG).size;
  } catch {
    return; // no log here (a copy of the db, another machine): nothing to watch
  }
  if (s.publish.at === undefined || size < s.publish.at) {
    // First start, or the log was cut: from here on, not its history.
    s.publish = { at: size, trouble: [] };
    return;
  }
  if (size === s.publish.at) return;
  const fd = openSync(PUBLISH_LOG, "r");
  const buf = Buffer.alloc(Math.min(size - s.publish.at, 4_000_000));
  readSync(fd, buf, 0, buf.length, s.publish.at);
  closeSync(fd);
  const chunk = buf.toString("utf8");
  // Up to the last full line; the rest is read next time.
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return;
  s.publish.at += Buffer.byteLength(chunk.slice(0, end + 1));
  for (const line of chunk.slice(0, end).split("\n")) {
    if (line.includes("=== publish_local starting ===")) {
      s.publish.trouble = [];
      s.publish.started = line.slice(1, 20);
    } else if (TROUBLE.test(line)) {
      s.publish.trouble.push(line.replace(/^\[[^\]]*\]\s*/, ""));
      if (/aborting/i.test(line)) {
        await send(`⚠️ <b>Proses publikasi berhenti</b>${s.publish.started ? ` (mulai ${esc(s.publish.started)})` : ""}:\n${esc(clip(line, 300))}`);
        s.publish.trouble = [];
      }
    } else if (line.includes("=== publish_local done ===")) {
      if (s.publish.trouble.length) {
        await send([
          `⚠️ <b>Proses publikasi selesai dengan masalah</b>${s.publish.started ? ` (mulai ${esc(s.publish.started)})` : ""}:`,
          ...s.publish.trouble.slice(0, 10).map((t) => `• ${esc(clip(t, 200))}`),
          "<i>Rinciannya di scripts/publish_local.log.</i>",
        ].join("\n"));
      }
      s.publish.trouble = [];
    }
  }
}

// ---------------------------------------------------------------------------
// Corrections: the right answer instead, saved as /kurasi's "koreksi".
//
// Peristiwa and lini list the events /kurasi offers, on the card itself; a
// typed reply searches titles. Terkait, tentang and pembicara ask for a name
// as a Telegram reply and list the figures it matches, or create the figure,
// as "Tokoh baru" does in /kurasi.

const PAGE = 6;
const FOUND = 8;

const figureKind = (p: Point) => p.kind === "terkait" || p.kind === "tentang" || p.kind === "pembicara";

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The event a lini point already proposes, which a correction must not repeat. */
const liniOther = (p: Point) => (p.proposal.earlier_id === p.event_id ? p.proposal.later_id : p.proposal.earlier_id);

/** Events a peristiwa or lini point can be corrected to; `q` searches titles instead. */
async function eventChoices(p: Point, q = ""): Promise<{ id: number; label: string }[]> {
  const item = await getItem(p.event_id);
  if (!item) return [];
  const label = (e: { title: string | null; event_date: string | null }, extra = "") =>
    clip(`${day(e.event_date)}${extra} · ${e.title ?? "tanpa judul"}`, 140);
  if (p.kind === "peristiwa") {
    const rows = q
      ? await lquery<{ event_id: number; title: string | null; event_date: string | null }>(
          `SELECT id AS event_id, title, event_date FROM events
            WHERE kind = 'peristiwa' AND curated IS NOT 'rejected' AND title LIKE '%' || ? || '%' ESCAPE '\\'
            ORDER BY abs(julianday(event_date) - julianday(?)) LIMIT 40`,
          [q.replace(/[%_\\]/g, "\\$&"), item.event_date ?? new Date().toISOString()]
        )
      : item.nearby;
    return rows.filter((e) => e.event_id !== p.proposal.peristiwa_id).map((e) => ({ id: e.event_id, label: label(e) }));
  }
  const other = liniOther(p);
  return (await getFollowupCandidates(item, q))
    .filter((e) => e.event_id !== other)
    .slice(0, 40)
    .map((e) => ({ id: e.event_id, label: label(e, e.before ? " · sebelum" : " · sesudah") }));
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Tracked figures matching a typed name: name first, then aliases, then office. */
function findFigures(all: FigureOption[], q: string, skip: string | null | undefined): FigureOption[] {
  const t = fold(q);
  if (t.length < 2) return [];
  const score = (f: FigureOption) => {
    const name = fold(f.name);
    const aliases = f.aliases.map(fold);
    if (name === t || aliases.includes(t)) return 100;
    if (name.startsWith(t)) return 80;
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name)) return 70;
    if (name.includes(t)) return 60;
    if (aliases.some((a) => a.includes(t))) return 50;
    if (fold(`${f.title} ${f.role ?? ""}`).includes(t)) return 20;
    return 0;
  };
  return all
    .filter((f) => f.id !== skip)
    .map((f) => ({ f, n: score(f) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.f.records - a.f.records)
    .slice(0, FOUND)
    .map((x) => x.f);
}

/** The card turned into a list of choices, with paging and a way back. */
async function showEvents(s: State, p: Point, msgId: number, page: number, q = ""): Promise<void> {
  const choices = await eventChoices(p, q);
  s.picks[p.id] = choices.map((c) => String(c.id));
  const what = p.kind === "peristiwa" ? "peristiwa yang benar" : "kelanjutan yang benar";
  const head = q ? `Hasil “${esc(q)}”` : p.kind === "peristiwa" ? "Peristiwa dalam ±7 hari" : "Kandidat lini cerita";
  const pages = Math.max(1, Math.ceil(choices.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  // A full-width button shows ~30 characters: the titles go in the text,
  // numbered, and the buttons carry the numbers, three to a row.
  const shown = choices.slice(page * PAGE, page * PAGE + PAGE);
  const list = shown.map((c, i) => `<b>${page * PAGE + i + 1}.</b> ${esc(c.label)}`).join("\n");
  const rows: Keyboard = [];
  shown.forEach((_, i) => {
    const n = page * PAGE + i;
    if (i % 3 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: String(n + 1), callback_data: `p:${p.id}:${n}` });
  });
  if (pages > 1) {
    rows.push([
      ...(page > 0 ? [{ text: "‹", callback_data: `k:${p.id}:${page - 1}` }] : []),
      { text: `${page + 1}/${pages}`, callback_data: `k:${p.id}:${page}` },
      ...(page < pages - 1 ? [{ text: "›", callback_data: `k:${p.id}:${page + 1}` }] : []),
    ]);
  }
  rows.push([{ text: "🔎 Ketik judul", callback_data: `s:${p.id}` }, { text: "← Kembali", callback_data: `b:${p.id}` }]);
  const body = choices.length
    ? `<b>✏️ Bukan — pilih ${what}.</b> ${head}:\n${list}`
    : `<b>✏️ ${head}: tidak ada.</b> Ketik judul untuk mencari, atau Kembali.`;
  await edit(msgId, `${await cardText(p)}\n\n${body}`, rows);
}

/** The card with the figures a typed name matched, and a new one to create. */
async function showFigures(s: State, p: Point, msgId: number, typed: string): Promise<void> {
  // "Nama Lengkap, jabatan, organisasi": the last two only matter for a new figure.
  const [rawName, rawRole = "", ...rest] = typed.split(",");
  const name = rawName.trim().slice(0, 200);
  const role = rawRole.trim().slice(0, 300);
  const org = rest.join(",").trim().slice(0, 300);
  const found = findFigures(await getFigureOptions(), name, p.kind === "pembicara" ? null : p.proposal.figure_id);
  s.picks[p.id] = found.map((f) => f.id);
  // Name – Role – Organisation in the text, numbered; the button only needs the number and name.
  const list = found.map((f, i) => `<b>${i + 1}.</b> <b>${esc(f.name)}</b>${f.title ? ` – ${esc(f.title)}` : ""}`).join("\n");
  const rows: Keyboard = found.map((f, i) => [{ text: clip(`${i + 1}. ${f.name}`, 30), callback_data: `p:${p.id}:${i}` }]);
  const fresh = name.length >= 3 ? { name, role, org } : null;
  if (fresh) {
    s.newFig[p.id] = fresh;
    rows.push([{ text: "➕ Buat tokoh baru", callback_data: `n:${p.id}` }]);
  }
  rows.push([{ text: "🔎 Cari lagi", callback_data: `s:${p.id}` }, { text: "← Kembali", callback_data: `b:${p.id}` }]);
  const ask = p.kind === "pembicara" ? `Siapa “${esc(p.proposal.speaker ?? "")}”?` : p.kind === "tentang" ? "Tentang siapa kutipannya?" : "Catatan ini terkait siapa?";
  const body = (found.length
    ? `<b>✏️ ${ask}</b> Hasil “${esc(name)}”:\n${list}`
    : `<b>✏️ Tidak ada tokoh yang cocok dengan “${esc(name)}”.</b>${fresh ? "" : " Cari lagi, atau Kembali."}`)
    + (fresh ? `\n\n➕ <b>Tokoh baru:</b> ${[fresh.name, fresh.role, fresh.org].filter(Boolean).map(esc).join(" – ")}${fresh.role && fresh.org ? "" : "\n<i>Lengkapi jabatan dan organisasinya: Cari lagi, lalu ketik Nama, jabatan, organisasi.</i>"}` : "");
  await edit(msgId, `${await cardText(p)}\n\n${body}`, rows);
}

/** Ask for a name or title as a reply to the card; the reply comes back to onMessage. */
async function prompt(s: State, p: Point, msgId: number): Promise<void> {
  const ask = p.kind === "jabatan"
    ? "Ketik jabatan dan organisasinya, dipisah koma: <i>jabatan, organisasi</i> (mis. <i>Gubernur, Pemerintah Provinsi Bali</i>). Organisasinya lembaga, bukan dapil atau pemilu."
    : figureKind(p)
    ? `Ketik nama ${p.kind === "tentang" ? "tokoh yang dibicarakan" : "tokohnya"}. Untuk tokoh baru, tambahkan jabatan dan organisasi, dipisah koma: <i>Nama Lengkap, jabatan, organisasi</i> (mis. <i>Nanik S Deyang, Wakil Kepala, Badan Gizi Nasional</i>)`
    : "Ketik sebagian judul untuk dicari.";
  const id = await send(ask, undefined, {
    reply_parameters: { message_id: msgId, allow_sending_without_reply: true },
    reply_markup: { force_reply: true, input_field_placeholder: p.kind === "jabatan" ? "Jabatan, organisasi" : figureKind(p) ? "Nama tokoh" : "Judul" },
  });
  s.prompts[id] = p.id;
}

/** A typed reply: to a prompt, or straight to a card. */
async function onReply(s: State, replyTo: number, text: string, own: number): Promise<boolean> {
  if (replyTo === s.fig.prompt || replyTo === s.org.prompt) {
    const fig = replyTo === s.fig.prompt;
    if (fig) s.fig.prompt = undefined;
    else s.org.prompt = undefined;
    try {
      await (fig ? onFigureReply(s, text) : onOrgReply(s, text));
    } catch (e) {
      await send(esc(e instanceof Error ? e.message : String(e)));
    }
    await drop(replyTo);
    await drop(own);
    return true;
  }
  if (replyTo === s.cand.prompt || (replyTo === s.cand.msg && s.cand.mode)) {
    if (replyTo === s.cand.prompt) s.cand.prompt = undefined;
    try {
      await onCandidateReply(s, text);
    } catch (e) {
      await send(e instanceof Error ? e.message : String(e));
    }
    if (replyTo !== s.cand.msg) await drop(replyTo);
    await drop(own);
    return true;
  }
  const whoOf = s.reworkWho[replyTo];
  if (whoOf) {
    delete s.reworkWho[replyTo];
    const p = await getPoint(whoOf);
    if (p && s.view[p.id]) await showReworkFigures(s, p, text);
    else await send("Catatannya sudah tidak dibuka; buka 📋 Catatan lagi.");
    await drop(replyTo);
    await drop(own);
    return true;
  }
  const reworkOf = s.reworkPrompts[replyTo];
  if (reworkOf) {
    delete s.reworkPrompts[replyTo];
    const p = await getPoint(reworkOf);
    const note = text.trim().slice(0, 2000);
    try {
      if (!p || !note) throw new Error("Catatannya sudah tidak dibuka; buka 📋 Catatan lagi.");
      await askRework(p.event_id, note, null);
      if (s.view[p.id]) await showView(s, p, "✍️ Diminta ditulis ulang; drafnya datang di sini.");
      else await send("✍️ Diminta ditulis ulang; drafnya datang di sini.");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await send(esc(/already running/.test(m) ? "Tulis ulang catatan ini masih berjalan; tunggu drafnya." : m));
    }
    await drop(replyTo);
    await drop(own);
    return true;
  }
  const viewOf = s.viewPrompts[replyTo];
  if (viewOf) {
    delete s.viewPrompts[replyTo];
    const p = await getPoint(viewOf);
    if (p && s.view[p.id] && s.viewQuote[p.id]) await showQuoteFigures(s, p, text);
    else await send("Kutipannya sudah tidak dibuka; buka 📋 Catatan lagi.");
    await drop(replyTo);
    await drop(own);
    return true;
  }
  let pointId = s.prompts[replyTo];
  let promptId: number | null = pointId ? replyTo : null;
  if (!pointId) {
    const hit = Object.entries(s.sent).find(([, m]) => m === replyTo);
    if (!hit) return false;
    pointId = Number(hit[0]);
  }
  const p = await getPoint(pointId);
  const card = s.sent[pointId];
  if (promptId) delete s.prompts[promptId];
  if (!p || p.status !== "open" || !card) {
    await send("Kartu itu sudah dijawab.");
    return true;
  }
  if (p.kind === "jabatan") await correctOffice(s, p, card, text);
  else if (figureKind(p)) await showFigures(s, p, card, text.trim());
  else await showEvents(s, p, card, 0, text.trim().slice(0, 100));
  // Keep the chat to the card: the question and the typed answer have done their job.
  if (promptId) await drop(promptId);
  await drop(own);
  return true;
}

/** "Jabatan, organisasi" typed for a jabatan card: saved as the correction, or said what is missing. */
async function correctOffice(s: State, p: Point, card: number, typed: string): Promise<void> {
  const at = typed.indexOf(",");
  const role = at < 0 ? "" : typed.slice(0, at).trim();
  const org = at < 0 ? "" : typed.slice(at + 1).trim();
  if (!role || !org) {
    await send("Tulis keduanya, dipisah koma: <i>jabatan, organisasi</i>. Balas kartunya lagi.");
    return;
  }
  const match = await orgMatch(org);
  try {
    await answerPoint(p.id, "koreksi", officeCorrection(role, match.org));
  } catch (e) {
    await send(esc(e instanceof Error ? e.message : String(e)));
    return;
  }
  await forget(s, p.id);
  const done = (await getPoint(p.id))!;
  await edit(card, `${await answeredText(done)}\n${match.note}`, [[{ text: "Batalkan", callback_data: `u:${p.id}` }]]);
}

/** A card is done: drop what it kept, and take its extra messages (📄 paragraphs) out of the chat. */
async function forget(s: State, pointId: number): Promise<void> {
  for (const m of s.extras[pointId] ?? []) await drop(m);
  delete s.extras[pointId];
  delete s.sent[pointId];
  delete s.picks[pointId];
  delete s.newFig[pointId];
  delete s.picks[`v${pointId}`];
  delete s.picks[`v${pointId}f`];
  delete s.view[pointId];
  delete s.viewQuote[pointId];
  delete s.viewUndo[pointId];
  for (const [m, id] of Object.entries(s.prompts)) if (id === pointId) delete s.prompts[m];
  for (const [m, id] of Object.entries(s.viewPrompts)) if (id === pointId) delete s.viewPrompts[m];
}

async function status(): Promise<string> {
  const [stats, cand] = await Promise.all([getKindStats(), getCandidateCounts()]);
  const drafts = await lqueryOne<{ n: number }>(`SELECT count(*) AS n FROM rework_requests WHERE status = 'ready'`).catch(() => null);
  const kandidat = `Kandidat tokoh: ${cand.undecided} · /kandidat${drafts?.n ? `\nDraf tulis ulang: ${drafts.n} · /draf` : ""}`;
  if (!stats) return `Belum ada poin kurasi di jejak.db.\n${kandidat}`;
  return ["<b>Poin terbuka</b>", ...stats.map((k) =>
    `${esc(KIND_LABEL[k.kind])}: ${k.open}${k.overall.value === null ? "" : ` · yakin ${Math.round(k.overall.value * 100)}%`}${k.auto ? " · otomatis" : ""}`
  ), "", kandidat].join("\n");
}

async function onCallback(s: State, q: NonNullable<Update["callback_query"]>): Promise<void> {
  const msg = q.message;
  const [kind, idRaw, code] = (q.data ?? "").split(":");
  const id = Number(idRaw);
  let note = "";
  if (kind === "ot" || kind === "oc" || kind === "os" || kind === "ok") {
    try {
      if (!msg) throw new Error("Pesan ini sudah tidak ada.");
      note = await onAuto(s, kind, idRaw ?? "", code, msg.message_id);
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
    return;
  }
  if (kind === "w") {
    try {
      if (!msg || !Number.isInteger(id)) throw new Error("Draf ini sudah tidak ada.");
      note = await onDraft(s, id, code, msg.message_id);
      delete s.drafts[id];
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      note = /already running|not ready/.test(m) ? "Draf ini belum bisa dipakai." : m;
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
    return;
  }
  if (kind === "f" || kind === "g") {
    try {
      if (!msg) throw new Error("Pesan ini sudah tidak ada.");
      note = await (kind === "f" ? onFigure : onOrg)(s, idRaw ?? "", code, msg.message_id);
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
    return;
  }
  if (kind === "c" || kind === "cu") {
    try {
      if (!msg) throw new Error("Kartu ini sudah tidak ada.");
      note = kind === "cu" ? await undoCandidateReject(s, msg.message_id) : await onCandidate(s, idRaw, code, msg.message_id);
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
    return;
  }
  if (kind?.startsWith("v")) {
    // The 📋 view: its own message, so a failure leaves the card as it is.
    try {
      const p = Number.isInteger(id) ? await getPoint(id) : null;
      if (!p || !msg) throw new Error("Poin ini sudah tidak ada.");
      note = await onView(s, kind, p, code, msg.message_id);
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
    return;
  }
  try {
    const p = Number.isInteger(id) ? await getPoint(id) : null;
    if (!p || !msg) throw new Error("Poin ini sudah tidak ada.");
    const open = p.status === "open" || p.status === "lewati";
    const answer = async (a: PointAnswer, correction: string | null) => {
      if (!open) throw new Error("Sudah dijawab.");
      await answerPoint(p.id, a, correction);
      await forget(s, p.id);
      const done = (await getPoint(p.id))!;
      await edit(msg.message_id, await answeredText(done), [[{ text: "Batalkan", callback_data: `u:${p.id}` }]]);
      note = "Tersimpan";
    };
    if (kind === "a") {
      const decoded = decode(p, code ?? "");
      if (!decoded) throw new Error("Tombol tidak dikenal.");
      await answer(...decoded);
    } else if (kind === "u") {
      await undoPoint(p.id);
      const back = (await getPoint(p.id))!;
      s.sent[p.id] = msg.message_id;
      await edit(msg.message_id, await cardText(back), cardKeyboard(back));
      note = "Dibatalkan";
    } else if (kind === "k" || kind === "s") {
      if (!open) throw new Error("Sudah dijawab.");
      // Figures and offices have no list to start from: ask for them typed.
      if (kind === "s" || figureKind(p) || p.kind === "jabatan") await prompt(s, p, msg.message_id);
      else await showEvents(s, p, msg.message_id, Number(code) || 0);
    } else if (kind === "p") {
      const pick = s.picks[p.id]?.[Number(code)];
      if (!pick) throw new Error("Pilihan ini sudah kedaluwarsa; buka Koreksi lagi.");
      await answer("koreksi", pick);
    } else if (kind === "n") {
      const fig = s.newFig[p.id];
      if (!fig) throw new Error("Ketik namanya lagi.");
      const out = await pipelineOp("new-figure", fig.name, ...(fig.role ? ["--role", fig.role] : []), ...(fig.org ? ["--org", fig.org] : []));
      await answer("koreksi", out.split("\n").pop()!.trim());
      note = `Tokoh baru dibuat: ${fig.name}`;
    } else if (kind === "r") {
      if (!open) throw new Error("Sudah dijawab.");
      if (!code) {
        await edit(msg.message_id, `${await cardText(p)}\n\n<b>🗑 Tolak catatan ini? Alasannya:</b>`, reasonKeyboard(p));
      } else {
        if (!REASONS.some((r) => r.code === code && code !== "other")) throw new Error("Alasan tidak dikenal.");
        const t = await rejectRecord(p.event_id, code as ReasonCode);
        await forget(s, p.id);
        s.takedowns[p.id] = t;
        await edit(msg.message_id, await takenDownText(p, code), [[{ text: "Batalkan", callback_data: `x:${p.id}` }]]);
        note = "Catatan ditolak";
      }
    } else if (kind === "x") {
      const t = s.takedowns[p.id];
      if (!t) throw new Error("Penolakan ini tidak bisa dibatalkan dari sini; buka /kurasi.");
      await restoreRecord(t);
      delete s.takedowns[p.id];
      const back = (await getPoint(p.id))!;
      if (back.status === "open") {
        s.sent[p.id] = msg.message_id;
        await edit(msg.message_id, await cardText(back), cardKeyboard(back));
      } else {
        await edit(msg.message_id, await answeredText(back));
      }
      note = "Catatan dipulihkan";
    } else if (kind === "b") {
      if (!open) throw new Error("Sudah dijawab.");
      delete s.picks[p.id];
      await edit(msg.message_id, await cardText(p), cardKeyboard(p));
    }
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
    // Show the card as it now stands, so a stale one doesn't stay tappable.
    const p = Number.isInteger(id) ? await getPoint(id).catch(() => null) : null;
    if (msg && p && p.status !== "open") {
      await forget(s, p.id);
      const undoable = p.answered_by === "curator" && ["ya", "bukan", "koreksi", "lewati"].includes(p.status);
      await edit(msg.message_id, await answeredText(p), undoable ? [[{ text: "Batalkan", callback_data: `u:${p.id}` }]] : []).catch(() => {});
    }
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
}

async function onMessage(s: State, m: NonNullable<Update["message"]>): Promise<void> {
  const text = m.text ?? "";
  if (m.reply_to_message && !text.startsWith("/") && (await onReply(s, m.reply_to_message.message_id, text, m.message_id))) return;
  const cmd = text.trim().split(/[\s@]/)[0].toLowerCase();
  const rest = text.trim().replace(/^\/\S+\s*/, "").trim();
  if (cmd === "/status") await send(await status());
  else if (cmd === "/tokoh") await tokohCommand(s, rest);
  else if (cmd === "/draf") {
    if (!(await sendDrafts(s, true))) await send("Tidak ada draf tulis ulang yang menunggu.");
  }
  else if (cmd === "/organisasi") await organisasiCommand(s, rest);
  else if (cmd === "/start" || cmd === "/lagi") await topUp(s);
  else if (cmd === "/otomatis") await send(...(await autoText()));
  else if (cmd === "/kandidat") {
    // The open card again at the bottom of the chat, or the next name.
    if (s.cand.msg) await drop(s.cand.msg);
    s.cand.msg = undefined;
    const c = s.cand.slug ? await getCandidate(s.cand.slug) : null;
    if (c && c.verdict === null) {
      s.cand.mode = s.cand.draft = s.cand.picks = undefined;
      s.cand.msg = await send(...(await candidateCard(s, c)));
    } else {
      await showNextCandidate(s);
    }
  } else await send("Perintah: /lagi (isi ulang kartu), /kandidat (kandidat tokoh), /otomatis (jawaban otomatis), /tokoh [nama] (ubah data tokoh), /organisasi [nama] (daftar organisasi), /draf (draf tulis ulang), /status (jumlah yang menunggu).");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Without TELEGRAM_CHAT_ID: say which chat to put there. Send the bot any
 * message and it prints the chat's id, and answers nothing else.
 */
async function whoami(): Promise<void> {
  console.log("telegram-bot: TELEGRAM_CHAT_ID is not set. Send the bot a message in Telegram; its chat id prints here.");
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg<Update[]>("getUpdates", { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] }, (POLL_SECONDS + 20) * 1000);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) console.log(`TELEGRAM_CHAT_ID=${u.message.chat.id}`);
      }
    } catch (e) {
      console.error(`telegram-bot: ${e instanceof Error ? e.message : e}`);
      await sleep(10_000);
    }
  }
}

async function main(): Promise<void> {
  if (!CHAT) return whoami();
  const s = await loadState();
  await tg("setMyCommands", {
    commands: [
      { command: "lagi", description: "Isi ulang kartu poin kurasi" },
      { command: "kandidat", description: "Kandidat tokoh baru" },
      { command: "otomatis", description: "Jawaban otomatis per jenis" },
      { command: "tokoh", description: "Ubah data tokoh: /tokoh nama" },
      { command: "organisasi", description: "Daftar organisasi: /organisasi nama" },
      { command: "draf", description: "Draf tulis ulang yang menunggu" },
      { command: "status", description: "Jumlah poin terbuka per jenis" },
    ],
  }).catch(() => {});
  // Cards from before a restart get this version's text and buttons.
  for (const [id, msg] of Object.entries(s.sent)) {
    const p = await getPoint(Number(id));
    if (p?.status === "open") await edit(msg, await cardText(p), cardKeyboard(p)).catch(() => {});
  }
  await topUp(s);
  await watchPublish(s);
  console.log(`telegram-bot: up, ${Object.keys(s.sent).length} cards open in chat ${CHAT}`);
  for (;;) {
    try {
      const updates = await tg<Update[]>("getUpdates", {
        offset: s.offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"],
      }, (POLL_SECONDS + 20) * 1000);
      for (const u of updates) {
        s.offset = u.update_id + 1;
        const chat = u.callback_query?.message?.chat.id ?? u.message?.chat.id;
        if (String(chat) !== CHAT) continue; // anyone else who finds the bot gets nothing
        if (u.callback_query) await onCallback(s, u.callback_query);
        else if (u.message?.text) await onMessage(s, u.message);
      }
      await topUp(s);
      // Saved again: topUp saved before these, and a restart in between
      // would send the same drafts twice.
      await sendDrafts(s);
      await watchPublish(s);
      await saveState(s);
    } catch (e) {
      // Offline, asleep, Telegram down, the db locked past its timeout: wait and go on.
      console.error(`telegram-bot: ${e instanceof Error ? e.message : e}`);
      await sleep(10_000);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
