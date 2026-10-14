import { cache } from "react";
import { query } from "./db";
import { LIVE } from "./data";

/**
 * Names of tracked figures inside running text — a record's title, its summary
 * bullets — so they can link to the figure's page.
 *
 * Exact names and aliases only, never fuzzy: a link asserts "this is that
 * person", and a near-miss would put the claim on the wrong one. Only figures
 * with at least one live record are linked, which keeps out roster entries
 * that are not people ("Istana Merdeka", "Rukun Tetangga") and pages with
 * nothing on them.
 */
export interface Actor {
  id: string;
  name: string;
  role: string;
}

interface Term {
  text: string;
  actor: Actor;
}

export interface ActorIndex {
  pattern: RegExp | null;
  byTerm: Map<string, Actor>;
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function pairs(s: string): string[] {
  const w = words(s);
  return w.slice(1).map((x, i) => `${w[i]} ${x}`);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const getActorIndex = cache(async (): Promise<ActorIndex> => {
  const rows = await query<{ id: string; name: string; aliases: string | null; role: string }>(
    `SELECT f.id, f.name, f.aliases, COALESCE(f.role, '') AS role
       FROM figures f
      WHERE f.active
        AND EXISTS (SELECT 1 FROM events e
                     WHERE e.figure_id = f.id AND e.kind = 'record' AND ${LIVE("e")})`
  );

  // Two consecutive words of anyone's name. An alias that contains another
  // figure's is not this figure: Prabowo's roster aliases include "Listyo
  // Sigit Prabowo" and "Prabowo Subianto-Gibran Rakabuming".
  const pairOwner = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const p of pairs(r.name)) {
      if (!pairOwner.has(p)) pairOwner.set(p, new Set());
      pairOwner.get(p)!.add(r.id);
    }
  }

  const terms: Term[] = [];
  const seen = new Map<string, string>(); // term -> figure id; null-ish when shared
  for (const r of rows) {
    let aliases: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.aliases ?? "[]");
      if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
    } catch {
      /* no aliases */
    }
    const actor: Actor = { id: r.id, name: r.name, role: r.role };
    for (const t of new Set([r.name, ...aliases].map((a) => a.trim()).filter(Boolean))) {
      const w = words(t);
      // A single word has to be long enough to be a name and not a word.
      if (w.length === 1 && w[0].length < 5) continue;
      if (pairs(t).some((p) => [...(pairOwner.get(p) ?? [])].some((id) => id !== r.id))) continue;
      const key = w.join(" ");
      if (seen.has(key) && seen.get(key) !== r.id) {
        seen.set(key, ""); // two figures answer to it: link neither
        continue;
      }
      seen.set(key, r.id);
      terms.push({ text: t, actor });
    }
  }

  const byTerm = new Map<string, Actor>();
  const kept = terms.filter((t) => seen.get(words(t.text).join(" ")) === t.actor.id);
  for (const t of kept) byTerm.set(words(t.text).join(" "), t.actor);
  if (kept.length === 0) return { pattern: null, byTerm };

  // Longest first, so "Prabowo Subianto" wins over "Prabowo".
  const alternation = kept
    .map((t) => t.text)
    .sort((a, b) => b.length - a.length)
    .map((t) => words(t).map(escape).join("[^\\p{L}\\p{N}]+"))
    .join("|");
  return {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "giu"),
    byTerm,
  };
});

export type Segment = string | { text: string; actor: Actor };

/**
 * `text` split into plain runs and figure mentions. Each figure is linked at
 * its first mention only, and `exclude` (the record's own figure) never.
 */
export function splitActors(text: string, index: ActorIndex, exclude?: string | null, linked = new Set<string>()): Segment[] {
  if (!index.pattern || !text) return [text];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(index.pattern)) {
    const actor = index.byTerm.get(words(m[0]).join(" "));
    if (!actor || actor.id === exclude || linked.has(actor.id)) continue;
    linked.add(actor.id);
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ text: m[0], actor });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
