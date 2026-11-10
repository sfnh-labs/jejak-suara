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
import { existsSync } from "node:fs";
import { localDbPath, lquery, lqueryOne, lrun, pipelineOp } from "@/lib/localDb";
import { getFigureOptions, getFollowupCandidates, getItem, REASONS, reasonLabel, type FigureOption, type ReasonCode } from "@/lib/curation";
import {
  answerPoint,
  getKindStats,
  getNextOpenPoint,
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
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
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
}

async function loadState(): Promise<State> {
  const row = await lqueryOne<{ value: string }>(`SELECT value FROM pipeline_state WHERE key = ?`, [STATE_KEY]);
  try {
    const s = row ? (JSON.parse(row.value) as Partial<State>) : {};
    return {
      offset: Number(s.offset) || 0,
      sent: s.sent && typeof s.sent === "object" ? s.sent : {},
      lastKind: s.lastKind && s.lastKind in KIND_LABEL ? s.lastKind : undefined,
      picks: s.picks && typeof s.picks === "object" ? s.picks : {},
      prompts: s.prompts && typeof s.prompts === "object" ? s.prompts : {},
      newFig: s.newFig && typeof s.newFig === "object" ? s.newFig : {},
      extras: s.extras && typeof s.extras === "object" ? s.extras : {},
      takedowns: s.takedowns && typeof s.takedowns === "object" ? s.takedowns : {},
    };
  } catch {
    return { offset: 0, sent: {}, picks: {}, prompts: {}, newFig: {}, extras: {}, takedowns: {} };
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

async function cardText(p: Point): Promise<string> {
  const ev = await lqueryOne<{ title: string | null }>(`SELECT title FROM events WHERE id = ?`, [p.event_id]);
  const x = p.proposal;
  const lines = [
    `<b>${esc(KIND_LABEL[p.kind].toUpperCase())}</b> · ${meter(p)}${checkTag(p)}${p.spot_check ? " · cek acak" : ""}`,
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
  rows.push([{ text: "🗑 Tolak catatan", callback_data: `r:${p.id}:` }]);
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
    s.sent[p.id] = await send(await cardText(p), cardKeyboard(p));
    s.lastKind = p.kind;
  }
  await saveState(s);
}

/** The kinds take turns, in this order; a kind with nothing open is passed over. */
const ROTATION: PointKind[] = ["peristiwa", "pembicara", "tentang", "terkait", "jabatan", "lini"];

/** The newest open point of the kind after the last one sent. */
async function nextPoint(s: State): Promise<Point | null> {
  const start = s.lastKind ? ROTATION.indexOf(s.lastKind) + 1 : 0;
  const exclude = Object.keys(s.sent).map(Number);
  for (let i = 0; i < ROTATION.length; i++) {
    const p = await getNextOpenPoint(ROTATION[(start + i) % ROTATION.length], exclude);
    if (p) return p;
  }
  return null;
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
  try {
    await answerPoint(p.id, "koreksi", officeCorrection(role, org));
  } catch (e) {
    await send(esc(e instanceof Error ? e.message : String(e)));
    return;
  }
  await forget(s, p.id);
  const done = (await getPoint(p.id))!;
  await edit(card, await answeredText(done), [[{ text: "Batalkan", callback_data: `u:${p.id}` }]]);
}

/** A card is done: drop what it kept, and take its extra messages (📄 paragraphs) out of the chat. */
async function forget(s: State, pointId: number): Promise<void> {
  for (const m of s.extras[pointId] ?? []) await drop(m);
  delete s.extras[pointId];
  delete s.sent[pointId];
  delete s.picks[pointId];
  delete s.newFig[pointId];
  for (const [m, id] of Object.entries(s.prompts)) if (id === pointId) delete s.prompts[m];
}

async function status(): Promise<string> {
  const stats = await getKindStats();
  if (!stats) return "Belum ada poin kurasi di jejak.db.";
  return ["<b>Poin terbuka</b>", ...stats.map((k) =>
    `${esc(KIND_LABEL[k.kind])}: ${k.open}${k.overall.value === null ? "" : ` · yakin ${Math.round(k.overall.value * 100)}%`}${k.auto ? " · otomatis" : ""}`
  )].join("\n");
}

async function onCallback(s: State, q: NonNullable<Update["callback_query"]>): Promise<void> {
  const msg = q.message;
  const [kind, idRaw, code] = (q.data ?? "").split(":");
  const id = Number(idRaw);
  let note = "";
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
  if (cmd === "/status") await send(await status());
  else if (cmd === "/start" || cmd === "/lagi") await topUp(s);
  else await send("Perintah: /lagi (isi ulang kartu), /status (jumlah poin terbuka).");
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
      { command: "status", description: "Jumlah poin terbuka per jenis" },
    ],
  }).catch(() => {});
  // Cards from before a restart get this version's text and buttons.
  for (const [id, msg] of Object.entries(s.sent)) {
    const p = await getPoint(Number(id));
    if (p?.status === "open") await edit(msg, await cardText(p), cardKeyboard(p)).catch(() => {});
  }
  await topUp(s);
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
