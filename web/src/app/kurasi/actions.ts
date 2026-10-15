"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  isLinkVerdict,
  isReasonCode,
  isVerdict,
  mergeFigure,
  positionTitle,
  saveFigureEdit,
  type Position,
  type Profile,
  confirmFollowupBetween,
  setCuration,
  setFollowupVerdict,
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

/**
 * Take an event down, mark it checked, or clear the verdict.
 *
 * A takedown has to say why: the reasons are what the suggester learns from.
 * A plain form cannot require "at least one of these checkboxes", so a
 * takedown without one comes back to the page with a message rather than an
 * error page.
 */
export async function curate(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const verdict = optional(formData, "verdict");
  if (verdict !== null && !isVerdict(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  const reasons = [...new Set(formData.getAll("reason").map(String))].filter(isReasonCode);
  const note = text(formData, "note", 1000) || null;
  if (verdict === "rejected" && reasons.length === 0) {
    redirect(`/kurasi/${id}?perlu=alasan#keputusan`);
  }
  if (reasons.includes("other") && !note) {
    redirect(`/kurasi/${id}?perlu=catatan#keputusan`);
  }
  const suggested = optional(formData, "suggested");
  await setCuration(
    id,
    verdict,
    verdict === "rejected" ? reasons : [],
    note,
    suggested !== null && isReasonCode(suggested) ? suggested : null
  );
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

/** Confirm, reject or withdraw a follow-up pair already listed. */
export async function ruleFollowup(formData: FormData): Promise<void> {
  const earlier = eventId(formData, "earlier_id");
  const later = eventId(formData, "later_id");
  const verdict = optional(formData, "verdict");
  if (verdict !== null && !isLinkVerdict(verdict)) {
    throw new Error(`invalid follow-up verdict: ${verdict}`);
  }
  await setFollowupVerdict(earlier, later, verdict);
  done(earlier);
  done(later);
}

/** Chain a suggested or searched-for event to this one; the dates decide which came first. */
export async function addFollowup(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const other = eventId(formData, "other_id");
  await confirmFollowupBetween(id, other);
  done(id);
  done(other);
}

/** Correct a figure's display name, office and alias list. */
export async function editFigure(formData: FormData): Promise<void> {
  const figureId = text(formData, "figure_id", 120);
  const name = text(formData, "name", 120);
  if (!figureId || !name) throw new Error("figure_id and name are required");

  // Offices arrive as parallel columns, one row per office; a row left blank
  // is dropped, which is how one is deleted. The first is the main one, and
  // the one-line title everywhere else on the site is taken from it.
  const column = (field: string, max = 300) => formData.getAll(field).map((v) => String(v).trim().slice(0, max));
  const roles = column("pos_role");
  const orgs = column("pos_org");
  const periods = column("pos_period");
  const positions: Position[] = roles
    .map((role, i) => ({ role, org: orgs[i] ?? "", period: periods[i] ?? "" }))
    .filter((p) => p.role || p.org);
  if (positions.length > 20) throw new Error("too many positions");
  const role = positions.length > 0 ? positionTitle(positions[0]) : null;

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
  // The rest of the CV is only on the record owner's form; elsewhere it is
  // left as it is.
  let profile: Profile | null = null;
  if (formData.get("has_cv") === "1") {
    const factLabels = column("fact_label");
    const factValues = column("fact_value");
    const eduYears = column("edu_year");
    const eduDetails = column("edu_detail");
    const srcLabels = column("src_label");
    const srcUrls = column("src_url", 1000);
    const bio = text(formData, "bio", 2000);
    profile = {
      bio,
      facts: factLabels
        .map((label, i) => ({ label, value: factValues[i] ?? "" }))
        .filter((f) => f.label && f.value),
      education: eduDetails
        .map((detail, i) => (eduYears[i] ? { year: eduYears[i], detail } : { detail }))
        .filter((e) => e.detail),
      sources: srcUrls
        .map((url, i) => ({ label: srcLabels[i] || url, url }))
        .filter((s) => /^https?:\/\//.test(s.url)),
    };
  }

  await saveFigureEdit(figureId, name, role, aliases, formData.get("active") === "1", positions, profile);
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
