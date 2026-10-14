import OutletTile from "./OutletTile";
import { formatDateShort } from "@/lib/design";
import type { EventRecord } from "@/lib/types";

type Source = EventRecord["sources"][number];

/**
 * The articles behind an entry, one compact row each: outlet mark and headline
 * on the left, date on the right. A row opens the article in a new tab; there
 * is no "Buka" label, the hover state is what says the row is a link.
 */
export default function SourceList({ sources, large = false }: { sources: Source[]; large?: boolean }) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {sources.map((s, i) => (
        <li key={s.url} style={{ borderTop: i ? "1px solid #e4dcc9" : "none" }}>
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="source-row">
            {/* The tile's own negative margin is for overlapping stacks. */}
            <span style={{ flex: "none", display: "flex", paddingLeft: 5 }}>
              <OutletTile source={s.source} size={large ? 24 : 20} ring="var(--color-cream)" />
            </span>
            <span
              className="source-row-title"
              style={{ flex: 1, minWidth: 0, fontSize: large ? 14.5 : 13, fontWeight: 600, lineHeight: 1.35 }}
            >
              <span className="sr-only">{s.source}: </span>
              {s.title}
              <span className="sr-only"> (membuka tab baru)</span>
            </span>
            <span style={{ flex: "none", fontSize: large ? 12 : 11.5, color: "var(--color-stone)", whiteSpace: "nowrap" }}>
              {formatDateShort(s.published_at)}
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}

/**
 * "Tampilkan sumber" with the outlets' marks beside it, opening into the
 * full-width list. The marks sit in the toggle so they read as a preview of
 * what it opens rather than as a separate, unclickable strip. The label swaps
 * to "Sembunyikan sumber" in CSS, off the element's own open state.
 */
export function SourcesDisclosure({ sources }: { sources: Source[] }) {
  return (
    <details style={{ position: "relative", zIndex: 2 }}>
      <summary
        className="sources-toggle"
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: 11.5,
          fontWeight: 700,
          color: "var(--color-clay)",
          padding: "3px 0",
        }}
      >
        <span className="when-closed">Tampilkan sumber</span>
        <span className="when-open">Sembunyikan sumber</span>
        <span aria-hidden style={{ display: "flex", alignItems: "center", marginLeft: 15 }}>
          {sources.slice(0, 5).map((s) => (
            <OutletTile key={s.url} source={s.source} size={20} />
          ))}
        </span>
      </summary>
      <div style={{ marginTop: 8 }}>
        <SourceList sources={sources} />
      </div>
    </details>
  );
}

/** Room the corner toggle takes, so the header row can keep clear of it. */
export function sourcesCornerWidth(count: number): number {
  const marks = Math.min(count, 5);
  return marks ? 15 * marks + 5 + 6 + 14 : 0;
}

/**
 * The same disclosure, compact: only the outlets' marks and a chevron, pinned
 * to the card's top-right corner (the card must be positioned). Open, the
 * chevron turns into a close mark and the list opens in flow wherever this
 * element sits, so the corner stays light and the list keeps its full width.
 */
export function SourcesCorner({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <details className="sources-corner">
      <summary
        className="sources-toggle"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 24,
          color: "var(--color-stone)",
        }}
      >
        <span className="sr-only when-closed">Tampilkan {sources.length} sumber</span>
        <span className="sr-only when-open">Sembunyikan sumber</span>
        <span aria-hidden style={{ display: "flex", alignItems: "center", paddingLeft: 5 }}>
          {sources.slice(0, 5).map((s) => (
            <OutletTile key={s.url} source={s.source} size={20} />
          ))}
        </span>
        <svg aria-hidden className="when-closed" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5.5 7 9.5l4-4" />
        </svg>
        <svg aria-hidden className="when-open" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
        </svg>
      </summary>
      <div style={{ marginBottom: 16 }}>
        <SourceList sources={sources} />
      </div>
    </details>
  );
}
