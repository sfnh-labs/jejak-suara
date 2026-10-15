/**
 * The pipeline's own database, for /kurasi.
 *
 * Curation runs on the curator's machine against jejak.db, the copy the
 * pipeline works on: a decision takes effect for the next crawl the moment it
 * is made, every article's full text is at hand, and Neon only ever receives
 * what the push sends it. Set JEJAK_DB (in web/.env.local) to the file, e.g.
 * JEJAK_DB=../jejak.db. Without it — the deployed site — /kurasi does not
 * exist.
 *
 * Node's built-in SQLite, loaded on first use so nothing of it reaches the
 * Worker bundle's hot path. Queries use SQLite's `?` placeholders; a boolean
 * is bound as 0/1 and an array as JSON, for `IN (SELECT value FROM json_each(?))`.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

let db: DatabaseSync | null = null;

export function localDbPath(): string | null {
  const raw = process.env.JEJAK_DB;
  return raw ? path.resolve(process.cwd(), raw) : null;
}

/** Whether this server curates: JEJAK_DB is set. */
export function isCurationHost(): boolean {
  return localDbPath() !== null;
}

async function open(): Promise<DatabaseSync> {
  if (db) return db;
  const file = localDbPath();
  if (!file) throw new Error("JEJAK_DB is not set; /kurasi runs only beside jejak.db");
  const { DatabaseSync } = await import("node:sqlite");
  const conn = new DatabaseSync(file);
  // The pipeline may be writing (a fetch backfill, a nightly run): wait for
  // its lock rather than fail.
  conn.exec("PRAGMA busy_timeout = 60000; PRAGMA foreign_keys = ON;");
  db = conn;
  return conn;
}

function bind(params: unknown[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (Array.isArray(p)) return JSON.stringify(p);
    return p as SQLInputValue;
  });
}

export async function lquery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await open();
  return conn.prepare(sql).all(...bind(params)) as T[];
}

export async function lqueryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const conn = await open();
  return (conn.prepare(sql).get(...bind(params)) as T | undefined) ?? null;
}

/** Run a write. Returns how many rows it changed. */
export async function lrun(sql: string, params: unknown[] = []): Promise<number> {
  const conn = await open();
  return Number(conn.prepare(sql).run(...bind(params)).changes);
}

/** Several writes that must land together or not at all. */
export async function ltx(fn: () => Promise<void>): Promise<void> {
  const conn = await open();
  conn.exec("BEGIN IMMEDIATE");
  try {
    await fn();
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Run scripts/kurasi_ops.py: the decisions whose logic belongs to the
 * pipeline (promoting a name, merging figures), carried out by its own code.
 * Rejects with the script's own explanation when it refuses.
 */
function opCommand(args: string[]): { python: string; argv: string[]; root: string } {
  const file = localDbPath();
  if (!file) throw new Error("JEJAK_DB is not set");
  // The repository: the web app runs from web/, beside scripts/ and .venv.
  const root = process.env.JEJAK_ROOT ?? path.resolve(process.cwd(), "..");
  const python = process.env.JEJAK_PYTHON ?? path.join(root, ".venv", "bin", "python");
  return { python, root, argv: [path.join(root, "scripts", "kurasi_ops.py"), "--db", file, ...args] };
}

/**
 * Start a pipeline op and return at once: for work that takes the model a
 * minute (a rework), which the page then shows as in progress. It records its
 * own outcome in jejak.db.
 */
export function pipelineOpInBackground(...args: string[]): void {
  const { python, argv, root } = opCommand(args);
  const child = spawn(python, argv, { cwd: root, detached: true, stdio: "ignore" });
  child.unref();
}

export async function pipelineOp(...args: string[]): Promise<string> {
  const { python, argv, root } = opCommand(args);
  return new Promise((resolve, reject) => {
    execFile(
      python,
      argv,
      { cwd: root, timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout.trim());
      }
    );
  });
}
