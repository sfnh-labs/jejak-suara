"use server";

import { revalidatePath } from "next/cache";
import { isCandidateVerdict, setCandidateVerdict } from "@/lib/candidates";

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

  const fullName = String(formData.get("full_name") ?? "").trim();
  const aliases = String(formData.get("aliases") ?? "").trim();

  await setCandidateVerdict(slug, verdict, fullName, aliases);
  revalidatePath("/kurasi/kandidat");
}
