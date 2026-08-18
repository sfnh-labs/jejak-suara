"use server";

import { revalidatePath } from "next/cache";
import { isVerdict, setCuration } from "@/lib/curation";

/**
 * Apply a curator verdict.
 *
 * Server action rather than a route handler so the page works with plain
 * <form> posts and needs no client JavaScript — which also means it keeps
 * working under the Cloudflare Access login redirect, where a fetch() from an
 * expired session would return the login HTML instead of a result.
 *
 * Access authorises the request before it reaches the Worker (see
 * middleware.ts); this only validates the payload.
 */
export async function curate(formData: FormData): Promise<void> {
  const eventId = Number(formData.get("event_id"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error("invalid event_id");
  }

  const raw = formData.get("verdict");
  // "" is the clear-verdict case: back to untouched, i.e. live and unreviewed.
  const verdict = raw === "" || raw === null ? null : raw;
  if (verdict !== null && !isVerdict(verdict)) {
    throw new Error(`invalid verdict: ${String(verdict)}`);
  }

  await setCuration(eventId, verdict);

  // The public pages are force-dynamic, so they pick the change up on their
  // own; this is for the queue itself, which must not show a stale verdict.
  revalidatePath("/kurasi");
}
