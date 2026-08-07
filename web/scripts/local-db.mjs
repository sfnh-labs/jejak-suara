/**
 * Runs a local Postgres for development, with no database to install.
 *
 * PGlite is real Postgres compiled to WASM, and pglite-socket puts it behind
 * the normal wire protocol — so both `scripts/sync_to_neon.py` (psycopg2) and
 * the web app (pg) talk to it exactly as they would to Neon.
 *
 *   node scripts/local-db.mjs           # serve on 5433, data in .pglite/
 *   node scripts/local-db.mjs --fresh   # wipe the data directory first
 *
 * Point things at it with:
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres
 */
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", ".pglite");
const port = Number(process.env.LOCAL_PG_PORT ?? 5433);

if (process.argv.includes("--fresh")) {
  await rm(dataDir, { recursive: true, force: true });
  console.log("wiped", dataDir);
}

// A killed server leaves its lock file behind, and the next start aborts inside
// the WASM runtime with an unreadable error. Nothing else can be holding it:
// this database is a single local process.
await rm(join(dataDir, "postmaster.pid"), { force: true });

const db = await PGlite.create({ dataDir });
// maxConnections defaults to 1, which is the cause of otherwise baffling
// ECONNRESET errors: a page renders several queries at once, and Next's dev
// mode forks render workers, so more than one client is normal.
const server = new PGLiteSocketServer({
  db,
  port,
  host: "127.0.0.1",
  maxConnections: 20,
});
await server.start();

console.log(`local postgres ready on 127.0.0.1:${port}`);
console.log(
  `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/postgres`
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  });
}
