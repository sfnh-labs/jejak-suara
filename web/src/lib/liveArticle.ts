import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * An article read off its own site at the moment a curator opens it.
 *
 * The fallback for /kurasi's reading pane when the pipeline holds no text yet
 * (its fetch queue runs behind the RSS intake) or only a paywall's stub.
 * Nothing is stored: the pipeline stays the one writer of article bodies.
 * Readability is the extractor behind Firefox's reader view, so the result is
 * the story itself, with its photos, and not the page's menus and ads.
 */
export type LiveBlock =
  | { kind: "p" | "h" | "quote"; text: string }
  | { kind: "img"; src: string; caption: string };

export interface LiveArticle {
  blocks: LiveBlock[];
  /** Characters of text, to compare against what is stored. */
  length: number;
}

const TIMEOUT_MS = 10_000;

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export async function fetchLiveArticle(url: string): Promise<LiveArticle | null> {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return null;
  }
  if (page.protocol !== "https:" && page.protocol !== "http:") return null;

  let html: string;
  try {
    const res = await fetch(page, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; JejakSuara-Kurasi/1.0)",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "id,en;q=0.8",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A day is plenty: a curator reopening the same article should not
      // knock on the outlet's door again.
      next: { revalidate: 86_400 },
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const { document } = parseHTML(html);
  // The main photo usually sits above the story, outside what Readability
  // keeps; every outlet names it for link previews. Read before parsing,
  // which takes the document apart.
  const lead = document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? "";
  const parsed = new Readability(document as unknown as Document).parse();
  if (!parsed?.content) return null;

  const { document: body } = parseHTML(`<!doctype html><html><body>${parsed.content}</body></html>`);
  const blocks: LiveBlock[] = [];
  const seenImages = new Set<string>();
  for (const el of body.querySelectorAll("p, h2, h3, h4, blockquote, li, img")) {
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const raw = el.getAttribute("data-src") || el.getAttribute("src") || "";
      if (!raw || raw.startsWith("data:")) continue;
      let src: string;
      try {
        src = new URL(raw, page).toString();
      } catch {
        continue;
      }
      if (seenImages.has(src)) continue;
      seenImages.add(src);
      const figure = el.closest("figure");
      blocks.push({ kind: "img", src, caption: clean(figure?.querySelector("figcaption")?.textContent || el.getAttribute("alt")) });
      continue;
    }
    // A paragraph inside a quote or list item is reached through its parent.
    if (tag === "p" && el.parentElement?.closest("blockquote, li")) continue;
    const text = clean(el.textContent);
    if (!text) continue;
    blocks.push({ kind: tag === "blockquote" ? "quote" : tag.startsWith("h") ? "h" : "p", text });
  }
  if (lead && !blocks.some((b) => b.kind === "img")) {
    try {
      blocks.unshift({ kind: "img", src: new URL(lead, page).toString(), caption: "" });
    } catch {
      // A malformed preview image is only a missing photo.
    }
  }
  const length = blocks.reduce((n, b) => n + (b.kind === "img" ? 0 : b.text.length), 0);
  return blocks.length ? { blocks, length } : null;
}
