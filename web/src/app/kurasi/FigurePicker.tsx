"use client";

import { useEffect, useId, useRef, useState } from "react";
import { setQuoteSpeaker } from "./actions";
import { MUTED, RULE, SURFACE, button, input } from "./ui";

type Choice = { id: string; name: string; role: string; aliases: string[] };

/**
 * The roster is already on the page once, as the <datalist> the merge fields
 * use (FigureOptions); reading it from there keeps 200-odd figures out of
 * every picker's props.
 */
function roster(listId: string): Choice[] {
  const list = document.getElementById(listId);
  if (!list) return [];
  return [...list.querySelectorAll("option")].map((o) => ({
    id: o.value,
    name: o.dataset.name ?? o.value,
    role: o.dataset.role ?? "",
    aliases: (o.dataset.aliases ?? "").split("|").filter(Boolean),
  }));
}

function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Every word typed has to appear in the name, an alias, the office or the id. */
function search(all: Choice[], q: string, limit = 12): Choice[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return all.slice(0, limit);
  const hits: { c: Choice; score: number }[] = [];
  for (const c of all) {
    const name = fold(c.name);
    const hay = `${name} ${fold(c.aliases.join(" "))} ${fold(c.role)} ${c.id}`;
    if (!words.every((w) => hay.includes(w))) continue;
    // Names that start with what was typed come first, then any name match,
    // then matches only in the office.
    const score = name.startsWith(words[0]) ? 0 : words.every((w) => name.includes(w)) ? 1 : 2;
    hits.push({ c, score });
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit).map((h) => h.c);
}

/**
 * Search the roster by name, alias or office and pick one figure; the form
 * submits its id as `name`. Each row shows the figure's title, so two people
 * with the same name are told apart.
 */
export function FigurePicker({
  listId,
  name = "figure_id",
  defaultId,
  defaultLabel,
  required = false,
  autoFocus = false,
  placeholder = "Cari tokoh: nama, alias, atau jabatan",
}: {
  listId: string;
  name?: string;
  defaultId?: string | null;
  /** "Name · title" of the default, so it reads right before any script runs. */
  defaultLabel?: string | null;
  required?: boolean;
  /** Open on the search box, for a picker shown on demand. */
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [all, setAll] = useState<Choice[] | null>(null);
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(
    defaultId ? { id: defaultId, label: defaultLabel ?? defaultId } : null
  );
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  const choices = all ? search(all, q) : [];
  const load = () => {
    if (!all) setAll(roster(listId));
  };
  const choose = (c: Choice) => {
    setPicked({ id: c.id, label: c.role ? `${c.name} · ${c.role}` : c.name });
    setQ("");
    setOpen(false);
  };

  if (picked) {
    return (
      <div style={{ ...input, display: "flex", alignItems: "center", gap: 8, flex: "1 1 220px" }}>
        <input type="hidden" name={name} value={picked.id} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={picked.id}>
          {picked.label}
        </span>
        <button
          type="button"
          onClick={() => {
            setPicked(null);
            requestAnimationFrame(() => box.current?.focus());
          }}
          aria-label="Ganti tokoh"
          style={{ border: "none", background: "none", color: MUTED, cursor: "pointer", fontSize: 12.5, padding: 0 }}
        >
          Ganti
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", flex: "1 1 220px", display: "grid" }}>
      {/* Empty until a figure is picked; `required` then stops the submit. */}
      <input type="hidden" name={name} value="" />
      <input
        ref={box}
        value={q}
        required={required}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Tokoh yang berbicara"
        autoComplete="off"
        placeholder={placeholder}
        onFocus={() => {
          load();
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          load();
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, choices.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && open && choices[active]) {
            e.preventDefault();
            choose(choices[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        style={input}
      />
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 20,
            margin: "2px 0 0",
            padding: 0,
            listStyle: "none",
            background: SURFACE,
            border: `1px solid ${RULE}`,
            borderRadius: 3,
            boxShadow: "0 6px 18px rgba(0,0,0,0.08)",
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {choices.length === 0 ? (
            <li style={{ padding: "8px 10px", fontSize: 12.5, color: MUTED }}>Tidak ada tokoh yang cocok.</li>
          ) : (
            choices.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
                onMouseEnter={() => setActive(i)}
                style={{
                  padding: "7px 10px",
                  cursor: "pointer",
                  borderTop: i === 0 ? "none" : `1px solid ${RULE}`,
                  background: i === active ? "var(--color-parchment)" : "transparent",
                }}
              >
                <div style={{ fontSize: 13 }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: MUTED }}>
                  {c.role || "tanpa jabatan"} · {c.id}
                </div>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * "Ganti tokoh" and "Bukan tokoh" for a listed quote. The current figure is
 * already on the row, so the search only opens when asked for.
 */
export function SpeakerEditor({ quoteId, listId, canClear }: { quoteId: number; listId: string; canClear: boolean }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <form action={setQuoteSpeaker} style={{ display: "flex", gap: 6 }}>
        <input type="hidden" name="quote_id" value={quoteId} />
        <button type="button" onClick={() => setEditing(true)} style={button("quiet")}>Ganti tokoh</button>
        {canClear ? (
          <button type="submit" name="op" value="clear" style={button("quiet")}>Bukan tokoh</button>
        ) : null}
      </form>
    );
  }
  return (
    <form
      action={setQuoteSpeaker}
      onKeyDown={(e) => {
        if (e.key === "Escape") setEditing(false);
      }}
      style={{ display: "flex", gap: 6, alignItems: "center", flex: "1 1 100%" }}
    >
      <input type="hidden" name="quote_id" value={quoteId} />
      <FigurePicker listId={listId} required autoFocus placeholder="Cari tokoh yang berbicara: nama, alias, atau jabatan" />
      <button type="submit" name="op" value="assign" style={button("ink")}>Simpan</button>
      <button type="button" onClick={() => setEditing(false)} style={button("quiet")}>Batal</button>
    </form>
  );
}
