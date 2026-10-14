"use server";

import { revalidatePath } from "next/cache";
import {
  isCandidateVerdict,
  rejectCandidates,
  setCandidateNote,
  setCandidateVerdict,
} from "@/lib/candidates";
import { positionTitle, type Position } from "@/lib/curation";

/**
 * Record a decision on one discovered name.
 *
 * A server action taking plain form data, like /kurasi's: no client JavaScript,
 * so it keeps working when a Cloudflare Access session has expired and a fetch()
 * would come back as the login page instead of a result.
 */
export async function decide(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "").trim();
  if (!slug) throw new Error("missing slug");

  const raw = formData.get("verdict");
  // "" is the clear case: back to undecided, with the name fields dropped.
  const verdict = raw === "" || raw === null ? null : String(raw);
  if (verdict !== null && !isCandidateVerdict(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }

  // A reject is sent from the accept form too, beside "Jadikan tokoh"; what
  // was typed into it is not a decision and is not kept.
  if (verdict === "reject") {
    await setCandidateVerdict(slug, verdict);
    revalidatePath("/kurasi", "layout");
    return;
  }

  const fullName = String(formData.get("full_name") ?? "").trim();
  const aliases = String(formData.get("aliases") ?? "").trim();
  // Offices as parallel columns, one row each, the way the figure editor in
  // /kurasi takes them: blank rows drop, the first is the main one.
  const column = (field: string) => formData.getAll(field).map((v) => String(v).trim().slice(0, 300));
  const roles = column("pos_role");
  const orgs = column("pos_org");
  const periods = column("pos_period");
  const positions: Position[] = roles
    .map((role, i) => ({ role, org: orgs[i] ?? "", period: periods[i] ?? "" }))
    .filter((p) => p.role || p.org);
  if (positions.length > 20) throw new Error("too many positions");
  const curatedRole = positions.length
    ? positionTitle(positions[0])
    : String(formData.get("curated_role") ?? "").trim();
  // The page address, /tokoh/<slug>. Empty derives it from the full name.
  const figureSlug = String(formData.get("figure_slug") ?? "").trim().toLowerCase();
  if (figureSlug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(figureSlug)) {
    throw new Error(`invalid page address: ${figureSlug}`);
  }

  await setCandidateVerdict(
    slug, verdict, fullName, aliases, curatedRole, figureSlug,
    positions.length ? JSON.stringify(positions) : null
  );
  // Also decided from an event page in /kurasi, so the whole section.
  revalidatePath("/kurasi", "layout");
}

/**
 * Save a curator note.
 *
 * Separate from `decide` on purpose: a row can be worth annotating without
 * being ruled on — "this is a police rank", "same man as a figure we already
 * track" — and the note has to survive a verdict being cleared.
 */
export async function annotate(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "").trim();
  if (!slug) throw new Error("missing slug");

  const notes = String(formData.get("notes") ?? "");
  // Long enough for a paragraph of reasoning, short enough that a stuck paste
  // does not become a database row.
  if (notes.length > 2000) throw new Error("note too long");

  await setCandidateNote(slug, notes);
  // Also decided from an event page in /kurasi, so the whole section.
  revalidatePath("/kurasi", "layout");
}

/** Reject every ticked row of the queue in one submit. */
export async function rejectMany(formData: FormData): Promise<void> {
  const slugs = formData.getAll("slug").map((s) => String(s).trim()).filter(Boolean);
  // A page holds at most a few hundred rows; anything larger is not a form.
  if (slugs.length > 500) throw new Error("too many rows");
  await rejectCandidates(slugs);
  revalidatePath("/kurasi", "layout");
}
