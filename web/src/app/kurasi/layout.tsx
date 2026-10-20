import { notFound } from "next/navigation";
import { isCurationHost } from "@/lib/localDb";

/**
 * /kurasi exists only where jejak.db is: the curator's machine, with JEJAK_DB
 * set. The deployed site has no curation pages at all.
 */
export default function KurasiLayout({ children }: { children: React.ReactNode }) {
  if (!isCurationHost()) notFound();
  return children;
}
