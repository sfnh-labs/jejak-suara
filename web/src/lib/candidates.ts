import { query } from "./db";

/**
 * The figure-discovery review queue.
 *
 * A name reaches this table when enough distinct outlets used it but the
 * automatic promoter would not take it on its own — almost always because it
 * is a single word, which in Indonesian sentence case is as likely to be the
 * first word of a sentence ("Dasar", "Lalu") as a surname ("Dasco").
 *
 * The verdict recorded here is a decision, not an action: the pipeline runs
 * against SQLite, so `scripts/apply_candidate_verdicts.py` reads these rows
 * back and does the promoting. `applied_at` is how a row says it has been
 * acted on.
 */
export type CandidateVerdict = "promote" | "reject";

export const CANDIDATE_VERDICTS: readonly CandidateVerdict[] = ["promote", "reject"];

export function isCandidateVerdict(value: unknown): value is CandidateVerdict {
  return (
    typeof value === "string" &&
    (CANDIDATE_VERDICTS as readonly string[]).includes(value)
  );
}

export interface CandidateRow {
  slug: string;
  name: string;
  outlets: number;
  mentions: number;
  role: string | null;
  headlines: string[];
  verdict: CandidateVerdict | null;
  full_name: string | null;
  aliases: string | null;
  decided_at: string | null;
  applied_at: string | null;
}

export type CandidateFilter = "undecided" | "promote" | "reject" | "all";

interface RawRow extends Omit<CandidateRow, "headlines"> {
  headlines: string | null;
}

/** Sample headlines are stored as a JSON array; a malformed one is not fatal. */
function parseHeadlines(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export async function getCandidates(
  filter: CandidateFilter = "undecided",
  limit = 300
): Promise<CandidateRow[]> {
  const where = {
    undecided: "verdict IS NULL",
    promote: "verdict = 'promote'",
    reject: "verdict = 'reject'",
    all: "TRUE",
  }[filter];

  const rows = await query<RawRow>(
    `SELECT slug, name, outlets, mentions, role, headlines,
            verdict, full_name, aliases, decided_at, applied_at
       FROM figure_candidates
      WHERE ${where}
      ORDER BY outlets DESC, mentions DESC, name
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ ...r, headlines: parseHeadlines(r.headlines) }));
}

export async function getCandidateCounts(): Promise<Record<CandidateFilter, number>> {
  const [row] = await query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE verdict IS NULL)      AS undecided,
            count(*) FILTER (WHERE verdict = 'promote')  AS promote,
            count(*) FILTER (WHERE verdict = 'reject')   AS reject,
            count(*)                                     AS all
       FROM figure_candidates`
  );
  return {
    undecided: Number(row?.undecided ?? 0),
    promote: Number(row?.promote ?? 0),
    reject: Number(row?.reject ?? 0),
    all: Number(row?.all ?? 0),
  };
}

/**
 * Record a decision. `null` clears it, putting the row back in the queue.
 *
 * `fullName` and `aliases` only mean anything alongside 'promote': they are
 * how the site will name the person and every other spelling attribution
 * should match. Clearing a verdict clears them too, so a re-decided row does
 * not inherit a name from an abandoned decision.
 */
export async function setCandidateVerdict(
  slug: string,
  verdict: CandidateVerdict | null,
  fullName?: string | null,
  aliases?: string | null
): Promise<void> {
  if (verdict === null) {
    await query(
      `UPDATE figure_candidates
          SET verdict = NULL, full_name = NULL, aliases = NULL,
              decided_at = NULL, applied_at = NULL
        WHERE slug = $1`,
      [slug]
    );
    return;
  }
  await query(
    `UPDATE figure_candidates
        SET verdict = $2,
            full_name = $3,
            aliases = $4,
            decided_at = now()::text,
            applied_at = NULL
      WHERE slug = $1`,
    [slug, verdict, fullName || null, aliases || null]
  );
}
