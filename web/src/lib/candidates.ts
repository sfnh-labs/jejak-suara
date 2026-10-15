import { lquery as query, lrun, ltx, pipelineOp } from "./localDb";

/**
 * The figure-discovery review queue.
 *
 * A name reaches this table when enough distinct outlets used it but the
 * automatic promoter would not take it on its own — almost always because it
 * is a single word, which in Indonesian sentence case is as likely to be the
 * first word of a sentence ("Dasar", "Lalu") as a surname ("Dasco").
 *
 * Kept in jejak.db's candidate_review, whose evidence the pipeline refreshes
 * (jejak/candidate_queue.py). A verdict is carried out the moment it is made:
 * a promote by the pipeline's own code (scripts/kurasi_ops.py), a reject
 * here. `applied_at` records that it was.
 */
export type CandidateVerdict = "promote" | "reject";

export const CANDIDATE_VERDICTS: readonly CandidateVerdict[] = ["promote", "reject"];

export function isCandidateVerdict(value: unknown): value is CandidateVerdict {
  return (
    typeof value === "string" &&
    (CANDIDATE_VERDICTS as readonly string[]).includes(value)
  );
}

export interface CandidateHeadline {
  title: string;
  url: string | null;
  source: string | null;
  /** The sentence fragment the name was found in — the only evidence that
   *  says whether the extractor caught a person or half an office. */
  context: string | null;
}

export interface CandidateRecord {
  id: number;
  title: string;
  figure_id: string | null;
}

export interface CandidateRow {
  slug: string;
  name: string;
  outlets: number;
  mentions: number;
  role: string | null;
  headlines: CandidateHeadline[];
  records: CandidateRecord[];
  verdict: CandidateVerdict | null;
  full_name: string | null;
  aliases: string | null;
  curated_role: string | null;
  decided_at: string | null;
  applied_at: string | null;
  notes: string | null;
}

export type CandidateFilter = "undecided" | "promote" | "reject" | "all";

interface RawRow extends Omit<CandidateRow, "headlines" | "records"> {
  headlines: string | null;
  records: string | null;
}

/** The events the evidence articles clustered into. Malformed JSON costs the
 *  row its examples, not the page. */
function parseRecords(raw: string | null): CandidateRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CandidateRecord[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "number" || typeof row.title !== "string") return [];
      return [{
        id: row.id,
        title: row.title,
        figure_id: typeof row.figure_id === "string" ? row.figure_id : null,
      }];
    });
  } catch {
    return [];
  }
}

/**
 * Sample articles, stored as a JSON array.
 *
 * Rows synced before the shape gained a url hold bare title strings, so both
 * are accepted; a malformed value costs the row its examples, not the page.
 */
function parseHeadlines(raw: string | null): CandidateHeadline[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CandidateHeadline[] => {
      if (typeof item === "string") {
        return [{ title: item, url: null, source: null, context: null }];
      }
      if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        if (typeof row.title === "string") {
          return [{
            title: row.title,
            url: typeof row.url === "string" ? row.url : null,
            source: typeof row.source === "string" ? row.source : null,
            context: typeof row.context === "string" ? row.context : null,
          }];
        }
      }
      return [];
    });
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
            records, verdict, full_name, aliases, curated_role,
            decided_at, applied_at, notes
       FROM candidate_review
      WHERE ${where}
      ORDER BY outlets DESC, mentions DESC, name
      LIMIT ?`,
    [limit]
  );
  return rows.map((r) => ({
    ...r,
    headlines: parseHeadlines(r.headlines),
    records: parseRecords(r.records),
  }));
}

export async function getCandidateCounts(): Promise<Record<CandidateFilter, number>> {
  const [row] = await query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE verdict IS NULL)      AS undecided,
            count(*) FILTER (WHERE verdict = 'promote')  AS promote,
            count(*) FILTER (WHERE verdict = 'reject')   AS reject,
            count(*)                                     AS "all"
       FROM candidate_review`
  );
  return {
    undecided: Number(row?.undecided ?? 0),
    promote: Number(row?.promote ?? 0),
    reject: Number(row?.reject ?? 0),
    all: Number(row?.all ?? 0),
  };
}

