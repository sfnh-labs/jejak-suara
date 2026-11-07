"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  canonicalOrg,
  getOrgChoices,
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
  setActor,
  requestRework,
  removeNotAPerson,
  setLessonActive,
  saveOrganization,
  deleteOrganization,
  acceptRework,
  discardRework,
  assignQuote,
  addQuote,
  showQuote,
} from "@/lib/curation";
import { answerPoint, isPointAnswer, salahPoint, setAutoKind, undoPoint, KIND_LABEL, NOT_TRACKED, type PointKind } from "@/lib/curationPoints";
import { pipelineOp } from "@/lib/localDb";

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

function done(id: number | null) {
  // The public pages are force-dynamic and pick changes up on their own; this
  // keeps the queue and the item from showing a stale decision.
  revalidatePath("/kurasi", "layout");
  if (id) revalidatePath(`/kurasi/${id}`);
}

/** The record a figure form was sent from; none from the Tokoh pages. */
function fromEvent(formData: FormData): number | null {
  return formData.get("event_id") ? eventId(formData) : null;
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
  // An organisation typed the way another office already spells it ("kpk",
  // "Partai golkar") is stored as that spelling, so one body is never two.
  const known = await getOrgChoices();
  const positions: Position[] = roles
    .map((role, i) => ({ role, org: canonicalOrg(orgs[i] ?? "", known), period: periods[i] ?? "" }))
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
    profile = {
      // Not curated: a figure is read from their records and current office,
      // so the stored bio is left as it is.
      bio: null,
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
  done(fromEvent(formData));
}

/** Strike a related figure from a peristiwa, or restore one. */
export async function relateFigure(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const figureId = text(formData, "figure_id", 120);
  if (!figureId) throw new Error("missing figure_id");
  await setRelatedFigure(id, figureId, formData.get("struck") === "1");
  done(id);
}

/** Add a Pelaku to a record ("on"), or move one back to Disebut. */
export async function setRecordActor(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const figureId = text(formData, "figure_id", 120).toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(figureId)) throw new Error("choose a figure");
  await setActor(id, figureId, formData.get("on") === "1");
  done(id);
}

/** Fold a duplicate figure into the one it duplicates. Not undoable here. */
export async function mergeFigures(formData: FormData): Promise<void> {
  const fromId = text(formData, "figure_id", 120);
  const intoId = text(formData, "into_id", 120);
  if (!fromId || !intoId) throw new Error("figure_id and into_id are required");
  // The checkbox is the confirmation: a plain form has no dialog to ask with.
  if (formData.get("confirm") !== "1") throw new Error("merge not confirmed");
  // The buttons say which way: "into" folds this figure into the other,
  // "here" folds the other into this one.
  if (formData.get("direction") === "here") await mergeFigure(intoId, fromId);
  else await mergeFigure(fromId, intoId);
  done(fromEvent(formData));
}

/**
 * Ask for the event to be written again. Records only: another figure, the
 * "about" framing and making it a peristiwa. Any event: a note.
 */
export async function rework(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const note = text(formData, "note", 2000) || null;
  const rawFraming = optional(formData, "framing");
  const framing = rawFraming === "own" || rawFraming === "about" ? rawFraming : null;
  const figure = text(formData, "new_figure_id", 120).toLowerCase() || null;
  if (figure && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(figure)) throw new Error("invalid figure");
  await requestRework(id, { note, framing, newFigureId: figure, toPeristiwa: formData.get("to_peristiwa") === "1" });
  done(id);
}

export async function decideRework(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const requestId = eventId(formData, "request_id");
  if (formData.get("decision") === "accept") await acceptRework(requestId);
  else await discardRework(requestId);
  done(id);
}

/** "Bukan orang": retire a figure that is a place, an office or a fragment. */
export async function notAPerson(formData: FormData): Promise<void> {
  const figureId = text(formData, "figure_id", 120);
  if (!figureId) throw new Error("figure_id is required");
  if (formData.get("confirm") !== "1") throw new Error("not confirmed");
  await removeNotAPerson(figureId);
  done(fromEvent(formData));
}

export async function toggleLesson(formData: FormData): Promise<void> {
  const id = eventId(formData, "lesson_id");
  await setLessonActive(id, formData.get("active") === "1");
  revalidatePath("/kurasi/pelajaran");
}

