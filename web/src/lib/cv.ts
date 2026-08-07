/**
 * Biographical detail for the figure page's CV tab.
 *
 * Deliberately static: this is reference material about a person, not something
 * the pipeline derives from news coverage, so it does not belong in the events
 * database. Add an entry keyed by the figure id used in `figures.toml`.
 */
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
  year: string;
  detail: string;
}

export interface Cv {
  bio: string;
  facts: CvFact[];
  posts: CvPost[];
  education: CvEducation[];
}

export const CV: Record<string, Cv> = {};

export function getCv(figureId: string): Cv | null {
  return CV[figureId] ?? null;
}
