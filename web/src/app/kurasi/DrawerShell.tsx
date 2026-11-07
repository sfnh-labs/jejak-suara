"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Makes a drawer close the moment it is asked to. The drawer is a URL
 * parameter and its ✕ and backdrop are plain links, so closing waits for the
 * page to render again on the server (a couple of seconds on a busy record),
 * with nothing on screen saying the click took. Here a click on any link
 * back to `closeHref`, or Esc, hides the drawer at once while that
 * navigation runs. Without script the links still close it, only slower.
 */
export function DrawerShell({ closeHref, children }: { closeHref: string; children: React.ReactNode }) {
  const router = useRouter();
  const here = useSearchParams().toString();
  // Hidden from the click until the address changes: once the page without
  // the drawer arrives, the next drawer opened (even this one again) shows,
  // though this component stays mounted across them.
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [seen, setSeen] = useState(here);
  if (seen !== here) {
    setSeen(here);
    setClosedAt(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setClosedAt(here);
      router.replace(closeHref, { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeHref, here, router]);

  if (closedAt === here) return null;
  return (
    <div
      onClickCapture={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a && a.getAttribute("href") === closeHref && !e.metaKey && !e.ctrlKey && !e.shiftKey) setClosedAt(here);
      }}
    >
      {children}
    </div>
  );
}
