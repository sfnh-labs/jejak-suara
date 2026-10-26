"use client";

import { useEffect } from "react";

/**
 * Brings the reader's focused paragraph into view when it arrives. The page
 * renders the article twice (beside the list when wide, under its line when
 * narrow), so it scrolls to whichever copy is showing. Without script the
 * paragraph is still marked; only the scrolling is lost.
 */
export function FocusScroll({ token }: { token: string }) {
  useEffect(() => {
    const shown = [...document.querySelectorAll<HTMLElement>("[data-reader-focus]")].find((el) => el.offsetParent !== null);
    shown?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [token]);
  return null;
}
