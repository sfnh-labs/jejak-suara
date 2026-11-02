import { lqueryOne as queryOne, tableExists } from "./localDb";

/** What each /kurasi tab says is waiting, read once per page. */
export interface NavCounts {
  /** Unreviewed records and open curation points on them. */
  records: number;
  points: number;
  peristiwa: number;
  figures: number;
  /** Lini cerita proposals nobody has ruled on. */
  lini: number;
  organisations: number;
  names: number;
}

export async function getNavCounts(): Promise<NavCounts> {
  const [points, candidates] = await Promise.all([tableExists("curation_points"), tableExists("candidate_review")]);
  const row = await queryOne<Record<keyof NavCounts, number>>(
    `SELECT
       (SELECT count(*) FROM events WHERE kind = 'record' AND curated IS NULL
           AND status IN ('new', 'summarized', 'approved')) AS records,
       ${points ? "(SELECT count(*) FROM curation_points WHERE status = 'open')" : "0"} AS points,
       (SELECT count(*) FROM events WHERE kind = 'peristiwa' AND curated IS NULL
           AND status IN ('new', 'summarized', 'approved')) AS peristiwa,
       (SELECT count(*) FROM figures WHERE active) AS figures,
       (SELECT count(*) FROM followup_links WHERE verdict IS NULL) AS lini,
       (SELECT count(*) FROM organizations) AS organisations,
       ${candidates ? "(SELECT count(*) FROM candidate_review WHERE verdict IS NULL)" : "0"} AS names`
  );
  return {
    records: Number(row?.records ?? 0),
    points: Number(row?.points ?? 0),
    peristiwa: Number(row?.peristiwa ?? 0),
    figures: Number(row?.figures ?? 0),
    lini: Number(row?.lini ?? 0),
    organisations: Number(row?.organisations ?? 0),
    names: Number(row?.names ?? 0),
  };
}
