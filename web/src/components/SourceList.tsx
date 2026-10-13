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
              <OutletTile source={s.source} size={large ? 24 : 20} ring="#f6f2e9" />
            </span>
            <span
              className="source-row-title"
              style={{ flex: 1, minWidth: 0, fontSize: large ? 14.5 : 13, fontWeight: 600, lineHeight: 1.35 }}
            >
              <span className="sr-only">{s.source}: </span>
              {s.title}
              <span className="sr-only"> (membuka tab baru)</span>
            </span>
            <span style={{ flex: "none", fontSize: large ? 12 : 11.5, color: "#7a7264", whiteSpace: "nowrap" }}>
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
          color: "#8b2e1f",
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
