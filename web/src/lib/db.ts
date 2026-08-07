/**
 * Database access.
 *
 * Production uses Neon's HTTP driver: one-shot reads with no WebSocket or
 * connection teardown, which is what makes it work unchanged on Cloudflare
 * Workers. That driver only speaks to Neon endpoints, so local development
 * against a plain Postgres (see `scripts/local-db.mjs`) goes through `pg`
 * instead. The import is dynamic so `pg` is never pulled into the Worker
 * bundle — the branch is dead code in production.
 */
import { neon } from "@neondatabase/serverless";

type Runner = (text: string, params: unknown[]) => Promise<unknown[]>;

let runner: Runner | null = null;

function connectionUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function getRunner(): Promise<Runner> {
  if (runner) return runner;
  const url = connectionUrl();

  if (isLocal(url)) {
    const { Pool } = await import("pg");
    // Single connection: pages issue their queries with Promise.all, and the
    // PGlite dev server accepts one client at a time. pg queues the rest.
    const pool = new Pool({ connectionString: url, max: 1 });
    runner = async (text, params) => (await pool.query(text, params)).rows;
  } else {
    const sql = neon(url);
    runner = async (text, params) => (await sql.query(text, params)) as unknown[];
  }
  return runner;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const run = await getRunner();
  return (await run(text, params)) as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
