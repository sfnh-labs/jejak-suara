/**
 * Where a tracked figure sits, for the /tokoh board's filter chips.
 *
 * Derived from the figure's role and the organisation of its current position
 * rather than stored: the roster's roles are already curated, and the board
 * needs only a coarse sort. The page id joins the text because some figures
 * carry their country or party only there ("xi-jinping", "golkar-…").
 *
 * The rules run in order and the first match wins. Each earlier rule exists
 * to take a role away from a later, broader one: "Gubernur Bank Indonesia" is
 * not a governor, "Presiden FIFA" is not the president.
 */

export type GroupId = "istana" | "parlemen" | "daerah" | "mancanegara" | "lembaga";

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "istana", label: "Istana & Kabinet" },
  { id: "parlemen", label: "Parlemen & Partai" },
  { id: "daerah", label: "Kepala Daerah" },
  { id: "mancanegara", label: "Mancanegara" },
  { id: "lembaga", label: "Lembaga & Lainnya" },
];

const RULES: [GroupId, RegExp][] = [
  // Foreign heads of state and international bodies.
  ["mancanegara", /\b(amerika|tiongkok|china|rusia|korea|singapura|malaysia|thailand|india|israel|belarus|timor|york|pbb|fifa|perdana menteri)\b/],
  // Institutions whose titles look like a governor's, a party chair's or a
  // parliamentary committee's.
  ["lembaga", /\b(bank indonesia|kpk|pemberantasan korupsi|mahkamah|staf khusus gubernur|kpu|kamar dagang)\b/],
  ["daerah", /\b(gubernur|wagub|bupati|wali ?kota|walikota)\b/],
  // The president himself, his office, and the cabinet. A bare "Presiden"
  // is someone else's (a union's, an unnamed country's) and falls through.
  ["istana", /\b(presiden (indonesia|republik indonesia|ri)|wakil presiden|(juru bicara|penasihat khusus) presiden|kepala pco|menteri|menko|menag|menpora|menhan|kabinet|kepala badan|kepala otorita)\b/],
  ["parlemen", /\b(dpr|dprd|dpd|mpr|dpp|komisi|partai|pdi|golkar|gerindra|demokrat|nasdem|pkb|pks|ketua umum|sekjen)\b/],
];

export function groupOf(f: { id: string; role: string; positions?: string | null }): GroupId {
  let org = "";
  try {
    const first = JSON.parse(f.positions ?? "[]")[0];
    if (first && typeof first.org === "string") org = first.org;
  } catch {
    // A malformed CV is the curator's to fix; the role alone still sorts it.
  }
  const text = `${f.id.replace(/-/g, " ")} ${f.role} ${org}`.toLowerCase();
  for (const [group, re] of RULES) if (re.test(text)) return group;
  return "lembaga";
}

export function groupLabel(id: GroupId): string {
  return GROUPS.find((g) => g.id === id)!.label;
}

export function isGroupId(value: string | undefined): value is GroupId {
  return GROUPS.some((g) => g.id === value);
}