/**
 * Record a decision and carry it out. `null` withdraws a reject, putting the
 * row back in the queue; a promote cannot be withdrawn — the figure exists,
 * and retiring it is done on its own page.
 *
 * `fullName`, `aliases`, `curatedRole`, `curatedSlug` and `curatedPositions`
 * only mean anything alongside 'promote': they are exactly what the new
 * figure is created with. If the pipeline refuses (the page address is
 * taken), the decision is undone and the reason thrown.
 */
export async function setCandidateVerdict(
  slug: string,
  verdict: CandidateVerdict | null,
  fullName?: string | null,
  aliases?: string | null,
  curatedRole?: string | null,
  curatedSlug?: string | null,
  curatedPositions?: string | null
): Promise<void> {
  const now = new Date().toISOString();
  if (verdict === "promote") {
    await lrun(
      `UPDATE candidate_review
          SET verdict = 'promote', full_name = ?2, aliases = ?3, curated_role = ?4,
              curated_slug = ?5, curated_positions = ?6, decided_at = ?7, applied_at = NULL
        WHERE slug = ?1 AND applied_at IS NULL`,
      [slug, fullName || null, aliases || null, curatedRole || null, curatedSlug || null,
       curatedPositions || null, now]
    );
    try {
      await pipelineOp("candidate", slug);
    } catch (e) {
      await lrun(`UPDATE candidate_review SET verdict = NULL, decided_at = NULL WHERE slug = ?`, [slug]);
      throw e;
    }
    return;
  }
  if (verdict === "reject") {
    await rejectCandidates([slug]);
    return;
  }
  await ltx(async () => {
    const n = await lrun(
      `UPDATE candidate_review
          SET verdict = NULL, full_name = NULL, aliases = NULL, curated_role = NULL,
              curated_slug = NULL, curated_positions = NULL, decided_at = NULL, applied_at = NULL
        WHERE slug = ? AND verdict = 'reject'`,
      [slug]
    );
    if (n) {
      await lrun(
        `UPDATE figure_candidates SET status = 'candidate' WHERE slug = ? AND status = 'rejected'`,
        [slug]
      );
    }
  });
}

/**
 * A curator note, kept separate from the verdict.
 *
 * Some rows are worth writing down without deciding — "this is a police rank,
 * not a person", "same man as the figure we already track". The note is what
 * the next round of extractor tuning reads, so it outlives the decision and
 * clearing a verdict leaves it alone.
 */
export async function setCandidateNote(slug: string, notes: string | null): Promise<void> {
  await lrun(`UPDATE candidate_review SET notes = ?2 WHERE slug = ?1`, [
    slug,
    notes && notes.trim() ? notes.trim() : null,
  ]);
}

/**
 * Reject names, several at once from the queue's triage, where most rows are
 * a sentence-start word or half an office and need no form. Discovery stops
 * offering them (figure_candidates.status). Names already decided keep their
 * verdict.
 */
export async function rejectCandidates(slugs: string[]): Promise<void> {
  if (slugs.length === 0) return;
  const now = new Date().toISOString();
  await ltx(async () => {
    await lrun(
      `UPDATE figure_candidates SET status = 'rejected'
        WHERE slug IN (SELECT slug FROM candidate_review
                        WHERE verdict IS NULL AND slug IN (SELECT value FROM json_each(?)))`,
      [slugs]
    );
    await lrun(
      `UPDATE candidate_review SET verdict = 'reject', decided_at = ?2, applied_at = ?2
        WHERE verdict IS NULL AND slug IN (SELECT value FROM json_each(?1))`,
      [slugs, now]
    );
  });
}
