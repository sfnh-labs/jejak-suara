import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
let sqlite3;
try {
  sqlite3 = (await import("better-sqlite3")).default;
} catch {
  console.log("better-sqlite3 not installed. Run: npm install better-sqlite3");
  process.exit(1);
}

const SCHEMA = readFileSync(join(__dirname, "..", "src", "lib", "schema.sql"), "utf-8");

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("No DATABASE_URL set. Dumping SQL for manual import instead.");
    await dumpSql();
    return;
  }

  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: dbUrl });

  const source = join(ROOT, "..", "jejak.db");
  const sqlite = new sqlite3(source);

  try {
    console.log("Applying schema...");
    for (const stmt of SCHEMA.split(";").filter((s) => s.trim())) {
      await pool.query(stmt);
    }

    const tables = [
      { table: "events", key: "id", cols: ["id", "figure_id", "title", "event_date", "status", "created_at"] },
      { table: "event_summaries", key: "event_id", cols: ["event_id", "summary_text", "citations_json", "corroboration_count", "single_source_flag", "model", "generated_at"] },
      { table: "sentiment", key: "id", cols: ["event_id", "channel", "score", "label", "sample_size", "samples_json", "collected_at"] },
      { table: "corrections", key: "id", cols: ["event_id", "submitted_by", "body", "status", "created_at"] },
      { table: "articles", key: "id", cols: ["id", "figure_id", "source", "url", "title", "summary", "body", "fetch_status", "published_at", "fetched_at", "event_id"] },
      { table: "comments", key: "id", cols: ["event_id", "video_id", "author_id", "author_name", "text", "like_count", "published_at", "stance", "collected_at"] },
      { table: "buzzer_signals", key: "id", cols: ["event_id", "anomaly_score", "anomaly_pct", "suspicious_ids_json", "signals_triggered", "analyzed_at"] },
    ];

    for (const { table, key, cols } of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length === 0) {
        console.log(`  ${table}: 0 rows`);
        continue;
      }

      const names = cols.join(", ");
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

      for (const row of rows) {
        const values = cols.map((c) => row[c] ?? null);
        try {
          await pool.query(
            `INSERT INTO ${table} (${names}) VALUES (${placeholders}) ON CONFLICT (${key}) DO NOTHING`,
            values
          );
        } catch (err) {
          console.error(`  ${table}: error inserting row ${row[key]}:`, err);
        }
      }
      console.log(`  ${table}: ${rows.length} rows migrated`);
    }

    console.log("Seed complete.");
  } finally {
    sqlite.close();
    await pool.end();
  }
}

async function dumpSql() {
  const source = join(ROOT, "..", "jejak.db");
  const sqlite = new sqlite3(source);
  const lines = [SCHEMA, ""];

  for (const table of ["events", "event_summaries", "sentiment", "corrections", "articles", "comments", "buzzer_signals"]) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) {
      const cols = Object.keys(row).filter((k) => row[k] !== null);
      const vals = cols.map((c) => {
        const v = row[c];
        if (typeof v === "number") return v;
        return `'${String(v).replace(/'/g, "''")}'`;
      });
      lines.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
    }
    if (rows.length > 0) lines.push("");
    console.log(`  ${table}: ${rows.length} rows`);
  }

  const outPath = join(ROOT, "scripts", "seed.sql");
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`\nSQL dump written to ${outPath}`);
  sqlite.close();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
