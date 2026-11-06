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
import { lqueryOne, lrun } from "@/lib/localDb";
import {
  answerPoint,
  getKindStats,
  getNextOpenPoint,
  getPoint,
  undoPoint,
  KIND_LABEL,
  NOT_TRACKED,
  type Point,
  type PointAnswer,
  type PointKind,
} from "@/lib/curationPoints";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT = process.env.TELEGRAM_CHAT_ID ?? "";
/** How many open cards the chat holds at once: one, the next after each answer. */
const BATCH = Math.max(1, Number(process.env.TELEGRAM_BATCH ?? 1) || 1);
/** Optional: where /kurasi is reachable from the phone, for an "open" link. */
const KURASI_URL = (process.env.KURASI_URL ?? "").replace(/\/$/, "");
const STATE_KEY = "telegram_bot";
const POLL_SECONDS = 50;

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
  message?: { chat: { id: number }; text?: string };
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

async function send(text: string, keyboard?: Keyboard): Promise<number> {
  const msg = await tg<{ message_id: number }>("sendMessage", {
    chat_id: CHAT, text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
  return msg.message_id;
}

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
}

async function loadState(): Promise<State> {
  const row = await lqueryOne<{ value: string }>(`SELECT value FROM pipeline_state WHERE key = ?`, [STATE_KEY]);
  try {
    const s = row ? (JSON.parse(row.value) as Partial<State>) : {};
    return {
      offset: Number(s.offset) || 0,
      sent: s.sent && typeof s.sent === "object" ? s.sent : {},
      lastKind: s.lastKind && s.lastKind in KIND_LABEL ? s.lastKind : undefined,
    };
  } catch {
    return { offset: 0, sent: {} };
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
    case "pelaku": return `${p.proposal.name} tetap di Disebut; pelakunya tidak berubah.`;
    default: return "tidak ada yang berubah.";
  }
}

function meter(p: Point): string {
  const c = p.confidence;
  return c.value === null ? "yakin –" : `yakin ${Math.round(c.value * 100)}% (${c.agreed}/${c.answered})`;
}

/** The other figures a pembicara point offers, as /kurasi lists them. */
function others(p: Point): { id: string; name: string }[] {
  return (p.proposal.candidates ?? []).filter((c) => c.id !== p.proposal.figure_id).slice(0, 3);
}

async function cardText(p: Point): Promise<string> {
  const ev = await lqueryOne<{ title: string | null }>(`SELECT title FROM events WHERE id = ?`, [p.event_id]);
  const x = p.proposal;
  const lines = [
    `<b>${esc(KIND_LABEL[p.kind].toUpperCase())}</b> · ${meter(p)}${p.spot_check ? " · cek acak" : ""}`,
    `<i>${esc(ev?.title ?? `Catatan #${p.event_id}`)}</i>`,
    "",
  ];
  if (p.paragraph) {
    const src = [p.source, day(p.published_at)].filter(Boolean).join(" · ");
    lines.push(`<blockquote>${src ? `<b>${esc(src)}</b>\n` : ""}${excerpt(p)}</blockquote>`);
  } else {
    lines.push("<i>Paragrafnya tidak ditemukan di teks artikel.</i>");
  }
  lines.push("");
  if (p.kind === "pembicara") {
    const guess = x.figure_id ? x.name ?? x.figure_id : null;
    lines.push(`<b>Siapa “${esc(x.speaker ?? "")}” di sini?</b>`);
    lines.push(`Tebakan pipeline: ${guess ? `<b>${esc(guess)}</b>` : "bukan tokoh yang dilacak"}.`);
    if (p.group_size > 1) lines.push(`Jawabanmu berlaku untuk ${p.group_size} kutipan sekaligus.`);
  } else {
    lines.push(`<b>${esc(x.claim)}</b>`);
    lines.push(`<b>Jika Ya:</b> ${esc(p.effect)}`);
    lines.push(`<b>Jika Bukan:</b> ${esc(noEffect(p))}`);
  }
  lines.push("", `<i>Koreksi lain (peristiwa/tokoh lain): Lewati, lalu buka catatan #${p.event_id} di /kurasi.</i>`);
  return lines.join("\n");
}

function cardKeyboard(p: Point): Keyboard {
  const a = (code: string) => `a:${p.id}:${code}`;
  const rows: Keyboard = [];
  if (p.kind === "pembicara") {
    const x = p.proposal;
    if (x.figure_id) rows.push([{ text: `Ya, ${x.name ?? x.figure_id}`, callback_data: a("ya") }]);
    others(p).forEach((c, i) => rows.push([{ text: `Ini ${c.name}`, callback_data: a(`c${i}`) }]));
    rows.push([
      { text: "Bukan tokoh yang dilacak", callback_data: a("nt") },
      ...(x.figure_id ? [{ text: "Bukan dia", callback_data: a("bukan") }] : []),
    ]);
  } else {
    const pelaku = p.kind === "pelaku";
    rows.push([
      { text: pelaku ? `Ya, ${p.proposal.name} pelaku` : "Ya", callback_data: a("ya") },
      { text: pelaku ? "Bukan, hanya disebut" : "Bukan", callback_data: a("bukan") },
    ]);
  }
  const last: Button[] = [{ text: "Lewati", callback_data: a("lewati") }];
  if (KURASI_URL) last.push({ text: "Buka di /kurasi", url: `${KURASI_URL}/kurasi/${p.event_id}` });
  rows.push(last);
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
    delete s.sent[id];
    await edit(msg, p ? `${await answeredText(p)}\n<i>dijawab di /kurasi</i>` : "<i>Poin ini sudah tidak ada.</i>");
  }
  // More open cards than BATCH (it was lowered): take the extra ones back out of the chat.
  for (const id of Object.keys(s.sent).sort((a, b) => s.sent[b] - s.sent[a]).slice(0, Math.max(0, Object.keys(s.sent).length - BATCH))) {
    await tg("deleteMessage", { chat_id: CHAT, message_id: s.sent[id] }).catch(() => {});
    delete s.sent[id];
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
const ROTATION: PointKind[] = ["peristiwa", "pembicara", "pelaku", "lini"];

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
    if (kind === "a") {
      if (p.status !== "open" && p.status !== "lewati") throw new Error("Sudah dijawab.");
      const decoded = decode(p, code ?? "");
      if (!decoded) throw new Error("Tombol tidak dikenal.");
      await answerPoint(p.id, ...decoded);
      delete s.sent[p.id];
      const done = (await getPoint(p.id))!;
      await edit(msg.message_id, await answeredText(done), [[{ text: "Batalkan", callback_data: `u:${p.id}` }]]);
      note = "Tersimpan";
    } else if (kind === "u") {
      await undoPoint(p.id);
      const back = (await getPoint(p.id))!;
      s.sent[p.id] = msg.message_id;
      await edit(msg.message_id, await cardText(back), cardKeyboard(back));
      note = "Dibatalkan";
    }
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
    // Show the card as it now stands, so a stale one doesn't stay tappable.
    const p = Number.isInteger(id) ? await getPoint(id).catch(() => null) : null;
    if (msg && p && p.status !== "open") {
      delete s.sent[p.id];
      const undoable = p.answered_by === "curator" && ["ya", "bukan", "koreksi", "lewati"].includes(p.status);
      await edit(msg.message_id, await answeredText(p), undoable ? [[{ text: "Batalkan", callback_data: `u:${p.id}` }]] : []).catch(() => {});
    }
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
}

async function onMessage(s: State, text: string): Promise<void> {
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
        else if (u.message?.text) await onMessage(s, u.message.text);
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
