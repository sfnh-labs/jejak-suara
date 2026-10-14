"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  isLinkVerdict,
  isVerdict,
  mergeFigure,
  saveFigureEdit,
  setCuration,
  setLinkVerdict,
  setRelatedFigure,
} from "@/lib/curation";

/*
 * Server actions rather than route handlers so the pages work with plain
 * <form> posts and need no client JavaScript — which also means they keep
 * working under the Cloudflare Access login redirect, where a fetch() from an
 * expired session would return the login HTML instead of a result.
 *
 * Access authorises the request before it reaches the Worker (see
 * middleware.ts); these only validate the payload.
 */

function eventId(formData: FormData, field = "event_id"): number {
  const id = Number(formData.get(field));
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid ${field}`);
  return id;
}

function text(formData: FormData, field: string, max = 300): string {
  const value = String(formData.get(field) ?? "").trim();
  if (value.length > max) throw new Error(`${field} too long`);
  return value;
}

/** "" and absent both mean "clear the decision". */
function optional(formData: FormData, field: string): string | null {
  const raw = formData.get(field);
  return raw === null || raw === "" ? null : String(raw);
}

function done(id: number) {
  // The public pages are force-dynamic and pick changes up on their own; this
  // keeps the queue and the item from showing a stale decision.
  revalidatePath("/kurasi", "layout");
  revalidatePath(`/kurasi/${id}`);
}

/** Take an event down, mark it checked, or clear the verdict. */
export async function curate(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const verdict = optional(formData, "verdict");
  if (verdict !== null && !isVerdict(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  await setCuration(id, verdict);
  done(id);

  // "Simpan & lanjut": the per-item flow, straight on to the next unreviewed.
  const next = optional(formData, "next");
  if (next !== null) {
    const nextId = Number(next);
    redirect(Number.isInteger(nextId) && nextId > 0 ? `/kurasi/${nextId}` : "/kurasi");
  }
}

/** Confirm, reject or withdraw a record → peristiwa link. */
export async function ruleLink(formData: FormData): Promise<void> {
  const recordId = eventId(formData, "record_id");
  const peristiwaId = eventId(formData, "peristiwa_id");
  const verdict = optional(formData, "verdict");
  if (verdict !== null && !isLinkVerdict(verdict)) {
    throw new Error(`invalid link verdict: ${verdict}`);
  }
  await setLinkVerdict(recordId, peristiwaId, verdict);
  done(recordId);
  done(peristiwaId);
}

/** Correct a figure's display name, office and alias list. */
export async function editFigure(formData: FormData): Promise<void> {
  const figureId = text(formData, "figure_id", 120);
  const name = text(formData, "name", 120);
  if (!figureId || !name) throw new Error("figure_id and name are required");
  const role = text(formData, "role", 200) || null;

  // One alias per line, or separated by "|" as on the candidate page. The
  // name is always a match term, and attribution lowercases anyway, so
  // duplicates by case are dropped.
  const seen = new Set<string>();
  const aliases = text(formData, "aliases", 4000)
    .split(/[\n|]/)
    .map((a) => a.trim())
    .filter((a) => {
      const key = a.toLowerCase();
      if (!a || key === name.toLowerCase() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // Short aliases match inside unrelated words and steal articles: "Ari"
  // would claim every "Jakarta Barat Ari…" mention.
  const tooShort = aliases.find((a) => a.length < 3);
  if (tooShort) throw new Error(`alias too short to match safely: ${tooShort}`);

  // Unticking "aktif" retires a mis-mined or duplicate figure.
  await saveFigureEdit(figureId, name, role, aliases, formData.get("active") === "1");
  done(eventId(formData));
}

/** Strike a related figure from a peristiwa, or restore one. */
export async function relateFigure(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const figureId = text(formData, "figure_id", 120);
  if (!figureId) throw new Error("missing figure_id");
  await setRelatedFigure(id, figureId, formData.get("struck") === "1");
  done(id);
}

/** Fold a duplicate figure into the one it duplicates. Not undoable here. */
export async function mergeFigures(formData: FormData): Promise<void> {
  const fromId = text(formData, "figure_id", 120);
  const intoId = text(formData, "into_id", 120);
  if (!fromId || !intoId) throw new Error("figure_id and into_id are required");
  // The checkbox is the confirmation: a plain form has no dialog to ask with.
  if (formData.get("confirm") !== "1") throw new Error("merge not confirmed");
  await mergeFigure(fromId, intoId);
  done(eventId(formData));
}
