/**
 * Biographical detail for the figure page's CV tab.
 *
 * Not a separate entity: the CV is columns on the figure's own row, so there
 * is one record of each office. `positions` is the career list here and, by
 * its first entry, the title under the figure's name everywhere else.
 *
 * Seeded from cv/<figure-id>.json (scripts/import_cv.py) and corrected in
 * /kurasi, where a curator's edit takes precedence over any later seed.
 */
import { queryOne } from "./db";

export interface CvFact {
  label: string;
  value: string;
}

export interface CvPost {
  period: string;
  title: string;
  org?: string;
}

export interface CvEducation {
  /** Omitted when the sources give none. */
  year?: string;
  detail: string;
}

export interface CvSource {
  label: string;
  /** Omitted for our own coverage, which has no single page to link. */
  url?: string;
}

export interface Cv {
  bio: string;
  facts: CvFact[];
  posts: CvPost[];
  education: CvEducation[];
  /** Where the entries come from. Shown under the CV; every entry needs one. */
  sources: CvSource[];
  /** When the sources were read (ISO date). Offices change; this dates the list. */
  checkedAt: string | null;
}

function list<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** The figure's CV, or null when there is nothing to show beyond the title. */
export async function getCv(figureId: string): Promise<Cv | null> {
  const row = await queryOne<{
    bio: string | null;
    facts: string | null;
    positions: string | null;
    education: string | null;
    sources: string | null;
    cv_checked_at: string | null;
  }>(
    `SELECT bio, facts, positions, education, sources, cv_checked_at
       FROM figures WHERE id = $1 AND active`,
    [figureId]
  );
  if (!row) return null;

  const positions = list<{ role?: string; org?: string; period?: string }>(row.positions);
  const facts = list<CvFact>(row.facts).filter((f) => f.label !== "Jabatan kini");
  const education = list<CvEducation>(row.education);
  if (!row.bio && positions.length === 0 && facts.length === 0 && education.length === 0) {
    return null;
  }

  // The current office is the first position, not a separately kept fact.
  const main = positions[0];
  const current = main ? [main.role, main.org].filter(Boolean).join(" ") : "";
  return {
    bio: row.bio ?? "",
    facts: current ? [...facts, { label: "Jabatan kini", value: current }] : facts,
    posts: positions.map((p) => ({ period: p.period ?? "", title: p.role ?? "", org: p.org || undefined })),
    education,
    sources: list<CvSource>(row.sources),
    checkedAt: row.cv_checked_at,
  };
}