/** Adds or renames an organisation; "delete" removes it. */
export async function editOrganization(formData: FormData): Promise<void> {
  const raw = formData.get("org_id");
  const id = raw ? eventId(formData, "org_id") : null;
  if (formData.get("op") === "delete") {
    if (id === null) throw new Error("org_id is required");
    await deleteOrganization(id);
  } else {
    await saveOrganization(
      id, text(formData, "name", 200), text(formData, "short_name", 60) || null,
      text(formData, "aliases", 1000).split(";"), text(formData, "kind", 30) || null
    );
  }
  revalidatePath("/kurasi", "layout");
}

/** Whose words a quote is ("clear": no tracked figure). */
export async function setQuoteSpeaker(formData: FormData): Promise<void> {
  const quoteId = eventId(formData, "quote_id");
  let figureId: string | null = null;
  if (formData.get("op") !== "clear") {
    figureId = text(formData, "figure_id", 120).toLowerCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(figureId)) throw new Error("choose a figure");
  }
  done(await assignQuote(quoteId, figureId));
}

/** A quote the curator adds by hand; the figure is optional (unplaced). */
export async function newQuote(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const figureId = text(formData, "figure_id", 120).toLowerCase() || null;
  if (figureId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(figureId)) throw new Error("choose a figure");
  await addQuote(id, {
    quote: text(formData, "quote", 2000),
    speaker: text(formData, "speaker", 200) || null,
    figureId,
    url: optional(formData, "url"),
    show: formData.get("show") === "1",
  });
  done(id);
}

/** The quote a record shows: a quote id, "none", or "auto". */
export async function pickQuote(formData: FormData): Promise<void> {
  const id = eventId(formData);
  const choice = String(formData.get("quote_id") ?? "");
  await showQuote(id, choice === "none" ? null : choice === "auto" ? "auto" : eventId(formData, "quote_id"));
  done(id);
}

/**
 * Ya / Bukan / Koreksi / Lewati on a curation point; the answer lands on the
 * row it asks about. A peristiwa or lini point is corrected to another event
 * (`event_target`), a Pelaku point to another figure. A speaker can be corrected to a figure from the roster,
 * to "not a tracked figure" (figure_id "-"), or to a figure created right
 * here from `new_name` — through the pipeline's own promote, as the names
 * queue does.
 */
export async function answerCurationPoint(formData: FormData): Promise<void> {
  const pointId = eventId(formData, "point_id");
  const answer = String(formData.get("answer") ?? "");
  if (!isPointAnswer(answer)) throw new Error(`invalid answer: ${answer}`);
  let figure = text(formData, "figure_id", 120).toLowerCase() || null;
  const newName = text(formData, "new_name", 200);
  if (answer === "koreksi" && newName) {
    const role = text(formData, "new_role", 300);
    const org = text(formData, "new_org", 300);
    figure = (await pipelineOp("new-figure", newName, ...(role ? ["--role", role] : []), ...(org ? ["--org", org] : []))).split("\n").pop()!.trim();
  }
  // A peristiwa or lini point corrected to another event names it by id.
  const event = text(formData, "event_target", 20);
  if (answer === "koreksi" && event) {
    if (!/^[1-9][0-9]*$/.test(event)) throw new Error("choose an event");
    done(await answerPoint(pointId, answer, event));
    return;
  }
  if (figure && figure !== NOT_TRACKED && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(figure)) throw new Error("choose a figure");
  done(await answerPoint(pointId, answer, figure));
}

/** Open the catatan's automatic decisions as points, to check them (open_checks). */
export async function openDecisionPoints(formData: FormData): Promise<void> {
  const id = eventId(formData);
  await pipelineOp("open-checks", String(id));
  done(id);
}

/** "Batalkan": put the record back as it was before the answer, and ask again. */
export async function undoCurationPoint(formData: FormData): Promise<void> {
  done(await undoPoint(eventId(formData, "point_id")));
}

/** "Salah" on an auto answer: put it back, rule the other way, and count it against auto. */
export async function markCurationPointWrong(formData: FormData): Promise<void> {
  done(await salahPoint(eventId(formData, "point_id")));
}

/** Switch auto-answering for one kind of point on or off. */
export async function toggleAutoKind(formData: FormData): Promise<void> {
  const kind = String(formData.get("kind") ?? "");
  if (!(kind in KIND_LABEL)) throw new Error(`invalid kind: ${kind}`);
  await setAutoKind(kind as PointKind, formData.get("on") === "1");
  revalidatePath("/kurasi", "layout");
}
